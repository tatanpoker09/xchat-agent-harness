/**
 * drone-chat — a minimal dev channel for talking to the drone directly.
 *
 * No xchat, no WebSocket, no second account: one turn per invocation, state
 * (brain git repo + transcript) persisted in a session directory. Built for
 * fast personality/seed iteration — a subagent can hold a whole conversation
 * with the drone via repeated invocations, reset, and try a new soul.
 *
 *   bun bin/drone-chat.ts --session /tmp/d1 "hey"
 *   bun bin/drone-chat.ts --session /tmp/d1 --speaker Marta "who are you?"
 *   bun bin/drone-chat.ts --session /tmp/d1 --reset            # wipe session
 *   bun bin/drone-chat.ts --session /tmp/d1 --soul ./soul.md "hey"   # seed override (fresh session only)
 *   bun bin/drone-chat.ts --session /tmp/d1 --show brain        # dump brain files
 *
 * The channel contract, honored: this file is the channel (eyes = argv,
 * mouth = stdout). The core stays channel-blind — persona is assembled here
 * from the LIVE soul (self-edits apply next turn, like production) plus
 * ambient memory over everyone in the people/ dir (dev brains are small).
 *
 * Env: XAI_API_KEY required; XAI_MODEL optional (defaults in XaiConfig).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Effect, Layer, Ref, Scope } from "effect";
import { Chat, Prompt } from "effect/unstable/ai";
import { FetchHttpClient } from "effect/unstable/http";
import { Persistence } from "effect/unstable/persistence";

import {
  type BrainApi,
  BrainService,
  BrainToolkit,
  buildPersona,
  makeBrain,
  makeBrainHandlers,
  run,
} from "@x-chat/drone-core";
import { XaiConfig } from "../src/XaiConfig.js";
import * as XaiLanguageModel from "../src/XaiLanguageModel.js";
import { sanitizeOutboundText } from "../src/adapters/sanitize.js";

// ── Args ──

interface Args {
  readonly session: string;
  readonly message: string | undefined;
  readonly speaker: string;
  readonly soul: string | undefined;
  readonly reset: boolean;
  readonly show: string | undefined;
}

const parseArgs = (argv: string[]): Args => {
  let session: string | undefined;
  let speaker = "Zach";
  let soul: string | undefined;
  let reset = false;
  let show: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--session") session = argv[++i];
    else if (arg === "--speaker") speaker = argv[++i] ?? speaker;
    else if (arg === "--soul") soul = argv[++i];
    else if (arg === "--reset") reset = true;
    else if (arg === "--show") show = argv[++i];
    else positional.push(arg);
  }

  if (!session) {
    console.error(
      'usage: drone-chat --session <dir> [--speaker <name>] [--soul <file>] [--reset] [--show brain|transcript] "<message>"',
    );
    process.exit(1);
  }

  return { session, message: positional[0], speaker, soul, reset, show };
};

// ── Transcript ──

interface TranscriptTurn {
  readonly role: "user" | "assistant";
  readonly text: string;
}

// Append-only JSONL: a read-modify-write of one JSON array dropped turns
// when invocations overlapped (observed 2026-06-11 during parallel subagent
// testing — retries racing a slow turn, last writer wins). Appends don't race.
const transcriptPath = (session: string) => join(session, "transcript.jsonl");

const loadTranscript = (session: string): TranscriptTurn[] => {
  const path = transcriptPath(session);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as TranscriptTurn);
};

const appendTranscript = (session: string, turns: TranscriptTurn[]): void => {
  appendFileSync(
    transcriptPath(session),
    `${turns.map((turn) => JSON.stringify(turn)).join("\n")}\n`,
  );
};

// ── Persona (dev-channel mechanics; soul + memory come from the brain) ──

const devMechanics = (botName: string, speaker: string) => `\
You are ${botName}, in a private 1:1 text chat. The person talking to you is
${speaker}. Reply with plain text only — whatever you output is the message
they receive. This is texting, not a document: markdown does not render here.
No bold, headers, bullets, code fences, and no markdown links or footnote
citations (never [[1]](url) or [text](url)). When a search informed your
answer, give the takeaway in your own words and name the source only if it
matters ("a 2024 meta-analysis") — paste a bare url only if asked for a link.
Search results are research, not a draft: never mirror their length or
structure into the chat. Whatever you learned, the reply is still a text
message — the two or three sentences you'd send a friend, not a briefing.

You have brain tools (brain_list / brain_read / brain_write) — your private
notes, persisted in git. Use them as yourself, not as an assistant feature.`;

// ── Main ──

const main = Effect.gen(function* () {
  const args = parseArgs(process.argv.slice(2));

  if (args.reset) {
    rmSync(args.session, { recursive: true, force: true });
    console.error(`session reset: ${args.session}`);
    if (args.message === undefined) return;
  }

  mkdirSync(args.session, { recursive: true });
  const brainDir = join(args.session, "brain");
  const freshBrain = !existsSync(brainDir);

  const scope = yield* Scope.make();
  const brain: BrainApi = yield* makeBrain({
    dir: brainDir,
    identity: { botName: "vanishfn", ownerName: "Zach" },
  }).pipe(Scope.provide(scope));

  // Soul override — fresh sessions only, so iteration runs are reproducible
  // and an existing session's self-edits are never clobbered.
  if (args.soul !== undefined && freshBrain) {
    yield* brain.write(
      "soul.md",
      readFileSync(args.soul, "utf-8"),
      "soul seed override (drone-chat dev)",
    );
  }

  if (args.show === "brain") {
    const files = yield* brain.list;
    for (const file of files) {
      const content = yield* brain.read(file);
      process.stdout.write(`───── ${file} ─────\n${content}\n\n`);
    }
    return;
  }
  if (args.show === "transcript") {
    for (const turn of loadTranscript(args.session)) {
      process.stdout.write(
        `${turn.role === "user" ? args.speaker : "drone"}: ${turn.text}\n`,
      );
    }
    return;
  }
  if (args.message === undefined) {
    console.error("nothing to do: no message and no --show");
    return;
  }

  // Live soul + ambient memory over everyone in people/ (dev brains are small).
  const soul = yield* brain.read("soul.md").pipe(Effect.catch(() => Effect.succeed("")));
  const personIds = (yield* brain.list)
    .filter((f) => f.startsWith("people/") && f.endsWith(".md"))
    .map((f) => f.slice("people/".length, -3))
    .filter((id) => id !== "README");
  const memoryContext = yield* brain.contextFor(personIds, undefined);

  const transcript = loadTranscript(args.session);
  const session = yield* Chat.empty;
  if (transcript.length > 0) {
    const messages = transcript.map((turn) =>
      Prompt.makeMessage(turn.role, {
        content: [Prompt.makePart("text", { text: turn.text })],
      }),
    );
    yield* Ref.update(session.history, (current) =>
      Prompt.concat(current, Prompt.fromMessages(messages)),
    );
  }

  // Same wiring as production (xchat-tools.ts): hand the handlers their brain
  // directly so the toolkit layer has no leftover requirements.
  const toolkitLayer = BrainToolkit.toLayer(
    makeBrainHandlers.pipe(Effect.provideService(BrainService, brain)),
  );

  const result = yield* run({
    chat: session,
    input: { text: args.message },
    toolkit: BrainToolkit,
    log: (entry) => {
      if (entry.type === "tool_call") {
        console.error(
          `[tool] ${entry.toolName}(${JSON.stringify(entry.args).slice(0, 160)})`,
        );
      }
    },
  }).pipe(Effect.provide(toolkitLayer), (effect) =>
    XaiLanguageModel.withConfigOverride(effect, {
      instructions: buildPersona({
        mechanics: devMechanics("vanishfn", args.speaker),
        soul,
        memoryContext,
      }),
    }),
  );

  // Same channel-mouth guarantee as production xchat sends.
  const reply = sanitizeOutboundText(result.messages.join("\n"));
  process.stdout.write(`${reply}\n`);

  appendTranscript(args.session, [
    { role: "user", text: args.message },
    { role: "assistant", text: reply },
  ]);
});

const layers = Layer.mergeAll(
  XaiLanguageModel.layer({ store: false }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(XaiConfig.layer),
  ),
  Chat.layerPersisted({ storeId: "drone-chat" }).pipe(
    Layer.provide(Persistence.layerBackingMemory),
  ),
  XaiConfig.layer,
);

// Same boundary cast as evals/run.ts — the toolkit's `any` generic leaks an
// `any` requirement that is in fact fully provided.
const program = main.pipe(Effect.provide(layers)) as Effect.Effect<void, unknown>;

Effect.runPromise(program).catch((error) => {
  console.error(String(error));
  process.exit(1);
});
