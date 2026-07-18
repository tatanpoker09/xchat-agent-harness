/**
 * config.ts — Agent configuration loading, validation, and persistence.
 *
 * Reads/writes `{accountDir}/agent-config.json`.
 */
import { existsSync, readFileSync, renameSync, watch, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { HeartbeatConfig } from "@x-chat/drone-core";
import type { ConversationConfig } from "./adapters/xchat.js";

/**
 * Core (drone) config — carries ZERO channel vocabulary by design: no
 * conversation ids ever appear under `drone.*`. Speak-gating and anything
 * else in channel id language is channel config, validated separately.
 * (docs/drone-core-design.md, "Config lifecycle".)
 */
export interface DroneConfig {
  /** Owner's short name — used in the seeded soul. Default "the owner". */
  owner?: string;
  brain?: {
    /** Git remote for the brain repo. Absent = local-only brain. */
    remote?: string;
  };
  /** The clock. Absent = heartbeat idle-skips (hot enable via config edit). */
  heartbeat?: HeartbeatConfig;
}

export interface AgentConfig {
  globalAdmins: string[];
  globalAdminToolkits: string[];
  botHandles: string[];
  allowedConversationIds: string[];
  /**
   * CHANNEL config (xchat id vocabulary): conversations where the drone may
   * speak with no inbound message — the entire blast radius of proactivity.
   * Must be a subset of allowedConversationIds; no "*"; colon/g-form ids
   * only. Default [] (wake turns are thinking-only). Read fresh at each
   * wake, so edits hot-apply.
   */
  speakUnprompted?: string[];
  defaults: ConversationConfig;
  conversations: Record<string, ConversationConfig>;
  drone?: DroneConfig;
}

const DEFAULT_CONFIG: AgentConfig = {
  globalAdmins: [],
  globalAdminToolkits: ["xchat"],
  botHandles: [],
  allowedConversationIds: [],
  defaults: {
    respondTo: "everyone",
    trigger: "mention_only",
    toolkits: ["xchat"],
  },
  conversations: {},
};

const CONFIG_FILENAME = "agent-config.json";

/** Load config from JSON file, creating default if missing. */
export const loadAgentConfig = (accountDir: string): AgentConfig => {
  const configPath = resolve(accountDir, CONFIG_FILENAME);

  if (!existsSync(configPath)) {
    writeFileSync(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf-8");
    return structuredClone(DEFAULT_CONFIG);
  }

  const raw = JSON.parse(readFileSync(configPath, "utf-8"));
  return validateAgentConfig(raw);
};

/** Save config to JSON file (pretty-printed, atomic via temp + rename). */
export const saveAgentConfig = (accountDir: string, config: AgentConfig): void => {
  const configPath = resolve(accountDir, CONFIG_FILENAME);
  const tmpPath = `${configPath}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  renameSync(tmpPath, configPath);
};

/**
 * Watch the agent config file for changes. Calls `onChange` with the new
 * validated config whenever the file is modified. Debounces rapid changes
 * (e.g. editor save triggering multiple events). Returns a cleanup function.
 */
export const watchAgentConfig = (
  accountDir: string,
  onChange: (config: AgentConfig) => void,
): (() => void) => {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const watcher = watch(accountDir, (_eventType, filename) => {
    if (!filename || filename !== CONFIG_FILENAME) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      try {
        const config = loadAgentConfig(accountDir);
        onChange(config);
      } catch (e) {
        process.stderr.write(`[config] reload failed: ${e}\n`);
      }
    }, 100);
  });

  return () => {
    watcher.close();
    if (debounceTimer) clearTimeout(debounceTimer);
  };
};

/** Validate and coerce a parsed JSON object into AgentConfig. Throws with clear message on invalid values. */
export const validateAgentConfig = (raw: unknown): AgentConfig => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Agent config must be a JSON object");
  }

  const obj = raw as Record<string, unknown>;

  // globalAdmins
  if (!Array.isArray(obj.globalAdmins)) {
    throw new Error("Agent config: globalAdmins must be an array");
  }
  for (const item of obj.globalAdmins) {
    if (typeof item !== "string") {
      throw new Error("Agent config: globalAdmins must contain only strings");
    }
  }

  // globalAdminToolkits
  if (!Array.isArray(obj.globalAdminToolkits)) {
    throw new Error("Agent config: globalAdminToolkits must be an array");
  }
  for (const item of obj.globalAdminToolkits) {
    if (typeof item !== "string") {
      throw new Error("Agent config: globalAdminToolkits must contain only strings");
    }
  }

  // botHandles
  if (!Array.isArray(obj.botHandles)) {
    throw new Error("Agent config: botHandles must be an array");
  }
  for (const item of obj.botHandles) {
    if (typeof item !== "string") {
      throw new Error("Agent config: botHandles must contain only strings");
    }
  }

  // allowedConversationIds
  if (!Array.isArray(obj.allowedConversationIds)) {
    throw new Error("Agent config: allowedConversationIds must be an array");
  }
  for (const item of obj.allowedConversationIds) {
    if (typeof item !== "string") {
      throw new Error("Agent config: allowedConversationIds must contain only strings");
    }
  }

  // defaults
  if (
    typeof obj.defaults !== "object" ||
    obj.defaults === null ||
    Array.isArray(obj.defaults)
  ) {
    throw new Error("Agent config: defaults must be an object");
  }
  validateConversationConfig(obj.defaults as Record<string, unknown>, "defaults");

  // speakUnprompted (optional CHANNEL config — validated here, next to the
  // allowlist, in channel id vocabulary; the core never sees these)
  if (obj.speakUnprompted !== undefined) {
    if (!Array.isArray(obj.speakUnprompted)) {
      throw new Error("Agent config: speakUnprompted must be an array");
    }
    const allowlist = obj.allowedConversationIds as string[];
    const allowAll = allowlist.includes("*");
    for (const item of obj.speakUnprompted) {
      if (typeof item !== "string") {
        throw new Error("Agent config: speakUnprompted must contain only strings");
      }
      if (item === "*") {
        throw new Error(
          'Agent config: speakUnprompted must not contain "*" — unprompted speech is an explicit per-conversation grant',
        );
      }
      // The colon-vs-dash trap (see AGENTS.md): dash-form ids silently never
      // match. Reject anything that isn't colon-form 1:1 or g<id> group form.
      if (!/^(\d+:\d+|g\d+)$/.test(item)) {
        throw new Error(
          `Agent config: speakUnprompted id "${item}" must be colon-form (<lowId>:<highId>) or group form (g<id>)`,
        );
      }
      // "*" means the agent listens to the whole inbox, so any explicit
      // speakUnprompted grant is allowed (still a tight blast-radius list).
      if (!allowAll && !allowlist.includes(item)) {
        throw new Error(
          `Agent config: speakUnprompted id "${item}" is not in allowedConversationIds — the drone can only speak unprompted where it already listens`,
        );
      }
    }
  }

  // drone (optional core config — validated with no conversation-id knowledge)
  if (obj.drone !== undefined) {
    if (typeof obj.drone !== "object" || obj.drone === null || Array.isArray(obj.drone)) {
      throw new Error("Agent config: drone must be an object");
    }
    const drone = obj.drone as Record<string, unknown>;
    if (drone.owner !== undefined && typeof drone.owner !== "string") {
      throw new Error("Agent config: drone.owner must be a string");
    }
    if (drone.brain !== undefined) {
      if (
        typeof drone.brain !== "object" ||
        drone.brain === null ||
        Array.isArray(drone.brain)
      ) {
        throw new Error("Agent config: drone.brain must be an object");
      }
      const brain = drone.brain as Record<string, unknown>;
      if (brain.remote !== undefined && typeof brain.remote !== "string") {
        throw new Error("Agent config: drone.brain.remote must be a string");
      }
    }
    if (drone.heartbeat !== undefined) {
      if (
        typeof drone.heartbeat !== "object" ||
        drone.heartbeat === null ||
        Array.isArray(drone.heartbeat)
      ) {
        throw new Error("Agent config: drone.heartbeat must be an object");
      }
      const hb = drone.heartbeat as Record<string, unknown>;
      if (
        typeof hb.intervalMinutes !== "number" ||
        !Number.isFinite(hb.intervalMinutes)
      ) {
        throw new Error("Agent config: drone.heartbeat.intervalMinutes must be a number");
      }
      if (hb.quietHours !== undefined) {
        const qh = hb.quietHours as Record<string, unknown>;
        if (typeof qh !== "object" || qh === null) {
          throw new Error("Agent config: drone.heartbeat.quietHours must be an object");
        }
        for (const field of ["start", "end"] as const) {
          if (
            typeof qh[field] !== "string" ||
            !/^\d{1,2}:\d{2}$/.test(qh[field] as string)
          ) {
            throw new Error(
              `Agent config: drone.heartbeat.quietHours.${field} must be "HH:MM"`,
            );
          }
        }
        if (typeof qh.timezone !== "string") {
          throw new Error(
            "Agent config: drone.heartbeat.quietHours.timezone must be a string",
          );
        }
      }
    }
  }

  // conversations
  if (
    typeof obj.conversations !== "object" ||
    obj.conversations === null ||
    Array.isArray(obj.conversations)
  ) {
    throw new Error("Agent config: conversations must be an object");
  }
  const conversations = obj.conversations as Record<string, unknown>;
  for (const [key, value] of Object.entries(conversations)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`Agent config: conversations["${key}"] must be an object`);
    }
    validateConversationConfig(
      value as Record<string, unknown>,
      `conversations["${key}"]`,
    );
  }

  return obj as unknown as AgentConfig;
};

const validateConversationConfig = (obj: Record<string, unknown>, path: string): void => {
  if (obj.respondTo !== undefined) {
    if (obj.respondTo !== "everyone" && obj.respondTo !== "admins_only") {
      throw new Error(
        `Agent config: ${path}.respondTo must be "everyone" or "admins_only", got "${obj.respondTo}"`,
      );
    }
  }

  if (obj.trigger !== undefined) {
    if (obj.trigger !== "all_messages" && obj.trigger !== "mention_only") {
      throw new Error(
        `Agent config: ${path}.trigger must be "all_messages" or "mention_only", got "${obj.trigger}"`,
      );
    }
  }

  if (obj.toolkits !== undefined) {
    if (Array.isArray(obj.toolkits)) {
      for (const item of obj.toolkits) {
        if (typeof item !== "string") {
          throw new Error(
            `Agent config: ${path}.toolkits array must contain only strings`,
          );
        }
      }
    } else if (typeof obj.toolkits === "object" && obj.toolkits !== null) {
      const toolkitsObj = obj.toolkits as Record<string, unknown>;
      if (!Array.isArray(toolkitsObj.admin)) {
        throw new Error(`Agent config: ${path}.toolkits.admin must be a string array`);
      }
      for (const item of toolkitsObj.admin) {
        if (typeof item !== "string") {
          throw new Error(
            `Agent config: ${path}.toolkits.admin must contain only strings`,
          );
        }
      }
      if (!Array.isArray(toolkitsObj.user)) {
        throw new Error(`Agent config: ${path}.toolkits.user must be a string array`);
      }
      for (const item of toolkitsObj.user) {
        if (typeof item !== "string") {
          throw new Error(
            `Agent config: ${path}.toolkits.user must contain only strings`,
          );
        }
      }
    } else {
      throw new Error(
        `Agent config: ${path}.toolkits must be a string[] or { admin: string[], user: string[] }`,
      );
    }
  }

  if (obj.admins !== undefined) {
    if (!Array.isArray(obj.admins)) {
      throw new Error(`Agent config: ${path}.admins must be an array`);
    }
    for (const item of obj.admins) {
      if (typeof item !== "string") {
        throw new Error(`Agent config: ${path}.admins must contain only strings`);
      }
    }
  }
};
