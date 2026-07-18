import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
/**
 * main.ts — Agent entry point.
 *
 * Without --as: stdin-only mode (for testing)
 * With --as <handle>: XChat mode (WebSocket + stdin)
 */
import { dirname, resolve } from "node:path";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { ConfigProvider, Effect, Fiber, Layer } from "effect";
import { Chat } from "effect/unstable/ai";
import { FetchHttpClient } from "effect/unstable/http";
import { Persistence } from "effect/unstable/persistence";

import {
  type BrainApi,
  heartbeatLoop,
  makeAlarms,
  makeBrain,
  soulSeed,
} from "@x-chat/drone-core";
import { listenAndRespond as stdinAdapter } from "../src/adapters/stdin.js";
import {
  makeExecuteWake,
  makeWakeEyes,
  listenAndRespond as xchatAdapter,
} from "../src/adapters/xchat.js";
import { loadAgentConfig, watchAgentConfig } from "../src/config.js";
import {
  type SocketEventEntry,
  initLogger,
  log,
  makeSdkLoggerLayer,
  resolvedSdkLogLevel,
} from "../src/logger.js";
import { discoverSkills } from "../src/skills.js";
import { buildMechanics, buildSystemPrompt } from "../src/system-prompt.js";

// ── Shutdown/crash logging ──

process.on("SIGTERM", () => {
  log({ type: "shutdown", reason: "SIGTERM" });
  process.exit(0);
});

process.on("SIGINT", () => {
  log({ type: "shutdown", reason: "SIGINT" });
  process.exit(0);
});

process.on("uncaughtException", (error) => {
  log({ type: "shutdown", reason: `uncaughtException: ${error}` });
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  log({ type: "shutdown", reason: `unhandledRejection: ${reason}` });
  process.exit(1);
});

// ── CLI flags ──

function readFlag(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 && process.argv[idx + 1] ? (process.argv[idx + 1] ?? null) : null;
}

const accountHandle = readFlag("--as") ?? readFlag("-a");
const modelOverride = readFlag("--model");
if (modelOverride) process.env.XAI_MODEL = modelOverride;

// ── Load credentials if XChat mode ──

let myUserId: string | undefined;

if (accountHandle) {
  const accountDir = resolve(
    process.env.HOME ?? "/tmp",
    `.xchat/accounts/${accountHandle}`,
  );

  // Load credentials.env if present. In k8s, DM_* env vars come from a Secret
  // via envFrom and the on-disk file may not exist — that's fine.
  try {
    const envContents = readFileSync(resolve(accountDir, "credentials.env"), "utf-8");
    for (const line of envContents.split("\n")) {
      const eqIdx = line.indexOf("=");
      if (eqIdx > 0) {
        const key = line.slice(0, eqIdx).trim();
        const value = line.slice(eqIdx + 1).trim();
        if (key && value) process.env[key] = value;
      }
    }
  } catch {
    /* no credentials.env — rely on DM_* env vars (k8s Secret) */
  }

  myUserId = process.env.DM_USER_ID;
  if (!myUserId) {
    process.stderr.write(
      `No DM_USER_ID for @${accountHandle} (set via credentials.env or DM_* env vars)\n`,
    );
    process.exit(1);
  }

  // Init SQLite
  const dbPath = resolve(accountDir, "dm.sqlite");
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  db.run("PRAGMA busy_timeout = 5000;");
  db.run("PRAGMA journal_mode = WAL;");
  db.close();

  // ── Bootstrap agent-config.json from env var (k8s cold-start) ──
  // Same idea — deploy.sh injects the local config as XCHAT_AGENT_CONFIG_B64,
  // and we materialise it on disk before loadAgentConfig() sees it. The
  // file watcher then handles all subsequent updates as normal.
  const configPath = resolve(accountDir, "agent-config.json");
  if (process.env.XCHAT_AGENT_CONFIG_B64 && !existsSync(configPath)) {
    const cfg = Buffer.from(process.env.XCHAT_AGENT_CONFIG_B64, "base64").toString(
      "utf-8",
    );
    writeFileSync(configPath, cfg);
    process.stderr.write(`  seeded agent-config.json from env (${cfg.length} chars)\n`);
  }

  // Set DB path for layer
  process.env.XCHAT_DB_PATH = dbPath;
}

// ── Build ConfigProvider that falls back to .env file ──

