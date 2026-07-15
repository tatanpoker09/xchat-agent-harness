import * as readline from "node:readline";
/**
 * stdin.ts — Stdin adapter.
 * Reads from stdin, runs the agent, prints responses to stdout.
 */
import { Effect } from "effect";
import { Chat } from "effect/unstable/ai";

import { run } from "@x-chat/drone-core";
import * as XaiLanguageModel from "../XaiLanguageModel.js";

/** Buffered line reader — never drops lines while the agent is thinking. */
function makeLineReader(rl: readline.Interface) {
  const buffer: string[] = [];
  let waiting: ((line: string | null) => void) | null = null;
  let closed = false;

  rl.on("line", (line) => {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(line);
    } else {
      buffer.push(line);
    }
  });

  rl.on("close", () => {
    closed = true;
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(null);
    }
  });

  return {
    next: (): Effect.Effect<string | null> =>
      Effect.callback<string | null>((resume) => {
        if (buffer.length > 0) {
          const next = buffer.shift() ?? null;
          resume(Effect.succeed(next));
        } else if (closed) {
          resume(Effect.succeed(null));
        } else {
          rl.prompt();
          waiting = (line) => resume(Effect.succeed(line));
        }
      }),
  };
}

export interface StdinAdapterConfig {
  // biome-ignore lint/suspicious/noExplicitAny: Effect AI toolkit generics are complex by design
  readonly toolkit?: any;
}

export const listenAndRespond = (config: StdinAdapterConfig) =>
  Effect.gen(function* () {
    const persistence = yield* Chat.Persistence;

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "> ",
    });

    const reader = makeLineReader(rl);
    let lastResponseId: string | undefined;

    while (true) {
      const line = yield* reader.next();
      if (line === null) break;
      const text = line.trim();
      if (!text) continue;
      if (text === "/quit") break;

      const session = yield* persistence.getOrCreate("stdin");
      const runEffect = run({
        chat: session,
        input: { text },
        toolkit: config.toolkit,
      });

      const result = lastResponseId
        ? yield* XaiLanguageModel.withConfigOverride(runEffect, {
            previous_response_id: lastResponseId,
          })
        : yield* runEffect;

      if (result.responseId) lastResponseId = result.responseId;

      for (const msg of result.messages) {
        process.stdout.write(`\n${msg}\n\n`);
      }
    }

    rl.close();
  });
