import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import type { AgentConfig } from "../config.js";
import {
  loadAgentConfig,
  saveAgentConfig,
  validateAgentConfig,
  watchAgentConfig,
} from "../config.js";

const makeTmpDir = () => mkdtempSync(resolve(tmpdir(), "agent-config-test-"));

describe("validateAgentConfig", () => {
  const validConfig = {
    globalAdmins: ["123"],
    globalAdminToolkits: ["xchat"],
    botHandles: ["bot1"],
    allowedConversationIds: ["conv1"],
    defaults: {
      respondTo: "everyone",
      trigger: "mention_only",
      toolkits: ["xchat"],
    },
    conversations: {
      conv1: {
        trigger: "all_messages",
        toolkits: { admin: ["xchat", "linear"], user: ["xchat"] },
      },
    },
  };

  test("accepts a drone block (core config — no channel vocabulary)", () => {
    const result = validateAgentConfig({
      ...validConfig,
      drone: { owner: "Zach", brain: { remote: "https://github.com/z/brain.git" } },
    });
    expect(result.drone?.owner).toBe("Zach");
    expect(result.drone?.brain?.remote).toBe("https://github.com/z/brain.git");
    // absent stays absent
    expect(validateAgentConfig(validConfig).drone).toBeUndefined();
  });

  test("accepts a valid speakUnprompted subset (channel config)", () => {
    const result = validateAgentConfig({
      ...validConfig,
      allowedConversationIds: ["123:456", "g789"],
      speakUnprompted: ["123:456"],
    });
    expect(result.speakUnprompted).toEqual(["123:456"]);
  });

  test("rejects speakUnprompted violations", () => {
    const base = { ...validConfig, allowedConversationIds: ["123:456", "g789"] };
    expect(() => validateAgentConfig({ ...base, speakUnprompted: ["*"] })).toThrow(
      'must not contain "*"',
    );
    expect(() => validateAgentConfig({ ...base, speakUnprompted: ["123-456"] })).toThrow(
      "colon-form",
    );
    expect(() => validateAgentConfig({ ...base, speakUnprompted: ["999:111"] })).toThrow(
      "not in allowedConversationIds",
    );
    expect(
      () =>
        validateAgentConfig({
          ...base,
          speakUnprompted: ["g789"],
        }).speakUnprompted,
    ).not.toThrow();
  });

  test("accepts and rejects drone.heartbeat shapes", () => {
    const good = validateAgentConfig({
      ...validConfig,
      drone: {
        heartbeat: {
          intervalMinutes: 30,
          quietHours: { start: "23:00", end: "08:00", timezone: "America/Los_Angeles" },
        },
      },
    });
    expect(good.drone?.heartbeat?.intervalMinutes).toBe(30);
    expect(() =>
      validateAgentConfig({
        ...validConfig,
        drone: { heartbeat: { intervalMinutes: "x" } },
      }),
    ).toThrow("intervalMinutes must be a number");
    expect(() =>
      validateAgentConfig({
        ...validConfig,
        drone: {
          heartbeat: {
            intervalMinutes: 30,
            quietHours: { start: "late", end: "08:00", timezone: "UTC" },
          },
        },
      }),
    ).toThrow('must be "HH:MM"');
  });

  test("rejects malformed drone blocks", () => {
    expect(() => validateAgentConfig({ ...validConfig, drone: "yes" })).toThrow(
      "drone must be an object",
    );
    expect(() => validateAgentConfig({ ...validConfig, drone: { owner: 42 } })).toThrow(
      "drone.owner must be a string",
    );
    expect(() =>
      validateAgentConfig({ ...validConfig, drone: { brain: { remote: 1 } } }),
    ).toThrow("drone.brain.remote must be a string");
  });

  test("accepts a valid config", () => {
    const result = validateAgentConfig(validConfig);
    expect(result.globalAdmins).toEqual(["123"]);
    expect(result.botHandles).toEqual(["bot1"]);
    expect(result.defaults.respondTo).toBe("everyone");
    expect(result.conversations.conv1.trigger).toBe("all_messages");
  });

  test("accepts valid config with toolkits as object", () => {
    const result = validateAgentConfig(validConfig);
    const conv = result.conversations.conv1;
    expect(conv.toolkits).toEqual({ admin: ["xchat", "linear"], user: ["xchat"] });
  });

  test("throws on non-object input", () => {
    expect(() => validateAgentConfig("string")).toThrow("must be a JSON object");
    expect(() => validateAgentConfig(null)).toThrow("must be a JSON object");
    expect(() => validateAgentConfig([])).toThrow("must be a JSON object");
  });

  test("throws on missing globalAdmins", () => {
    const bad = { ...validConfig, globalAdmins: undefined };
    expect(() => validateAgentConfig(bad)).toThrow("globalAdmins must be an array");
  });

  test("throws on missing botHandles", () => {
    const bad = { ...validConfig, botHandles: undefined };
    expect(() => validateAgentConfig(bad)).toThrow("botHandles must be an array");
  });

  test("throws on missing allowedConversationIds", () => {
    const bad = { ...validConfig, allowedConversationIds: undefined };
    expect(() => validateAgentConfig(bad)).toThrow(
      "allowedConversationIds must be an array",
    );
  });

  test("throws on missing defaults", () => {
    const bad = { ...validConfig, defaults: undefined };
    expect(() => validateAgentConfig(bad)).toThrow("defaults must be an object");
  });

  test("throws on missing conversations", () => {
    const bad = { ...validConfig, conversations: undefined };
    expect(() => validateAgentConfig(bad)).toThrow("conversations must be an object");
  });

  test("throws on invalid respondTo value", () => {
    const bad = {
      ...validConfig,
      defaults: { ...validConfig.defaults, respondTo: "nobody" },
    };
    expect(() => validateAgentConfig(bad)).toThrow(
      'respondTo must be "everyone" or "admins_only"',
    );
  });

  test("throws on invalid trigger value", () => {
    const bad = {
      ...validConfig,
      defaults: { ...validConfig.defaults, trigger: "sometimes" },
    };
    expect(() => validateAgentConfig(bad)).toThrow(
      'trigger must be "all_messages" or "mention_only"',
    );
  });

  test("throws on invalid toolkits value", () => {
    const bad = {
      ...validConfig,
      defaults: { ...validConfig.defaults, toolkits: "invalid" },
    };
    expect(() => validateAgentConfig(bad)).toThrow("toolkits must be a string[]");
  });

  test("throws on non-string items in globalAdmins", () => {
    const bad = { ...validConfig, globalAdmins: [123] };
    expect(() => validateAgentConfig(bad)).toThrow(
      "globalAdmins must contain only strings",
    );
  });

  test("throws on missing globalAdminToolkits", () => {
    const bad = { ...validConfig, globalAdminToolkits: undefined };
    expect(() => validateAgentConfig(bad)).toThrow(
      "globalAdminToolkits must be an array",
    );
  });

  test("throws on non-string items in globalAdminToolkits", () => {
    const bad = { ...validConfig, globalAdminToolkits: [123] };
    expect(() => validateAgentConfig(bad)).toThrow(
      "globalAdminToolkits must contain only strings",
    );
  });

  test("accepts empty globalAdminToolkits", () => {
    const config = { ...validConfig, globalAdminToolkits: [] };
    const result = validateAgentConfig(config);
    expect(result.globalAdminToolkits).toEqual([]);
  });
});

