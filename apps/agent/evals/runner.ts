/**
 * runner.ts -- Eval runner for the xchat agent.
 *
 * Uses the real tool handlers via makeToolkitLayer with mock executor layers.
 * No more mock toolkit — same handler code runs in evals and production.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve as resolvePath } from "node:path";
import { Effect, Exit, Layer, Ref, Schema, Scope } from "effect";
import { Chat, Prompt } from "effect/unstable/ai";
import { FetchHttpClient } from "effect/unstable/http";
import { Persistence } from "effect/unstable/persistence";

import {
  type BrainApi,
  type PendingMedia,
  buildPersona,
  makeAlarms,
  makeBrain,
  run,
  soulSeed,
} from "@x-chat/drone-core";
import { XaiConfig } from "../src/XaiConfig.js";
import * as XaiLanguageModel from "../src/XaiLanguageModel.js";
import {
  parseDigestPeople,
  resolveToolkits,
  resolveUserRole,
} from "../src/adapters/xchat.js";
import { discoverSkills } from "../src/skills.js";
import { buildMechanics, buildSystemPrompt } from "../src/system-prompt.js";
import {
  ChatExecutor,
  QuoteExecutor,
  ShellExecutor,
  XaiMediaExecutor,
} from "../src/tools/executors/index.js";
import { AgentToolkit, makeToolkitLayer } from "../src/tools/xchat-tools.js";

import type {
  AssertionResult,
  EvalCase,
  EvalResult,
  EvalSuiteResult,
  JudgeResult,
  ToolCall,
} from "./types.js";

// ── Collect media from eval case for passing to the judge ──

const collectMedia = (
  evalCase: EvalCase,
): Array<{ bytes: Uint8Array; mimeType: string }> => {
  if (!evalCase.mockMedia) return [];
  const media: Array<{ bytes: Uint8Array; mimeType: string }> = [];
  for (const entry of Object.values(evalCase.mockMedia)) {
    if (entry.type === "image" || entry.type === "video") {
      media.push({ bytes: entry.bytes, mimeType: entry.mimeType });
    }
  }
  return media;
};

// ── Materialize referenced source media ──

// A 1x1 PNG. Content is irrelevant (the mock executor ignores the request
// body) — what matters is that the FILE EXISTS, because generate_image /
// generate_video reject a source_image_url / source_video_url whose file isn't
// on disk (the existsSync guard in resolveImageUrl/resolveVideoUrl).
const PLACEHOLDER_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/AP4AAAAAElFTkSuQmCC",
  "base64",
);

const MEDIA_PATH_RE = /\/tmp\/xchat-agent\/[\w.-]+\.(?:png|jpe?g|mp4|m4a|webp|gif)/gi;

/**
 * Create any /tmp/xchat-agent media file the case references in its history or
 * incoming message. In production such a path is a real file the agent's own
 * tools (generate_image / view_media) wrote earlier in the session; the
 * generate handlers existsSync-guard the source path, so without the file an
 * image-edit / image-to-video case fails on a missing source that would always
 * be present in prod.
 */
const ensureReferencedMediaFiles = (evalCase: EvalCase): void => {
  const texts = [evalCase.incomingMessage, ...evalCase.history.map((h) => h.text)];
  const paths = new Set<string>();
  for (const t of texts) {
    for (const match of t.matchAll(MEDIA_PATH_RE)) paths.add(match[0]);
  }
  if (paths.size === 0) return;
  mkdirSync("/tmp/xchat-agent", { recursive: true });
  for (const p of paths) {
    if (!existsSync(p)) writeFileSync(p, PLACEHOLDER_BYTES);
  }
};

// ── LLM layers ──

// Layers are built lazily — run.ts must load .env before importing these,
// and ES module evaluation order means top-level consts would capture
// empty env vars. Wrapping in a function defers env reads to call time.
const makeModelLayer = () => {
  const skills = discoverSkills();
  // Evals pin behavior against the SEED soul (prod runs the live soul — drift
  // beyond the seed is the owner-review loop's job, via brain repo history).
  const systemPrompt = buildSystemPrompt(
    skills,
    soulSeed({ botName: "zw_bot", ownerName: "Zach" }),
  );
  return XaiLanguageModel.layer({
    instructions: systemPrompt,
    store: false,
  }).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(XaiConfig.layer));
};