let ConfigLayer: Layer.Layer<never> = Layer.empty;
// Prefer harness .env; fall back to sibling x-chat/.env (shared XAI key).
// Also export KEY=VALUE into process.env so bash tools (linear, gh) inherit them.
const envCandidates = [
  resolve(import.meta.dirname, "../../../.env"), // harness root when running apps/agent
  resolve(import.meta.dirname, "../../../../x-chat/.env"),
  // Absolute fallbacks so a wrong binary path still finds secrets
  resolve(process.env.HOME ?? "/tmp", "Documents/Programming/xchat-agent-harness/.env"),
  resolve(process.env.HOME ?? "/tmp", "Documents/Programming/x-chat/.env"),
  process.env.XCHAT_HARNESS_ENV || "",
].filter(Boolean);

// Merge every readable .env (first wins for each key; process env already set wins).
let mergedDotEnv = "";
for (const envPath of envCandidates) {
  try {
    const contents = readFileSync(envPath, "utf-8");
    mergedDotEnv += `\n${contents}`;
    for (const line of contents.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
    process.stderr.write(`  env: loaded ${envPath}\n`);
  } catch {
    /* try next */
  }
}
if (mergedDotEnv.trim()) {
  ConfigLayer = ConfigProvider.layerAdd(ConfigProvider.fromDotEnvContents(mergedDotEnv));
}
process.stderr.write(
  `  phab: ${process.env.PHABRICATOR_CONDUIT_TOKEN ? "token set" : "NO TOKEN"}\n`,
);

// Harness bin/ (linear/sourcegraph/phab) on PATH
const harnessBinCandidates = [
  resolve(import.meta.dirname, "../../../bin"),
  resolve(process.env.HOME ?? "/tmp", "Documents/Programming/xchat-agent-harness/bin"),
];
for (const harnessBin of harnessBinCandidates) {
  if (existsSync(harnessBin)) {
    process.env.PATH = `${harnessBin}:${process.env.PATH ?? ""}`;
    process.stderr.write(`  path: prepended ${harnessBin}\n`);
    break;
  }
}

// ── LLM Provider ──

import { XaiConfig } from "../src/XaiConfig.js";
import * as XaiLanguageModel from "../src/XaiLanguageModel.js";

const skills = discoverSkills();
// Boot-time fallback instructions: mechanics + the seed soul. Every real turn
// overrides this per-request with the live soul + ambient memory; this is
// what soul-less paths (bare stdin, a failed brain boot) speak with.
const SYSTEM_PROMPT = buildSystemPrompt(
  skills,
  soulSeed({ botName: accountHandle ?? "drone", ownerName: "the owner" }),
);

if (skills.length > 0) {
  process.stderr.write(`  skills: ${skills.map((s) => s.name).join(", ")}\n`);
}

const XaiConfigLayer = XaiConfig.layer.pipe(Layer.provide(ConfigLayer));

const ModelLayer = XaiLanguageModel.layer({
  instructions: SYSTEM_PROMPT,
  store: false,
}).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(XaiConfigLayer));

// ── Session Persistence ──

const ChatPersistenceLayer = Chat.layerPersisted({ storeId: "agent-chats" }).pipe(
  Layer.provide(Persistence.layerBackingMemory),
);

// ── SDK logging bridge ──
// Forwards the xchat-sdk's internal Effect logs (frame decode, CKey
// resolution, decrypt, signing, mutation/send) into our JSONL stream as
// `sdk_log` entries. Provided to the main program AND to startLiveIngest so
// the live WebSocket frame path (which otherwise installs a silent logger) is
// captured too. Verbosity is controlled by XCHAT_LOG_LEVEL (default Debug).
const SdkLoggerLayer = makeSdkLoggerLayer();

// ── Main ──