describe("loadAgentConfig", () => {
  test("creates default file when missing", () => {
    const dir = makeTmpDir();
    const config = loadAgentConfig(dir);

    expect(config.globalAdmins).toEqual([]);
    expect(config.globalAdminToolkits).toEqual(["xchat"]);
    expect(config.botHandles).toEqual([]);
    expect(config.allowedConversationIds).toEqual([]);
    expect(config.defaults.respondTo).toBe("everyone");
    expect(config.defaults.trigger).toBe("mention_only");
    expect(config.defaults.toolkits).toEqual(["xchat"]);
    expect(config.conversations).toEqual({});

    // File should exist on disk
    const onDisk = JSON.parse(readFileSync(resolve(dir, "agent-config.json"), "utf-8"));
    expect(onDisk.globalAdmins).toEqual([]);
  });

  test("reads existing file", () => {
    const dir = makeTmpDir();
    const existing = {
      globalAdmins: ["999"],
      globalAdminToolkits: ["xchat", "linear"],
      botHandles: ["mybot"],
      allowedConversationIds: ["c1"],
      defaults: {
        respondTo: "admins_only",
        trigger: "all_messages",
        toolkits: ["xchat"],
      },
      conversations: {},
    };
    writeFileSync(resolve(dir, "agent-config.json"), JSON.stringify(existing), "utf-8");

    const config = loadAgentConfig(dir);
    expect(config.globalAdmins).toEqual(["999"]);
    expect(config.defaults.respondTo).toBe("admins_only");
  });
});