// ── History injection ──

const injectHistory = (history: EvalCase["history"], session: Chat.Service) =>
  Effect.gen(function* () {
    if (history.length === 0) return;

    const promptMessages = history.map((turn) =>
      Prompt.makeMessage(turn.role, {
        content: [Prompt.makePart("text", { text: turn.text })],
      }),
    );

    yield* Ref.update(session.history, (current) =>
      Prompt.concat(current, Prompt.fromMessages(promptMessages)),
    );
  });

// ── Assertion checking ──

/** Post-turn brain state for capture assertions. */
interface BrainOutcome {
  /** Concatenated content of files the turn created or changed (the capture). */
  readonly captured: string;
  /** Concatenated content of every brain file post-turn. */
  readonly full: string;
  /** Number of files created or changed by the turn. */
  readonly writes: number;
}

/** All brain files (relative path → content), .git excluded. */
const readBrainFiles = (root: string): Map<string, string> => {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.set(relative(root, path), readFileSync(path, "utf-8"));
    }
  };
  walk(root);
  return out;
};

const runAssertions = (
  evalCase: EvalCase,
  messages: string[],
  toolCalls: ToolCall[],
  brainOutcome?: BrainOutcome,
): AssertionResult[] => {
  const results: AssertionResult[] = [];
  const expect = evalCase.expect;
  if (!expect) return results;

  if (expect.brainContains || expect.brainNotContains || expect.noBrainWrites) {
    if (!brainOutcome) {
      results.push({
        assertion: "Brain assertions require brainEnabled",
        passed: false,
        detail: "Case has brain expectations but no brain was constructed",
      });
    } else {
      const captured = brainOutcome.captured.toLowerCase();
      for (const needle of expect.brainContains ?? []) {
        // "a|b" = any alternative satisfies (formats legitimately vary:
        // "june 25" vs "2026-06-25", "wednesday" vs "wed").
        const passed = needle
          .split("|")
          .some((alt) => captured.includes(alt.toLowerCase()));
        results.push({
          assertion: `Brain capture should contain "${needle}"`,
          passed,
          detail: passed
            ? undefined
            : `Not found in the ${brainOutcome.writes} file(s) the turn wrote. Captured: ${brainOutcome.captured.slice(0, 400) || "(nothing)"}`,
        });
      }
      const full = brainOutcome.full.toLowerCase();
      for (const needle of expect.brainNotContains ?? []) {
        const passed = !full.includes(needle.toLowerCase());
        results.push({
          assertion: `Brain should NOT contain "${needle}"`,
          passed,
          detail: passed ? undefined : "Found in post-turn brain content",
        });
      }
      if (expect.noBrainWrites) {
        results.push({
          assertion: "Turn should not write to the brain",
          passed: brainOutcome.writes === 0,
          detail:
            brainOutcome.writes === 0
              ? undefined
              : `${brainOutcome.writes} file(s) written: ${brainOutcome.captured.slice(0, 300)}`,
        });
      }
    }
  }

  if (expect.toolCalls) {
    for (const expectedCall of expect.toolCalls) {
      const found = toolCalls.find((tc) => tc.name === expectedCall.name);
      if (!found) {
        results.push({
          assertion: `Tool "${expectedCall.name}" should be called`,
          passed: false,
          detail: `Tool "${expectedCall.name}" was not called. Called tools: ${toolCalls.map((tc) => tc.name).join(", ") || "none"}`,
        });
        continue;
      }

      if (expectedCall.args) {
        for (const [key, value] of Object.entries(expectedCall.args)) {
          const actual = found.args[key];
          const match = JSON.stringify(actual) === JSON.stringify(value);
          results.push({
            assertion: `Tool "${expectedCall.name}" arg "${key}" = ${JSON.stringify(value)}`,
            passed: match,
            detail: match
              ? undefined
              : `Expected ${JSON.stringify(value)}, got ${JSON.stringify(actual)}`,
          });
        }
      } else {
        results.push({
          assertion: `Tool "${expectedCall.name}" should be called`,
          passed: true,
        });
      }
    }
  }

  if (expect.noToolCalls) {
    const passed = toolCalls.length === 0;
    results.push({
      assertion: "No tools should be called",
      passed,
      detail: passed
        ? undefined
        : `Expected no tool calls, but got: ${toolCalls.map((tc) => tc.name).join(", ")}`,
    });
  }

  const fullResponse = messages.join("\n").toLowerCase();

  if (expect.responseContains) {
    for (const expected of expect.responseContains) {
      const passed = fullResponse.includes(expected.toLowerCase());
      results.push({
        assertion: `Response should contain "${expected}"`,
        passed,
        detail: passed
          ? undefined
          : `Response does not contain "${expected}". Full response: "${messages.join(" | ")}"`,
      });
    }
  }

  if (expect.responseNotContains) {
    for (const unexpected of expect.responseNotContains) {
      const passed = !fullResponse.includes(unexpected.toLowerCase());
      results.push({
        assertion: `Response should NOT contain "${unexpected}"`,
        passed,
        detail: passed ? undefined : `Response unexpectedly contains "${unexpected}"`,
      });
    }
  }

  if (expect.minMessages !== undefined) {
    const passed = messages.length >= expect.minMessages;
    results.push({
      assertion: `Should produce at least ${expect.minMessages} message(s)`,
      passed,
      detail: passed
        ? undefined
        : `Got ${messages.length} message(s), expected at least ${expect.minMessages}`,
    });
  }

  if (expect.maxMessages !== undefined) {
    const passed = messages.length <= expect.maxMessages;
    results.push({
      assertion: `Should produce at most ${expect.maxMessages} message(s)`,
      passed,
      detail: passed
        ? undefined
        : `Got ${messages.length} message(s), expected at most ${expect.maxMessages}`,
    });
  }

  return results;
};

