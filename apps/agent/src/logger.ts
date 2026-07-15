/**
 * logger.ts — Simple JSONL logger for the xchat agent.
 *
 * Writes one JSON object per line to ~/.xchat/accounts/{handle}/logs/agent-{date}.jsonl
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Cause, Layer, type LogLevel, Logger, References } from "effect";

// ── Log entry types ──

interface StartupEntry {
  readonly type: "startup";
  readonly accountHandle: string;
  readonly allowedConversationIds: readonly string[];
}

interface MessageReceivedEntry {
  readonly type: "message_received";
  readonly conversationId: string;
  readonly messageId: string;
  readonly senderId: string;
  readonly senderName: string;
  readonly text: string;
  readonly hasAttachment: boolean;
}

interface HistoryInjectedEntry {
  readonly type: "history_injected";
  readonly conversationId: string;
  readonly turnCount: number;
}

interface ToolCallEntry {
  readonly type: "tool_call";
  readonly conversationId: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly result: string;
  readonly success: boolean;
}

interface AgentResponseEntry {
  readonly type: "agent_response";
  readonly conversationId: string;
  readonly messages: string[];
  readonly tokenUsage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
  };
  readonly totalToolCalls?: number;
  readonly totalRounds?: number;
}

interface AgentErrorEntry {
  readonly type: "agent_error";
  readonly conversationId: string;
  /** The inbound message whose turn died (greppable per message). */
  readonly messageId?: string;
  readonly error: string;
}

/**
 * A whole turn failed and is about to be re-run once (45s later). Terminal
 * failure after the retry logs agent_error. Together with xai_retry this
 * makes provider trouble visible at both granularities: per-request churn
 * (xai_retry) and per-turn death/rebirth (turn_retry).
 */
interface TurnRetryEntry {
  readonly type: "turn_retry";
  readonly conversationId: string;
  readonly messageId: string;
  readonly error: string;
}

/**
 * The model ran one or more server-side searches (web_search / x_search)
 * inside a response. These execute on xAI's side and are otherwise invisible
 * in our logs — surfaced so "did it verify before answering?" is auditable.
 */
interface ModelSearchEntry {
  readonly type: "model_search";
  readonly calls: number;
}

interface MessageSkippedEntry {
  readonly type: "message_skipped";
  readonly conversationId: string;
  readonly messageId: string;
  readonly senderId: string;
  readonly reason: "own_message" | "empty" | "permission_denied" | "encrypted";
  /** For reason="encrypted": the ckey version the bot is missing. */
  readonly blockedByKey?: string;
}

interface PermissionCheckEntry {
  readonly type: "permission_check";
  readonly conversationId: string;
  readonly senderId: string;
  readonly senderRole: "admin" | "user";
  readonly effectiveConfig: {
    readonly respondTo: string;
    readonly trigger: string;
    readonly toolkits: unknown;
  };
  readonly isMention: boolean;
  readonly isReplyToBot: boolean;
  readonly allowed: boolean;
}

interface ConfigReloadEntry {
  readonly type: "config_reload";
  readonly success: boolean;
  readonly error?: string;
}

interface WebsocketStateEntry {
  readonly type: "websocket_state";
  readonly state: string;
  readonly isReconnect?: boolean;
}

/** The literal text the model produced in a single agent-loop round. */
interface AgentRoundTextEntry {
  readonly type: "agent_round_text";
  readonly conversationId: string;
  readonly round: number;
  readonly text: string;
}

