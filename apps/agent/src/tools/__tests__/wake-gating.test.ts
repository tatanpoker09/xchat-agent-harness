import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import type { ChatExecutor } from "../executors/index.js";
import { makeHandlers } from "../xchat-tools.js";

/**
 * Outbound gating, reactive vs wake mode — the property the design calls
 * "watching is broad; speaking is privileged": on a wake turn (no current
 * conversation) the allowlist parameter IS the channel's speakUnprompted
 * list, and it gates every mouth (send, react, voice note).
 */

const calls: string[] = [];
const stubExec = {
  sendMessage: (convId: string) =>
    Effect.sync(() => {
      calls.push(`send:${convId}`);
      return { id: "m1" };
    }),
  reactToMessage: (convId: string) =>
    Effect.sync(() => {
      calls.push(`react:${convId}`);
    }),
  sendVoiceNote: (convId: string) =>
    Effect.sync(() => {
      calls.push(`voice:${convId}`);
    }),
} as unknown as typeof ChatExecutor.Service;

const handlers = (options: {
  allowlist: readonly string[];
  role: "admin" | "user";
  currentConvId: string | undefined;
}) =>
  makeHandlers(
    [],
    options.allowlist,
    stubExec,
    new Set(),
    options.role,
    options.currentConvId,
  );

const fails = <A>(effect: Effect.Effect<A, string>): Promise<string> =>
  Effect.runPromise(
    effect.pipe(
      Effect.map(() => "UNEXPECTED SUCCESS"),
      Effect.catch((e) => Effect.succeed(e)),
    ),
  );

const send = { text: "hi", media_path: null };

describe("wake mode (currentConvId undefined)", () => {
  it("allows sends only into the speak allowlist", async () => {
    const h = handlers({ allowlist: ["1:2"], role: "user", currentConvId: undefined });
    const ok = await Effect.runPromise(
      h.send_message({ conversation_id: "1:2", ...send }),
    );
    expect(ok).toContain("sent");
    const blocked = await fails(h.send_message({ conversation_id: "3:4", ...send }));
    expect(blocked).toContain("not in the allowlist");
  });

  it("mute wake (empty allowlist) blocks every send", async () => {
    const h = handlers({ allowlist: [], role: "user", currentConvId: undefined });
    expect(await fails(h.send_message({ conversation_id: "1:2", ...send }))).toContain(
      "not in the allowlist",
    );
  });

  it("reactions and voice notes are gated by the same list", async () => {
    const h = handlers({ allowlist: ["1:2"], role: "user", currentConvId: undefined });
    expect(
      await fails(
        h.react_to_message({ conversation_id: "3:4", message_id: "9", emoji: "🔥" }),
      ),
    ).toContain("not in the allowlist");
    expect(
      await fails(h.send_voice_note({ conversation_id: "3:4", text: "hello" })),
    ).toContain("not in the allowlist");
    // allowed room passes through to the executor
    await Effect.runPromise(
      h.react_to_message({ conversation_id: "1:2", message_id: "9", emoji: "🔥" }),
    );
    expect(calls).toContain("react:1:2");
  });
});

describe("reactive mode (regressions)", () => {
  it("non-admin cross-conversation sends stay blocked", async () => {
    const h = handlers({ allowlist: ["1:2", "3:4"], role: "user", currentConvId: "1:2" });
    expect(await fails(h.send_message({ conversation_id: "3:4", ...send }))).toContain(
      "Can't send to that conversation.",
    );
  });

  it("admin cross-conversation sends still work", async () => {
    const h = handlers({
      allowlist: ["1:2", "3:4"],
      role: "admin",
      currentConvId: "1:2",
    });
    const ok = await Effect.runPromise(
      h.send_message({ conversation_id: "3:4", ...send }),
    );
    expect(ok).toContain("sent");
  });

  it("react_to_message now respects the allowlist (was ungated — found in design review)", async () => {
    const h = handlers({ allowlist: ["1:2"], role: "user", currentConvId: "1:2" });
    expect(
      await fails(
        h.react_to_message({ conversation_id: "9:9", message_id: "1", emoji: "👍" }),
      ),
    ).toContain("not in the allowlist");
  });

  it('wildcard "*" allowlist still permits everything (evals)', async () => {
    const h = handlers({ allowlist: ["*"], role: "admin", currentConvId: "c1" });
    const ok = await Effect.runPromise(
      h.send_message({ conversation_id: "anything", ...send }),
    );
    expect(ok).toContain("sent");
  });
});