if (accountHandle && myUserId) {
  // XChat mode: WebSocket + stdin
  // Dynamic import to avoid loading xchat-sdk deps in stdin-only mode
  const { makeBunLiveLayer, startLiveIngest } = await import("@x-chat/xchat-sdk/bun");
  const { Chat } = await import("@x-chat/xchat-sdk");

  const accountDir = resolve(
    process.env.HOME ?? "/tmp",
    `.xchat/accounts/${accountHandle}`,
  );
  const agentConfig = loadAgentConfig(accountDir);

  const dbPath = process.env.XCHAT_DB_PATH ?? "";
  const SqlLayer = SqliteClient.layer({ filename: dbPath, disableWAL: true });

  // ── Unified WebSocket diagnostics sink ───────────────────────────────
  // Every interesting socket-layer event (proxy CONNECT, TLS handshake,
  // WS upgrade, SocketLoop attempt/connect/close, keepalive sent/failed,
  // etc.) flows through here. Each fires a structured `socket_event`
  // JSONL line. We track lifetime counters here so the heartbeat fiber
  // below can summarise them without re-querying anything.
  const processStart = Date.now();
  let lastSocketEventAtMs = processStart;
  let lastSocketEventSubtype = "(none)";
  let framesReceived = 0;
  const bytesReceived = 0;
  let lastFrameAtMs = 0;
  let keepalivesSent = 0;
  let keepalivesFailed = 0;
  let reconnectAttempts = 0;
  let lastWsTransitionAtMs = processStart;
  const onSocketDiag = (event: { subtype: string; [k: string]: unknown }): void => {
    lastSocketEventAtMs = Date.now();
    lastSocketEventSubtype = event.subtype;
    if (event.subtype === "ws_server_ping") {
      framesReceived++;
      lastFrameAtMs = lastSocketEventAtMs;
    } else if (event.subtype === "loop_attempt_started") {
      reconnectAttempts++;
    } else if (event.subtype === "keepalive_sent") {
      keepalivesSent = (event.totalSent as number) ?? keepalivesSent + 1;
    } else if (event.subtype === "keepalive_failed") {
      keepalivesFailed = (event.totalFailed as number) ?? keepalivesFailed + 1;
    }
    // Spread the event payload first, then overlay our envelope fields so the
    // narrow `type`/`subtype`/`tProcessMs` keys always win over anything
    // identically-named inside `event`.
    log({
      ...(event as Record<string, unknown>),
      type: "socket_event",
      subtype: event.subtype as SocketEventEntry["subtype"],
      tProcessMs: lastSocketEventAtMs - processStart,
    } as SocketEventEntry);
  };

  const PlatformLayer = makeBunLiveLayer({ onDiag: onSocketDiag }).pipe(
    Layer.provide(SqlLayer),
  );

  // Initialize logger
  const logPath = initLogger(accountHandle);
  process.stderr.write(`  logs: ${logPath}\n`);
  process.stderr.write(`  config: ${resolve(accountDir, "agent-config.json")}\n`);

  // Capture myUserId in a const for use inside the effect
  const userId = myUserId;

  const program = Effect.gen(function* () {
    const { model } = yield* XaiConfig;
    process.stderr.write(`  account: @${accountHandle} (${userId})\n`);
    process.stderr.write(`  model: ${model}\n`);
    process.stderr.write(
      `  allowlist: ${agentConfig.allowedConversationIds.length} conversations\n`,
    );

    log({
      type: "startup",
      accountHandle,
      allowedConversationIds: agentConfig.allowedConversationIds,
    });

    // ── Auto-recover identity keys via Juicebox if missing (k8s cold-start) ──
    // On a fresh pod /data is empty. Rather than ship the SQLite around, we
    // run the same recovery flow as `xchat-cli recover-keys <PIN>` using the
    // PIN supplied via $XCHAT_PIN (sourced from the K8s Secret). This pulls
    // the encrypted identity blob from Juicebox realms, decrypts it, and
    // writes it into effect_sync_state — exactly what a fresh-from-cli
    // recover does. Idempotent: only runs when no identity_keys row exists.
    if (process.env.XCHAT_PIN) {
      const status = yield* Chat.account
        .keyStatus()
        .pipe(Effect.catch(() => Effect.succeed({ hasIdentityKeys: true })));
      if (!status.hasIdentityKeys) {
        process.stderr.write("  no identity_keys — running Juicebox recovery\n");
        yield* Chat.account.recoverKeys(process.env.XCHAT_PIN).pipe(
          Effect.tap((r) =>
            Effect.sync(() =>
              process.stderr.write(`  recovered ${r.recoveredCount} key version(s)\n`),
            ),
          ),
          Effect.tapError((e) =>
            Effect.sync(() =>
              process.stderr.write(`  ! recovery failed: ${String(e)}\n`),
            ),
          ),
          Effect.catch(() => Effect.void),
        );
      }
    }

    // ── Boot the brain (when `drone` config present) ──
    // Failure degrades to brainless (seed personality, no memory) rather than
    // killing the bot — but loudly, via brain_boot_failed.
    const ownerName = agentConfig.drone?.owner ?? "the owner";
    let brain: BrainApi | undefined;
    if (agentConfig.drone) {
      brain = yield* makeBrain({
        dir: resolve(accountDir, "brain"),
        remote: agentConfig.drone.brain?.remote,
        identity: { botName: accountHandle, ownerName },
        log: (entry) => log(entry as unknown as Parameters<typeof log>[0]),
      }).pipe(
        Effect.catch((e) =>
          Effect.sync(() => {
            log({ type: "brain_boot_failed", reason: e.reason, detail: e.detail });
            process.stderr.write(`  ! brain boot failed: ${e.reason} ${e.detail}\n`);
            return undefined;
          }),
        ),
      );
      if (brain) {
        yield* brain.sync; // pull owner edits made while the bot was down
        process.stderr.write(
          `  brain: ${brain.root}${agentConfig.drone.brain?.remote ? " (remote sync on)" : " (local only)"}\n`,
        );
      }
    }

    // ── The drone's alarm clock — self-scheduled exact wakes, brain-backed ──
    // (alarms.md survives restarts; the heartbeat loop honors it below).
    const alarms = brain ? makeAlarms({ brain }) : undefined;
    if (alarms) {
      const pending = yield* alarms.list;
      if (pending.length > 0) {
        process.stderr.write(
          `  alarms: ${pending.length} pending (next: ${pending[0]?.at.toISOString()})\n`,
        );
      }
    }

    // Track WebSocket state for heartbeats. Updated by the onStateChange
    // callback below and read by the heartbeat fiber.
    let currentWsState = "connecting";

    // Start WebSocket. onStateChange → JSONL state events; onDiag → all of
    // the deeper socket-lifecycle events that the SDK now exposes.
    const { connected } = yield* startLiveIngest({
      onStateChange: (state, info) => {
        currentWsState = state;
        lastWsTransitionAtMs = Date.now();
        log({
          type: "websocket_state",
          state,
          isReconnect: info.isReconnect,
        });
      },
      onDiag: onSocketDiag,
      logger: SdkLoggerLayer,
    }).pipe(Effect.catch(() => Effect.succeed({ connected: false })));
    currentWsState = connected ? "connected" : "disconnected";
    log({
      type: "websocket_state",
      state: connected ? "connected" : "disconnected",
    });
    process.stderr.write(`  websocket: ${connected ? "connected" : "failed"}\n\n`);

    // ── Heartbeat fiber: emit a state summary every 60s ──
    // Gives `kubectl logs -f` a consistent "is the bot alive?" signal even
    // during idle periods, plus visibility into encrypted-but-undecryptable
    // messages (the silent failure mode where the bot looks healthy but
    // can't actually respond to anyone in a particular conversation).
    const startupTime = Date.now();
    const heartbeatFiber = yield* Effect.forkScoped(
      Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep("60 seconds");
          try {
            const sdb = new Database(dbPath, { readonly: true });
            try {
              const convs = agentConfig.allowedConversationIds.map((id) => {
                const m = sdb
                  .query(
                    "SELECT COUNT(*) AS n FROM effect_messages WHERE conversation_id = ?",
                  )
                  .get(id) as { n: number } | undefined;
                const e = sdb
                  .query(
                    "SELECT COUNT(*) AS n FROM effect_messages WHERE conversation_id = ? AND status = 'encrypted'",
                  )
                  .get(id) as { n: number } | undefined;
                const k = sdb
                  .query(
                    "SELECT COUNT(*) AS n FROM effect_conversation_keys WHERE conversation_id = ?",
                  )
                  .get(id) as { n: number } | undefined;
                return {
                  conversationId: id,
                  messageCount: m?.n ?? 0,
                  encryptedCount: e?.n ?? 0,
                  ckeyCount: k?.n ?? 0,
                };
              });
              const now = Date.now();
              log({
                type: "health",
                uptimeSec: Math.floor((now - startupTime) / 1000),
                websocketState: currentWsState,
                totalMessages: convs.reduce((s, c) => s + c.messageCount, 0),
                totalEncrypted: convs.reduce((s, c) => s + c.encryptedCount, 0),
                totalCKeys: convs.reduce((s, c) => s + c.ckeyCount, 0),
                conversations: convs,
                framesReceived,
                bytesReceived,
                secondsSinceLastFrame:
                  lastFrameAtMs === 0 ? -1 : Math.floor((now - lastFrameAtMs) / 1000),
                secondsSinceLastWsTransition: Math.floor(
                  (now - lastWsTransitionAtMs) / 1000,
                ),
                secondsSinceLastSocketEvent: Math.floor(
                  (now - lastSocketEventAtMs) / 1000,
                ),
                lastSocketEventSubtype,
                keepalivesSent,
                keepalivesFailed,
                reconnectAttempts,
              });
            } finally {
              sdb.close();
            }
          } catch (e) {
            process.stderr.write(`[heartbeat] failed: ${e}\n`);
          }
        }
      }),
    );
    void heartbeatFiber;

    // Build mutable adapter config — fields are updated in-place by the file watcher
    const adapterConfig = {
      myUserId: userId,
      allowedConversationIds: agentConfig.allowedConversationIds,
      globalAdmins: agentConfig.globalAdmins,
      globalAdminToolkits: agentConfig.globalAdminToolkits,
      defaultConversationConfig: agentConfig.defaults,
      conversationConfig: agentConfig.conversations,
      botHandles: agentConfig.botHandles,
      accountDir,
      configVersion: 0,
      mechanics: buildMechanics(skills),
      brain,
      alarms,
      fallbackSoul: soulSeed({ botName: accountHandle, ownerName }),
      speakUnprompted: agentConfig.speakUnprompted ?? [],
    };

    // Heartbeat config holder — re-read by the clock every cycle, updated by
    // the file watcher below: enable/disable/retune is never a restart.
    let currentHeartbeatConfig = agentConfig.drone?.heartbeat;

    // Watch for config file changes and update adapter config in-place.
    // Every field hot-reloads, including allowedConversationIds: the bumped
    // configVersion wakes the adapter's reconcile loop, which forks watchers
    // for added conversation ids and interrupts watchers for removed ones.
    const stopWatching = watchAgentConfig(accountDir, (newConfig) => {
      try {
        adapterConfig.globalAdmins = newConfig.globalAdmins;
        adapterConfig.globalAdminToolkits = newConfig.globalAdminToolkits;
        adapterConfig.allowedConversationIds = newConfig.allowedConversationIds;
        adapterConfig.defaultConversationConfig = newConfig.defaults;
        adapterConfig.conversationConfig = newConfig.conversations;
        adapterConfig.botHandles = newConfig.botHandles;
        adapterConfig.speakUnprompted = newConfig.speakUnprompted ?? [];
        currentHeartbeatConfig = newConfig.drone?.heartbeat;
        adapterConfig.configVersion += 1;
        log({ type: "config_reload", success: true });
        process.stderr.write("[config] reloaded agent-config.json\n");
      } catch (e) {
        log({ type: "config_reload", success: false, error: String(e) });
        process.stderr.write(`[config] reload failed: ${e}\n`);
      }
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        stopWatching();
      }),
    );

    // Run XChat adapter + stdin adapter in parallel
    const xchatFiber = yield* Effect.forkScoped(xchatAdapter(adapterConfig));

    // ── The drone's clock (docs/drone-core-design.md, "The heartbeat") ──
    // Forked unconditionally; the loop re-reads config every cycle, so an
    // absent drone.heartbeat block just idle-skips until one appears.
    const wakeEyes = makeWakeEyes(adapterConfig);
    yield* Effect.forkScoped(
      heartbeatLoop({
        config: () => currentHeartbeatConfig,
        digest: wakeEyes.digest,
        speakable: wakeEyes.speakable,
        executeWake: makeExecuteWake(adapterConfig),
        alarms,
        log: (entry) => log(entry as unknown as Parameters<typeof log>[0]),
      }),
    );
    process.stderr.write(
      `  heartbeat: ${currentHeartbeatConfig ? `every ${currentHeartbeatConfig.intervalMinutes}m` : "idle (no drone.heartbeat config)"}, speakUnprompted: ${adapterConfig.speakUnprompted.length} room(s)\n`,
    );

    // Stdin adapter (interactive)
    if (process.stdin.isTTY) {
      yield* stdinAdapter({});
    } else {
      yield* Fiber.join(xchatFiber);
    }
  }).pipe(Effect.scoped);

  process.stderr.write(`  log level: ${resolvedSdkLogLevel} (XCHAT_LOG_LEVEL)\n`);
  if (!process.env.XAI_API_KEY) {
    process.stderr.write(
      "  ! XAI_API_KEY unset — booting without Grok (DM watch OK; model turns will fail)\n",
    );
  }

  Effect.runPromise(
    program.pipe(
      Effect.provide(ModelLayer),
      Effect.provide(XaiConfigLayer),
      Effect.provide(ChatPersistenceLayer),
      Effect.provide(PlatformLayer),
      Effect.provide(SdkLoggerLayer),
    ) as Effect.Effect<void>,
  ).catch((e) => {
    log({ type: "shutdown", reason: `crash: ${e}` });
    process.stderr.write(`Agent crashed: ${e}\n`);
    process.exit(1);
  });
} else {
  // Stdin-only mode
  const program = stdinAdapter({}).pipe(Effect.scoped);

  Effect.runPromise(
    program.pipe(
      Effect.provide(ModelLayer),
      Effect.provide(XaiConfigLayer),
      Effect.provide(ChatPersistenceLayer),
      Effect.provide(SdkLoggerLayer),
    ) as Effect.Effect<void>,
  ).catch((e) => {
    log({ type: "shutdown", reason: `crash: ${e}` });
    process.stderr.write(`Agent crashed: ${e}\n`);
    process.exit(1);
  });
}