interface AgentLoopRoundEntry {
  readonly type: "agent_loop_round";
  readonly conversationId: string;
  readonly round: number;
  readonly hasToolCalls: boolean;
  readonly hasPendingMedia: boolean;
  readonly textLength: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

interface MessageSentEntry {
  readonly type: "message_sent";
  readonly conversationId: string;
  readonly text: string;
  readonly replyTo?: string;
}

interface InboxSyncEntry {
  readonly type: "inbox_sync";
  readonly success: boolean;
  readonly error?: string;
}

interface InboxCatchUpEntry {
  readonly type: "inbox_catch_up";
  readonly success: boolean;
  readonly durationMs: number;
  readonly error?: string;
}

interface ConversationWatchEntry {
  readonly type: "conversation_watch";
  readonly conversationId: string;
  readonly lastSeenId: string;
  /** Number of conversation keys (CKeys) cached for this conv. 0 = bot can't decrypt. */
  readonly ckeyCount?: number;
  /** Number of messages already in the local DB for this conv. */
  readonly messageCount?: number;
  /** Number of messages stuck in `status: "encrypted"` for this conv. */
  readonly encryptedCount?: number;
}

/**
 * Periodic snapshot of agent health. Emitted every 60s so `kubectl logs`
 * always has a recent "is the bot alive?" answer without needing real DM
 * traffic. (Renamed from "heartbeat" when the drone's clock took that word —
 * grep for "health" now.)
 */
interface HealthEntry {
  readonly type: "health";
  readonly uptimeSec: number;
  readonly websocketState: string;
  /** Total messages ingested since startup. */
  readonly totalMessages: number;
  /** Across all allowlisted convs: stuck-encrypted messages. */
  readonly totalEncrypted: number;
  /** Across all allowlisted convs: total CKeys cached. */
  readonly totalCKeys: number;
  /** Counts per allowlisted conversation. */
  readonly conversations: ReadonlyArray<{
    readonly conversationId: string;
    readonly messageCount: number;
    readonly encryptedCount: number;
    readonly ckeyCount: number;
  }>;
  /** WebSocket-level frame counters (from the bottom of the SDK stack). */
  readonly framesReceived?: number;
  readonly bytesReceived?: number;
  /** Seconds since the last WebSocket frame was decoded. High value = stale. */
  readonly secondsSinceLastFrame?: number;
  /** Seconds since the last WebSocket state transition (connect/disconnect). */
  readonly secondsSinceLastWsTransition?: number;
  /** Total keepalive frames sent + the count that failed to write. */
  readonly keepalivesSent?: number;
  readonly keepalivesFailed?: number;
  /** Total reconnect attempts (across the bot's whole lifetime). */
  readonly reconnectAttempts?: number;
  /**
   * Seconds since any kind of socket event fired (server ping, keepalive,
   * SocketLoop transition, etc.). During normal operation should never
   * exceed ~30s — anything higher means the socket is wedged.
   */
  readonly secondsSinceLastSocketEvent?: number;
  /** The subtype of that last socket event — context for diagnosis. */
  readonly lastSocketEventSubtype?: string;
}

/**
 * Catch-all entry for SDK-internal socket events. Subtype enumerates every
 * lifecycle point we care about; the rest of the fields are subtype-specific.
 * Filter live with: `grep '"type":"socket_event"'`
 */
export interface SocketEventEntry {
  readonly type: "socket_event";
  readonly subtype: // ── ProxiedWebSocket (HTTP-CONNECT tunnel; only in k8s) ──
    | "proxy_tcp_connecting"
    | "proxy_tcp_connected"
    | "proxy_connect_response"
    | "tls_handshake_start"
    | "tls_handshake_complete"
    | "ws_upgrade_sent"
    | "ws_upgrade_response"
    | "ws_open"
    | "ws_server_ping"
    | "ws_socket_end"
    | "ws_socket_close"
    | "ws_socket_error"
    | "ws_frame_decoder_error"
    // ── SocketLoop (Effect connect/run/reconnect machinery) ──
    | "loop_attempt_started"
    | "loop_token_fetched"
    | "loop_token_failed"
    | "loop_connect_failed"
    | "loop_connected"
    | "loop_closed"
    | "loop_giving_up"
    | "loop_blocked"
    // ── BunWebSocketListener keepalive ──
    | "keepalive_sent"
    | "keepalive_failed";
  /** Common: ms since process start, so we can read absolute timings without parsing timestamps. */
  readonly tProcessMs: number;
  /** Free-form subtype-specific payload. Stable keys per subtype, but typed loose to keep this entry simple. */
  // biome-ignore lint/suspicious/noExplicitAny: subtype-specific payload — keys documented in main.ts dispatch
  readonly [key: string]: any;
}

interface TypingIndicatorEntry {
  readonly type: "typing_indicator";
  readonly conversationId: string;
  readonly action: "start" | "stop";
}

interface MediaDownloadEntry {
  readonly type: "media_download";
  readonly conversationId: string;
  readonly mediaKey: string;
  readonly mediaType: string | null;
  readonly mimeType: string;
  readonly success: boolean;
  readonly error?: string;
}

interface SessionCreatedEntry {
  readonly type: "session_created";
  readonly conversationId: string;
}

interface SafetyJudgeVerdictEntry {
  readonly type: "safety_judge_verdict";
  readonly toolName: string;
  readonly safe: boolean;
  readonly reason?: string;
}

interface ShutdownEntry {
  readonly type: "shutdown";
  readonly reason: string;
}

interface AgentLoopExhaustedEntry {
  readonly type: "agent_loop_exhausted";
  readonly conversationId: string;
  readonly maxRounds: number;
  readonly totalToolCalls: number;
}

interface ToolBlockedEntry {
  readonly type: "tool_blocked";
  readonly toolName: string;
  readonly reason: "toolkit_not_enabled";
  readonly toolkit: string;
}

interface MessageSendFailedEntry {
  readonly type: "message_send_failed";
  readonly conversationId: string;
  readonly error: string;
}

/** A clock wake fired (drone-core heartbeatLoop). */
interface HeartbeatWakeEntry {
  readonly type: "heartbeat_wake";
  readonly seq: number;
  /** ms since the previous wake. */
  readonly sinceLast: number;
  readonly digestBytes: number;
  readonly speakableRooms: number;
  /** Reasons of self-scheduled alarms that fired this wake (absent = tick). */
  readonly alarms?: ReadonlyArray<string>;
}

/** The mandatory capture pass that precedes a wake turn (non-empty digest). */
interface HeartbeatCaptureEntry {
  readonly type: "heartbeat_capture";
  readonly seq: number;
  readonly toolCalls: number;
  readonly rounds: number;
  readonly tokens: number;
}

/** What a clock wake did. Sends show up separately as tool_call/message_sent. */
interface HeartbeatResultEntry {
  readonly type: "heartbeat_result";
  readonly seq: number;
  /** Terminal text parts the turn produced — all suppressed (two-mouths rule). */
  readonly suppressedTextParts: number;
  readonly toolCalls: number;
  readonly rounds: number;
  readonly tokens: number;
}

/** A wake was skipped (quiet hours). Disabled config idles silently. */
interface HeartbeatSkippedEntry {
  readonly type: "heartbeat_skipped";
  readonly reason: "quiet_hours";
}

/**
 * Brain lifecycle entries, emitted by drone-core's BrainService through the
 * injected logger. Field shapes are core-owned (see the observability table
 * in docs/drone-core-design.md); typed loose here on purpose.
 */
interface BrainLogEntry {
  readonly type:
    | "brain_seeded"
    | "brain_write"
    | "brain_sync"
    | "brain_conflict"
    | "brain_push_failed"
    | "brain_read_failed"
    | "brain_boot_failed";
  // biome-ignore lint/suspicious/noExplicitAny: core-owned payloads
  readonly [key: string]: any;
}

/**
 * Per-turn context-size guardrail: how big the assembled persona (mechanics +
 * soul + ambient memory) was. The context window is the real budget — watch
 * this for runaway brain files (docs/drone-core-design.md, "Performance").
 */
interface TurnContextEntry {
  readonly type: "turn_context";
  readonly conversationId: string;
  readonly personaBytes: number;
  readonly memoryBytes: number;
  /** The person files injected this turn. */
  readonly files: readonly string[];
}

/**
 * Result of reconciling the watcher fiber set against a reloaded allowlist.
 * Emitted only when the reconcile actually changed something. A conversation
 * id appearing in `added` means its watcher attached live — no restart.
 */
interface WatcherReconcileEntry {
  readonly type: "watcher_reconcile";
  /** Conversation ids whose watchers were started by this reconcile. */
  readonly added: readonly string[];
  /** Conversation ids whose watchers were interrupted by this reconcile. */
  readonly removed: readonly string[];
  /** All conversation ids with an active watcher after this reconcile. */
  readonly watching: readonly string[];
}

/**
 * A log line forwarded out of the xchat-sdk's Effect logger. This is the bridge
 * that surfaces the SDK's internal pipeline logging (frame decode, CKey
 * resolution, decrypt, signing, mutation/send) into the agent's JSONL stream.
 *
 * Without this, every `Effect.log*` call inside the SDK is invisible — the
 * live frame path explicitly installed a silent logger. `level` is the Effect
 * LogLevel ("Debug"|"Info"|"Warn"|...), `message` is the rendered log message,
 * and `annotations` carries the structured fields attached via
 * `Effect.annotateLogs` at each chokepoint (phase, convId, messageId,
 * sigStatus, ckeyVersion, etc.). Filter live with `grep '"type":"sdk_log"'`.
 */
interface SdkLogEntry {
  readonly type: "sdk_log";
  readonly level: string;
  readonly message: string;
  readonly annotations?: Record<string, unknown>;
  /** Rendered failure cause, present only when the log carried an error/defect. */
  readonly cause?: string;
}

/**
 * One transient xAI failure that the model layer is about to retry (or has
 * just exhausted retries on). Without this, retries are invisible: a turn
 * that survived three 429s and a turn that sailed through look identical,
 * and a turn that DIED of capacity errors leaves only a terse agent_error.
 * Filter live with `grep '"type":"xai_retry"'`; `final: true` means retries
 * are exhausted and the turn is about to fail.
 */
interface XaiRetryEntry {
  readonly type: "xai_retry";
  /** 1-based attempt number that just failed. */
  readonly attempt: number;
  /** HTTP status when the failure was an xAI response (429, 500, ...). */
  readonly status?: number;
  /** Truncated provider error body / transport error tag. */
  readonly error: string;
  /** True when the retry budget is spent — this failure is terminal. */
  readonly final: boolean;
}

export type LogEntry =
  | StartupEntry
  | MessageReceivedEntry
  | HistoryInjectedEntry
  | ToolCallEntry
  | AgentResponseEntry
  | AgentErrorEntry
  | MessageSkippedEntry
  | PermissionCheckEntry
  | ConfigReloadEntry
  | WebsocketStateEntry
  | AgentLoopRoundEntry
  | AgentRoundTextEntry
  | MessageSentEntry
  | InboxSyncEntry
  | InboxCatchUpEntry
  | ConversationWatchEntry
  | TypingIndicatorEntry
  | MediaDownloadEntry
  | SessionCreatedEntry
  | SafetyJudgeVerdictEntry
  | ShutdownEntry
  | AgentLoopExhaustedEntry
  | ToolBlockedEntry
  | MessageSendFailedEntry
  | WatcherReconcileEntry
  | TurnContextEntry
  | BrainLogEntry
  | HealthEntry
  | HeartbeatWakeEntry
  | HeartbeatCaptureEntry
  | HeartbeatResultEntry
  | HeartbeatSkippedEntry
  | SocketEventEntry
  | XaiRetryEntry
  | TurnRetryEntry
  | ModelSearchEntry
  | SdkLogEntry;

// ── State ──

let logFilePath: string | null = null;

// ── Public API ──

/**
 * Initialize the logger. Creates the logs directory and returns the log file path.
 */
export function initLogger(accountHandle: string): string {
  const home = process.env.HOME ?? "/tmp";
  const logsDir = resolve(home, ".xchat/accounts", accountHandle, "logs");
  mkdirSync(logsDir, { recursive: true });

  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  logFilePath = resolve(logsDir, `agent-${iso}.jsonl`);
  return logFilePath;
}

/**
 * Append a log entry as a single JSON line.
 *
 * Writes to the per-account JSONL file on disk, and also tees to stdout so
 * `kubectl logs` (or any process supervisor) sees the same stream.
 */
export function log(entry: LogEntry): void {
  const line = JSON.stringify({ ...entry, timestamp: new Date().toISOString() });
  process.stdout.write(`${line}\n`);
  if (logFilePath) appendFileSync(logFilePath, `${line}\n`);
}

// ── SDK Effect-logger bridge ──

const VALID_LEVELS: ReadonlySet<string> = new Set([
  "All",
  "Fatal",
  "Error",
  "Warn",
  "Info",
  "Debug",
  "Trace",
  "None",
]);

/**
 * Parse XCHAT_LOG_LEVEL into an Effect LogLevel. Accepts the Effect level names
 * case-insensitively, tolerates the common "Warning"/"Verbose" aliases, and
 * defaults to "Debug" (this build is intentionally verbose). Returning a high
 * floor like "None" is allowed so an operator can mute the firehose live via
 * a redeploy without a code change.
 */
function parseLogLevel(raw: string | undefined): LogLevel.LogLevel {
  if (!raw) return "Debug";
  const v = raw.trim().toLowerCase();
  if (v === "warning") return "Warn";
  if (v === "verbose") return "Trace";
  for (const level of VALID_LEVELS) {
    if (level.toLowerCase() === v) return level as LogLevel.LogLevel;
  }
  return "Debug";
}

/** Render an Effect log message (string | array | object) to a single string. */
function renderMessage(message: unknown): string {
  if (typeof message === "string") return message;
  if (Array.isArray(message)) {
    return message.map((m) => (typeof m === "string" ? m : safeStringify(m))).join(" ");
  }
  return safeStringify(message);
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Build the Effect Logger layer that forwards every SDK `Effect.log*` call into
 * the agent's JSONL stream as a `sdk_log` entry. Replaces Effect's default
 * (console logfmt) logger so we get one consistent machine-parseable stream,
 * and sets the minimum log level from XCHAT_LOG_LEVEL.
 *
 * Provide this to the main program AND hand it to `startLiveIngest({ logger })`
 * so the live WebSocket frame path (otherwise silenced) is captured too.
 */
export function makeSdkLoggerLayer(): Layer.Layer<never> {
  const sdkLogger = Logger.make((options) => {
    const annotations = options.fiber.getRef(References.CurrentLogAnnotations) as
      | Record<string, unknown>
      | undefined;
    const hasAnnotations = annotations != null && Object.keys(annotations).length > 0;
    const hasCause = Cause.hasFails(options.cause) || Cause.hasDies(options.cause);
    log({
      type: "sdk_log",
      level: String(options.logLevel),
      message: renderMessage(options.message),
      ...(hasAnnotations ? { annotations } : {}),
      ...(hasCause ? { cause: Cause.pretty(options.cause) } : {}),
    });
  });

  return Logger.layer([sdkLogger]).pipe(
    Layer.provideMerge(
      Layer.succeed(
        References.MinimumLogLevel,
        parseLogLevel(process.env.XCHAT_LOG_LEVEL),
      ),
    ),
  );
}

/** The Effect LogLevel resolved from XCHAT_LOG_LEVEL (exported for reuse/tests). */
export const resolvedSdkLogLevel: LogLevel.LogLevel = parseLogLevel(
  process.env.XCHAT_LOG_LEVEL,
);
