/**
 * run.ts — CLI entry point for the xchat agent eval system.
 *
 * Usage:
 *   bun run eval                                 # run all cases
 *   bun run evals/run.ts                         # run all cases
 *   bun run evals/run.ts --case basic-greeting    # run a single case
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Effect, Option } from "effect";

import { XaiConfig } from "../src/XaiConfig.js";
import { cases as bashCases } from "./cases/bash-tool.js";
import { cases as basicCases } from "./cases/basic-conversation.js";
import { cases as clockCases } from "./cases/clock.js";
import { cases as contextCases } from "./cases/context-awareness.js";
import { cases as groupCases } from "./cases/group-behavior.js";
import { cases as guardrailCases } from "./cases/guardrails.js";
import { cases as heartbeatRestraintCases } from "./cases/heartbeat-restraint.js";
import { cases as imageVideoCases } from "./cases/image-video-gen.js";
import { cases as mediaCases } from "./cases/media-handling.js";
import { cases as memoryCaptureCases } from "./cases/memory-capture.js";
import { cases as memoryConductCases } from "./cases/memory-conduct.js";
import { cases as outputCases } from "./cases/output-quality.js";
import { cases as permissionCases } from "./cases/permissions.js";
import { cases as prodRegressionCases } from "./cases/production-regressions.js";
import { cases as reactionCases } from "./cases/reaction-behavior.js";
import { cases as silentCases } from "./cases/silent-response.js";
import { cases as skillCases } from "./cases/skills.js";
import { cases as toneCases } from "./cases/tone-naturalness.js";
import { makeEvalLayers, runEval } from "./runner.js";
import type { EvalResult, EvalSuiteResult } from "./types.js";

// ── Load .env for XAI_API_KEY ──
// Must run before layer construction (layers capture env at build time).

const envPath = resolve(import.meta.dirname, "../../../.env");
const envContents = Option.liftThrowable(() => readFileSync(envPath, "utf-8"))();

if (Option.isSome(envContents)) {
  for (const line of envContents.value.split("\n")) {
    const eqIdx = line.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1).trim();
    if (key && value && !process.env[key]) process.env[key] = value;
  }
}

// ── CLI flags ──

const readFlag = (flag: string): string | null => {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 && process.argv[idx + 1] ? (process.argv[idx + 1] ?? null) : null;
};

// Collect all --case filters (supports multiple)
const caseFilters: string[] = [];
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === "--case" && process.argv[i + 1]) {
    caseFilters.push(process.argv[i + 1]);
  }
}
const modelOverride = readFlag("--model");
if (modelOverride) process.env.XAI_MODEL = modelOverride;
const concurrencyOverride = readFlag("--concurrency");
const concurrency = concurrencyOverride
  ? Number.parseInt(concurrencyOverride, 10)
  : undefined;

// ── Collect cases ──

const allCases = [
  ...basicCases,
  ...mediaCases,
  ...contextCases,
  ...reactionCases,
  ...guardrailCases,
  ...groupCases,
  ...outputCases,
  ...prodRegressionCases,
  ...silentCases,
  ...toneCases,
  ...permissionCases,
  ...skillCases,
  ...bashCases,
  ...imageVideoCases,
  ...heartbeatRestraintCases,
  ...memoryConductCases,
  ...memoryCaptureCases,
  ...clockCases,
];

const selectedCases =
  caseFilters.length > 0
    ? allCases.filter((c) => caseFilters.some((f) => c.id.startsWith(f)))
    : allCases;

if (selectedCases.length === 0) {
  process.stderr.write(
    `No eval cases found${caseFilters.length > 0 ? ` matching ${caseFilters.map((f) => `"${f}"`).join(", ")}` : ""}.\n`,
  );
  process.stderr.write(`Available cases: ${allCases.map((c) => c.id).join(", ")}\n`);
  process.exit(1);
}

// ── Output formatting ──

const PASS = "\x1b[32mPASS\x1b[0m";
const FAIL = "\x1b[31mFAIL\x1b[0m";
const WARN = "\x1b[33m";
const RESET = "\x1b[0m";

const printResult = (result: EvalResult): void => {
  const status = result.passed ? PASS : FAIL;
  const duration = `${(result.durationMs / 1000).toFixed(1)}s`;
  process.stdout.write(`  ${status}  ${result.caseId} (${duration})\n`);

  if (result.messages.length > 0) {
    const first = result.messages[0] ?? "";
    const preview = first.slice(0, 100);
    process.stdout.write(
      `         response: "${preview}${first.length > 100 ? "..." : ""}"\n`,
    );
  }

  if (result.toolCalls.length > 0) {
    const calls = result.toolCalls
      .map((tc) => `${tc.name}(${JSON.stringify(tc.args)})`)
      .join(", ");
    process.stdout.write(`         tools: ${calls}\n`);
  }

  for (const ar of result.assertionResults) {
    if (!ar.passed) {
      process.stdout.write(`         ${FAIL} ${ar.assertion}\n`);
      if (ar.detail) {
        process.stdout.write(`              ${ar.detail}\n`);
      }
    }
  }

  if (result.judgeResults) {
    for (const jr of result.judgeResults) {
      const scoreColor = jr.score >= 4 ? "\x1b[32m" : jr.score >= 3 ? WARN : "\x1b[31m";
      process.stdout.write(
        `         judge: ${scoreColor}${jr.score}/5${RESET} ${jr.criterion}\n`,
      );
    }
  }

  process.stdout.write("\n");
};

const printSummary = (suite: EvalSuiteResult): void => {
  process.stdout.write(`${"─".repeat(60)}\n`);
  const duration = `${(suite.durationMs / 1000).toFixed(1)}s`;
  const passed = suite.totalCases - suite.failedCases;
  const status =
    suite.failedCases === 0
      ? `\x1b[32m${suite.totalCases}/${suite.totalCases} passed\x1b[0m`
      : `\x1b[33m${passed}/${suite.totalCases} passed\x1b[0m`;
  process.stdout.write(`  ${status} in ${duration}\n`);

  const withUsage = suite.results.filter((r) => r.tokenUsage);
  if (withUsage.length > 0) {
    const totalInput = withUsage.reduce(
      (s, r) => s + (r.tokenUsage?.inputTokens ?? 0),
      0,
    );
    const totalOutput = withUsage.reduce(
      (s, r) => s + (r.tokenUsage?.outputTokens ?? 0),
      0,
    );
    const total = totalInput + totalOutput;
    const avgTotal = Math.round(total / withUsage.length);
    const avgInput = Math.round(totalInput / withUsage.length);
    const avgOutput = Math.round(totalOutput / withUsage.length);
    const fmt = (n: number) => n.toLocaleString();
    process.stdout.write(
      `  tokens: ${fmt(total)} total (${fmt(totalInput)} in, ${fmt(totalOutput)} out)\n`,
    );
    process.stdout.write(
      `  avg/case: ${fmt(avgTotal)} total (${fmt(avgInput)} in, ${fmt(avgOutput)} out)\n`,
    );
  }
  process.stdout.write("\n");
};

// ── Run ──

const program = Effect.gen(function* () {
  const { model } = yield* XaiConfig;
  process.stdout.write(`\n  model: ${model}\n`);
  process.stdout.write(`  cases: ${selectedCases.length}\n\n`);

  const start = Date.now();

  const results = yield* Effect.forEach(
    selectedCases,
    (evalCase) =>
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
        Effect.tap((result) => Effect.sync(() => printResult(result))),
      ),
    { concurrency: concurrency ?? 8 },
  );

  const passedCases = results.filter((r) => r.passed).length;
  const suite: EvalSuiteResult = {
    results,
    totalCases: selectedCases.length,
    passedCases,
    failedCases: selectedCases.length - passedCases,
    durationMs: Date.now() - start,
  };

  printSummary(suite);

  if (suite.failedCases > 0) {
    yield* Effect.fail(new Error(`${suite.failedCases} eval(s) failed`));
  }
}).pipe(Effect.provide(makeEvalLayers()));

// Effect AI's Chat.empty leaks `any` into R — same pattern as bin/main.ts
Effect.runPromise(program as Effect.Effect<void>).catch((error: unknown) => {
  process.stderr.write(`Eval runner crashed: ${error}\n`);
  process.exit(1);
});
