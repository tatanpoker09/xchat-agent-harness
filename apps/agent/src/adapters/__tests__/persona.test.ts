import { describe, expect, it } from "bun:test";
import type { BrainApi } from "@x-chat/drone-core";
import { Effect } from "effect";
import { type XChatAdapterConfig, assembleTurnPersona } from "../xchat.js";

const baseConfig = (overrides: Partial<XChatAdapterConfig>): XChatAdapterConfig => ({
  myUserId: "1",
  allowedConversationIds: [],
  globalAdmins: [],
  defaultConversationConfig: {},
  configVersion: 0,
  mechanics: "MECHANICS TEXT",
  fallbackSoul: "SEED SOUL",
  speakUnprompted: [],
  ...overrides,
});

/** A stub brain — only the members assembleTurnPersona touches. */
const stubBrain = (options: {
  soul?: string;
  people?: Record<string, string>; // handle -> person id
  context?: string;
}): BrainApi =>
  ({
    root: "/tmp/stub",
    read: (path: string) =>
      path === "soul.md" && options.soul !== undefined
        ? Effect.succeed(options.soul)
        : Effect.fail({ reason: "not_found" } as never),
    resolvePerson: (_channel: string, handle: string) =>
      Effect.succeed(options.people?.[handle]),
    contextFor: (personIds: ReadonlyArray<string>, roomKey?: string) =>
      Effect.succeed(
        options.context ?? `CTX(${personIds.join(",")})@${roomKey ?? "none"}`,
      ),
  }) as unknown as BrainApi;

const persona = (config: XChatAdapterConfig, convId: string, senderId: string) =>
  Effect.runPromise(assembleTurnPersona(config, convId, senderId));

describe("assembleTurnPersona", () => {
  it("brainless: mechanics + seed soul, no memory section", async () => {
    const out = await persona(baseConfig({}), "1:2", "2");
    expect(out).toContain("MECHANICS TEXT");
    expect(out).toContain("SEED SOUL");
    expect(out).not.toContain("# What you know");
  });

  it("with brain: live soul + memory context for both 1:1 participants", async () => {
    const brain = stubBrain({
      soul: "LIVE SOUL",
      people: { "111": "zach", "222": "bot" },
    });
    const out = await persona(baseConfig({ brain }), "111:222", "111");
    expect(out).toContain("LIVE SOUL");
    expect(out).not.toContain("SEED SOUL");
    expect(out).toContain("CTX(zach,bot)@111:222"); // room key = conversation id
  });

  it("group conversations resolve the sender", async () => {
    const brain = stubBrain({ soul: "S", people: { "999": "arthur" } });
    const out = await persona(baseConfig({ brain }), "g12345", "999");
    expect(out).toContain("CTX(arthur)@g12345");
  });

  it("unknown senders degrade to empty person list, soul read failure falls back to seed", async () => {
    const brain = stubBrain({ people: {} }); // no soul -> read fails
    const out = await persona(baseConfig({ brain }), "g777", "555");
    expect(out).toContain("SEED SOUL");
    expect(out).toContain("CTX()@g777");
  });
});
