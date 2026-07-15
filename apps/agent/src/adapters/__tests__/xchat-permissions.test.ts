import { describe, expect, it } from "bun:test";
import {
  type ConversationConfig,
  DEFAULT_CATCH_UP_INTERVAL_MS,
  isBotMention,
  resolveCatchUpIntervalMs,
  resolveConversationConfig,
  resolveToolkits,
  resolveUserRole,
  shouldRespond,
} from "../xchat.js";

describe("shouldRespond", () => {
  it("allows everyone + all_messages for any user", () => {
    expect(shouldRespond("everyone", "all_messages", "user", false)).toBe(true);
    expect(shouldRespond("everyone", "all_messages", "admin", false)).toBe(true);
  });

  it("requires mention for mention_only trigger", () => {
    expect(shouldRespond("everyone", "mention_only", "user", false)).toBe(false);
    expect(shouldRespond("everyone", "mention_only", "user", true)).toBe(true);
    expect(shouldRespond("everyone", "mention_only", "admin", false)).toBe(false);
    expect(shouldRespond("everyone", "mention_only", "admin", true)).toBe(true);
  });

  it("blocks non-admins when respondTo is admins_only", () => {
    expect(shouldRespond("admins_only", "all_messages", "user", false)).toBe(false);
    expect(shouldRespond("admins_only", "all_messages", "user", true)).toBe(false);
  });

  it("allows admins when respondTo is admins_only", () => {
    expect(shouldRespond("admins_only", "all_messages", "admin", false)).toBe(true);
    expect(shouldRespond("admins_only", "all_messages", "admin", true)).toBe(true);
  });

  it("applies both axes: admins_only + mention_only", () => {
    expect(shouldRespond("admins_only", "mention_only", "admin", false)).toBe(false);
    expect(shouldRespond("admins_only", "mention_only", "admin", true)).toBe(true);
    expect(shouldRespond("admins_only", "mention_only", "user", true)).toBe(false);
  });
});

describe("resolveUserRole", () => {
  it("returns admin for global admin", () => {
    expect(resolveUserRole("user1", ["user1"], [])).toBe("admin");
  });

  it("returns admin for conversation admin", () => {
    expect(resolveUserRole("user2", [], ["user2"])).toBe("admin");
  });

  it("returns user for non-admin", () => {
    expect(resolveUserRole("user3", ["user1"], ["user2"])).toBe("user");
  });

  it("returns user with empty admin lists", () => {
    expect(resolveUserRole("user1", [], [])).toBe("user");
  });
});

describe("resolveToolkits", () => {
  it("returns same set for flat array regardless of role", () => {
    const adminSet = resolveToolkits(["xchat", "linear"], "admin");
    const userSet = resolveToolkits(["xchat", "linear"], "user");
    expect(adminSet).toEqual(new Set(["xchat", "linear"]));
    expect(userSet).toEqual(new Set(["xchat", "linear"]));
  });

  it("returns role-specific set for object config", () => {
    const config = {
      admin: ["xchat", "linear", "coding"] as const,
      user: ["xchat"] as const,
    };
    expect(resolveToolkits(config, "admin")).toEqual(
      new Set(["xchat", "linear", "coding"]),
    );
    expect(resolveToolkits(config, "user")).toEqual(new Set(["xchat"]));
  });

  it("global admin gets globalAdminToolkits regardless of per-conversation config", () => {
    const config = {
      admin: ["xchat", "linear"] as const,
      user: ["xchat"] as const,
    };
    const result = resolveToolkits(config, "admin", true, ["xchat", "linear", "coding"]);
    expect(result).toEqual(new Set(["xchat", "linear", "coding"]));
  });

  it("non-global admin (conversation admin) uses per-conversation config", () => {
    const config = {
      admin: ["xchat", "linear"] as const,
      user: ["xchat"] as const,
    };
    const result = resolveToolkits(config, "admin", false, ["xchat", "linear", "coding"]);
    expect(result).toEqual(new Set(["xchat", "linear"]));
  });

  it("falls back to normal behavior when globalAdminToolkits is undefined", () => {
    const config = {
      admin: ["xchat", "linear"] as const,
      user: ["xchat"] as const,
    };
    const result = resolveToolkits(config, "admin", true, undefined);
    expect(result).toEqual(new Set(["xchat", "linear"]));
  });

  it("falls back to normal behavior when globalAdminToolkits is empty", () => {
    const config = {
      admin: ["xchat", "linear"] as const,
      user: ["xchat"] as const,
    };
    const result = resolveToolkits(config, "admin", true, []);
    expect(result).toEqual(new Set(["xchat", "linear"]));
  });
});