// ── LLM-as-judge ──

const JudgeResponse = Schema.Struct({
  score: Schema.Number,
  reasoning: Schema.String,
});

const stripCodeFences = (text: string): string => {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const lines = trimmed.split("\n");
  lines.shift();
  if (lines[lines.length - 1]?.trim() === "```") {
    lines.pop();
  }
  return lines.join("\n").trim();
};

const parseJudgeResponse = (text: string) =>
  Effect.try({
    try: () => JSON.parse(stripCodeFences(text)),
    catch: (e) => new Error(`Invalid JSON: ${e}`),
  }).pipe(Effect.flatMap((json) => Schema.decodeUnknownEffect(JudgeResponse)(json)));

const runJudge = (
  evalCase: EvalCase,
  messages: string[],
  toolCalls: ToolCall[],
  criteria: string[],
) =>
  Effect.gen(function* () {
    const results: JudgeResult[] = [];
    const session = yield* Chat.empty;
    const media = collectMedia(evalCase);

    for (const criterion of criteria) {
      const toolCallsSection =
        toolCalls.length > 0
          ? [
              "",
              "## Tool Calls Made",
              ...toolCalls.map((tc) => `- ${tc.name}(${JSON.stringify(tc.args)})`),
            ]
          : ["", "## Tool Calls Made", "None"];

      const mediaSection =
        media.length > 0
          ? ["", `## Media (${media.length} file(s) the agent saw — shown below)`]
          : [];

      const promptText = [
        "You are an eval judge for a chat agent. Score the agent's response on a scale of 1-5.",
        "Consider the full agent behavior: tool calls made, response quality, and appropriateness.",
        "If media files are attached below, the agent saw the same media. Verify the agent's description is accurate.",
        "",
        "## Conversation History",
        ...evalCase.history.map((h) => `${h.role}: ${h.text}`),
        "",
        "## Incoming Message",
        evalCase.incomingMessage,
        ...toolCallsSection,
        ...mediaSection,
        "",
        "## Agent Response",
        messages.join("\n"),
        "",
        "## Criterion",
        criterion,
        "",
        "Respond with ONLY valid JSON in this exact format (no markdown, no code fences):",
        '{"score": <1-5>, "reasoning": "<brief explanation>"}',
      ].join("\n");

      // Build prompt: text + any media files the agent saw
      const fileParts = media.map((m) =>
        Prompt.makePart("file", { mediaType: m.mimeType, data: m.bytes }),
      );
      const textPart = Prompt.makePart("text", { text: promptText });

      const prompt = Prompt.fromMessages([
        Prompt.makeMessage("user", { content: [...fileParts, textPart] }),
      ]);

      const response = yield* session
        .generateText({ prompt })
        .pipe(
          Effect.catch(() =>
            Effect.succeed({ text: '{"score": 0, "reasoning": "Judge call failed"}' }),
          ),
        );

      const parsed = yield* parseJudgeResponse(response.text).pipe(
        Effect.catch(() =>
          Effect.succeed({
            score: 0,
            reasoning: `Failed to parse judge response: ${response.text}`,
          }),
        ),
      );

      results.push({ criterion, ...parsed });
    }

    return results;
  });