describe("saveAgentConfig + loadAgentConfig roundtrip", () => {
  test("save then load returns same config", () => {
    const dir = makeTmpDir();
    const config = {
      globalAdmins: ["a", "b"],
      globalAdminToolkits: ["xchat", "coding"],
      botHandles: ["bot"],
      allowedConversationIds: ["conv1", "conv2"],
      defaults: {
        respondTo: "admins_only" as const,
        trigger: "all_messages" as const,
        toolkits: { admin: ["xchat", "linear"], user: ["xchat"] },
      },
      conversations: {
        conv1: { trigger: "mention_only" as const },
      },
    };

    saveAgentConfig(dir, config);

    // Verify file has trailing newline and 2-space indent
    const raw = readFileSync(resolve(dir, "agent-config.json"), "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain('  "globalAdmins"');

    const loaded = loadAgentConfig(dir);
    expect(loaded.globalAdmins).toEqual(["a", "b"]);
    expect(loaded.defaults.trigger).toBe("all_messages");
    expect(loaded.conversations.conv1.trigger).toBe("mention_only");
  });
});

describe("watchAgentConfig", () => {
  const { setTimeout: sleep } = require("node:timers/promises");

  const baseConfig = {
    globalAdmins: ["a"],
    globalAdminToolkits: ["xchat"],
    botHandles: [],
    allowedConversationIds: [],
    defaults: {
      respondTo: "everyone" as const,
      trigger: "mention_only" as const,
      toolkits: ["xchat"],
    },
    conversations: {},
  };

  test("calls onChange when config file changes", async () => {
    const dir = makeTmpDir();
    saveAgentConfig(dir, baseConfig);

    let received: AgentConfig | null = null;
    const stop = watchAgentConfig(dir, (config) => {
      received = config;
    });

    try {
      // Modify the file
      const updated = { ...baseConfig, globalAdmins: ["a", "b"] };
      saveAgentConfig(dir, updated);

      // Wait for debounce + fs.watch delay
      await sleep(500);

      if (!received) throw new Error("expected onChange to be called");
      const result: AgentConfig = received;
      expect(result.globalAdmins).toEqual(["a", "b"]);
    } finally {
      stop();
    }
  });

  test("ignores invalid config changes", async () => {
    const dir = makeTmpDir();
    saveAgentConfig(dir, baseConfig);

    let callCount = 0;
    const stop = watchAgentConfig(dir, () => {
      callCount++;
    });

    try {
      // Write invalid JSON
      writeFileSync(resolve(dir, "agent-config.json"), "invalid json", "utf-8");

      await sleep(500);

      // Should not have called onChange
      expect(callCount).toBe(0);
    } finally {
      stop();
    }
  });

  test("cleanup function stops watching", async () => {
    const dir = makeTmpDir();
    saveAgentConfig(dir, baseConfig);

    let callCount = 0;
    const stop = watchAgentConfig(dir, () => {
      callCount++;
    });

    // Stop immediately
    stop();

    // Modify the file after stopping
    const updated = { ...baseConfig, globalAdmins: ["x"] };
    saveAgentConfig(dir, updated);

    await sleep(500);

    expect(callCount).toBe(0);
  });
});