describe("resolveConversationConfig", () => {
  const defaults: ConversationConfig = {
    respondTo: "everyone",
    trigger: "mention_only",
    toolkits: ["xchat"],
  };

  it("returns defaults when no overrides", () => {
    const result = resolveConversationConfig(defaults, undefined, "conv1");
    expect(result.respondTo).toBe("everyone");
    expect(result.trigger).toBe("mention_only");
  });

  it("merges conversation-specific config", () => {
    const convConfig = { conv1: { trigger: "all_messages" as const } };
    const result = resolveConversationConfig(defaults, convConfig, "conv1");
    expect(result.respondTo).toBe("everyone"); // from defaults
    expect(result.trigger).toBe("all_messages"); // from conv config
  });

  it("runtime overrides take highest priority", () => {
    const convConfig = { conv1: { trigger: "all_messages" as const } };
    const runtime = new Map([["conv1", { trigger: "mention_only" as const }]]);
    const result = resolveConversationConfig(defaults, convConfig, "conv1", runtime);
    expect(result.trigger).toBe("mention_only"); // runtime wins
  });

  it("returns defaults for unknown conversation", () => {
    const convConfig = { conv1: { trigger: "all_messages" as const } };
    const result = resolveConversationConfig(defaults, convConfig, "conv999");
    expect(result.trigger).toBe("mention_only"); // defaults
  });
});

describe("resolveCatchUpIntervalMs", () => {
  it("defaults to 10 minutes when unset", () => {
    expect(resolveCatchUpIntervalMs(undefined)).toBe(DEFAULT_CATCH_UP_INTERVAL_MS);
    expect(DEFAULT_CATCH_UP_INTERVAL_MS).toBe(600_000);
  });

  it("defaults on blank or whitespace", () => {
    expect(resolveCatchUpIntervalMs("")).toBe(DEFAULT_CATCH_UP_INTERVAL_MS);
    expect(resolveCatchUpIntervalMs("   ")).toBe(DEFAULT_CATCH_UP_INTERVAL_MS);
  });

  it("parses a positive integer of milliseconds (>= floor)", () => {
    expect(resolveCatchUpIntervalMs("300000")).toBe(300_000);
    expect(resolveCatchUpIntervalMs("60000")).toBe(60_000);
  });

  it("treats 0 as disabled (returns 0)", () => {
    expect(resolveCatchUpIntervalMs("0")).toBe(0);
  });

  it("clamps positive values below the 30s floor", () => {
    expect(resolveCatchUpIntervalMs("100")).toBe(30_000);
    expect(resolveCatchUpIntervalMs("29999")).toBe(30_000);
    expect(resolveCatchUpIntervalMs("0.4")).toBe(30_000);
    expect(resolveCatchUpIntervalMs("30000")).toBe(30_000);
  });

  it("floors fractional values above the floor", () => {
    expect(resolveCatchUpIntervalMs("60000.9")).toBe(60_000);
  });

  it("falls back to default on non-numeric or negative input", () => {
    expect(resolveCatchUpIntervalMs("abc")).toBe(DEFAULT_CATCH_UP_INTERVAL_MS);
    expect(resolveCatchUpIntervalMs("-5")).toBe(DEFAULT_CATCH_UP_INTERVAL_MS);
    expect(resolveCatchUpIntervalMs("NaN")).toBe(DEFAULT_CATCH_UP_INTERVAL_MS);
  });
});

describe("isBotMention", () => {
  it("detects @handle mention", () => {
    expect(isBotMention("hey @zw_bot do this", ["zw_bot"])).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isBotMention("hey @ZW_BOT do this", ["zw_bot"])).toBe(true);
  });

  it("returns false with no mention", () => {
    expect(isBotMention("hey do this", ["zw_bot"])).toBe(false);
  });

  it("checks multiple handles", () => {
    expect(isBotMention("hey @vanishfn", ["zw_bot", "vanishfn"])).toBe(true);
  });
});