// ── Main eval runner ──

export const runEval = (evalCase: EvalCase) =>
  Effect.gen(function* () {
    const start = Date.now();

    // Materialize any source media the case references so the generate handlers'
    // existsSync guard passes (these files always exist in prod).
    ensureReferencedMediaFiles(evalCase);

    const pendingMedia: Array<PendingMedia> = [];
    const recordedCalls: Array<ToolCall> = [];

    // Resolve permissions from eval case
    const role = evalCase.sender
      ? resolveUserRole(
          evalCase.sender.id,
          evalCase.globalAdmins ?? [],
          evalCase.conversationConfig?.admins ?? [],
        )
      : "admin";

    const enabledToolkits = evalCase.conversationConfig?.toolkits
      ? resolveToolkits(evalCase.conversationConfig.toolkits, role)
      : new Set(["xchat", "xai", "coding", "core"]);

    // Derive the "current" conversation id from the incoming message's
    // [conversation: ID] annotation so the toolkit's current-vs-cross
    // conversation logic matches what the model sees. In production
    // currentConvId IS the conversation the message arrived in, so a normal
    // reply to the current conv always has conversation_id === currentConvId.
    // Hardcoding a fixed id here would make every case look like a
    // cross-conversation send. Falls back when a case has no annotation.
    const convAnnotation = evalCase.incomingMessage.match(/\[conversation:\s*([^\],]+)/);
    // Wake mode = a clock turn: no current conversation (matches production's
    // makeWakeToolkitLayer), so the case's allowlist is the sole speak gate.
    const currentConvId = evalCase.wake
      ? undefined
      : convAnnotation?.[1]?.trim() || "eval-conv-123";

    // Mock executor layers for evals
    const executorLayers = Layer.mergeAll(
      ShellExecutor.mockLayer,
      ChatExecutor.mockLayer(evalCase.mockMedia),
      XaiMediaExecutor.mockLayer,
      QuoteExecutor.mockLayer,
    );

    // Real temp-dir brain when the case asserts on capture (brain_read/write
    // hit actual committed files; discarded after the case).
    let brain: BrainApi | undefined;
    let brainScope: Scope.Closeable | undefined;
    let preTurnFiles: Map<string, string> | undefined;
    if (evalCase.brainEnabled) {
      const brainDir = mkdtempSync(join(tmpdir(), "eval-brain-"));
      brainScope = yield* Scope.make();
      brain = yield* makeBrain({
        dir: brainDir,
        identity: { botName: "zw_bot", ownerName: "Zach" },
      }).pipe(Scope.provide(brainScope));
      for (const [path, content] of Object.entries(evalCase.brainSeed ?? {})) {
        yield* brain.write(path, content, `seed: ${path}`);
      }
      preTurnFiles = readBrainFiles(brain.root);
    }

    // Same makeToolkitLayer as production, with mock executors composed in
    const toolkitLayer = makeToolkitLayer(
      pendingMedia,
      evalCase.allowlist ?? ["*"], // permissive unless the case gates speech
      enabledToolkits,
      role,
      false,
      undefined,
      new Map(),
      currentConvId,
      evalCase.conversationConfig ?? {},
      undefined,
      undefined,
      recordedCalls,
      brain,
      // Clock tools ride the brain: real alarm service over the temp brain
      // (alarms.md is brain state), so cases can assert schedule_wake.
      brain ? makeAlarms({ brain }) : undefined,
    ).pipe(Layer.provide(executorLayers));

    const session = yield* Chat.empty;
    yield* injectHistory(evalCase.history, session);

    const runEffect = run({
      chat: session,
      input: { text: evalCase.incomingMessage },
      toolkit: AgentToolkit,
      pendingMedia,
    }).pipe(Effect.provide(toolkitLayer));

    // Ambient memory mirrors production: explicit personaMemory, or — when a
    // real brain is wired — the brain's own contextFor over the people named
    // in the incoming digest (same as executeWake's wake persona).
    let memoryContext = evalCase.personaMemory ?? "";
    if (memoryContext === "" && brain) {
      const personIds: string[] = [];
      for (const handle of parseDigestPeople(evalCase.incomingMessage)) {
        const id = yield* brain.resolvePerson("xchat", handle);
        if (id !== undefined) personIds.push(id);
      }
      memoryContext = yield* brain.contextFor(personIds, undefined);
    }
    const agentResult = yield* memoryContext !== ""
      ? XaiLanguageModel.withConfigOverride(runEffect, {
          instructions: buildPersona({
            mechanics: buildMechanics(discoverSkills()),
            soul: soulSeed({ botName: "zw_bot", ownerName: "Zach" }),
            memoryContext,
          }),
        })
      : runEffect;

    const messages = [...agentResult.messages];

    // Diff the brain against its seeded state: only what the TURN wrote
    // counts as capture (the seed soul would otherwise false-positive greps).
    let brainOutcome: BrainOutcome | undefined;
    if (brain && preTurnFiles) {
      const post = readBrainFiles(brain.root);
      const changed: string[] = [];
      for (const [path, content] of post) {
        if (preTurnFiles.get(path) !== content) changed.push(content);
      }
      brainOutcome = {
        captured: changed.join("\n\n"),
        full: [...post.values()].join("\n\n"),
        writes: changed.length,
      };
      if (brainScope) yield* Scope.close(brainScope, Exit.void);
      rmSync(resolvePath(brain.root), { recursive: true, force: true });
    }

    const assertionResults = runAssertions(
      evalCase,
      messages,
      recordedCalls,
      brainOutcome,
    );

    const judgeResults =
      evalCase.judgeCriteria && evalCase.judgeCriteria.length > 0
        ? yield* runJudge(evalCase, messages, recordedCalls, evalCase.judgeCriteria)
        : undefined;

    const assertionsPassed =
      assertionResults.length === 0 || assertionResults.every((r) => r.passed);

    const minScore = evalCase.expect?.minJudgeScore ?? 4;
    const judgePassed = !judgeResults || judgeResults.every((jr) => jr.score >= minScore);

    return {
      caseId: evalCase.id,
      passed: assertionsPassed && judgePassed,
      messages,
      toolCalls: recordedCalls,
      assertionResults,
      judgeResults,
      durationMs: Date.now() - start,
      tokenUsage: agentResult.tokenUsage,
    } satisfies EvalResult;
  });

export const runEvalSuite = (cases: EvalCase[], concurrency = 8) =>
  Effect.gen(function* () {
    const start = Date.now();

    const results = yield* Effect.all(
      cases.map((evalCase) =>
        runEval(evalCase).pipe(
          Effect.catch((error: unknown) =>
            Effect.succeed({
              caseId: evalCase.id,
              passed: false,
              messages: [],
              toolCalls: [],
              assertionResults: [
                {
                  assertion: "Eval should not throw",
                  passed: false,
                  detail: `Error: ${error}`,
                },
              ],
              durationMs: 0,
            } satisfies EvalResult),
          ),
        ),
      ),
      { concurrency },
    );

    const passedCases = results.filter((r) => r.passed).length;

    return {
      results,
      totalCases: cases.length,
      passedCases,
      failedCases: cases.length - passedCases,
      durationMs: Date.now() - start,
    } satisfies EvalSuiteResult;
  });

export const makeEvalLayers = () =>
  Layer.mergeAll(
    makeModelLayer(),
    Chat.layerPersisted({ storeId: "eval-chats" }).pipe(
      Layer.provide(Persistence.layerBackingMemory),
    ),
    XaiConfig.layer,
  );
