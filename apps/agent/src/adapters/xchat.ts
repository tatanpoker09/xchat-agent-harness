import { Database } from "bun:sqlite";
import { Chat, ConversationId } from "@x-chat/xchat-sdk";
import type { Message, UserData } from "@x-chat/xchat-sdk";
/**
 * xchat.ts — XChat adapter.
 * Listens for incoming messages on each allowlisted conversation,
 * runs the agent, sends replies.
 * Handles mark-as-read and typing indicators for good UX.
 */
import { Cause, Deferred, Effect, Fiber, Layer, Ref, Schedule, Stream } from "effect";
import { Chat as AiChat, Prompt } from "effect/unstable/ai";

/**
 * Read lightweight per-conversation stats directly from dm.sqlite.
 * Opens a fresh readonly connection each call — cheap (SQLite has no
 * connection overhead), and keeps us out of the SDK's write path.
 */
const readConversationStats = (
  convId: string,
): { messageCount: number; encryptedCount: number; ckeyCount: number } => {
  const dbPath = process.env.XCHAT_DB_PATH;
  if (!dbPath) return { messageCount: 0, encryptedCount: 0, ckeyCount: 0 };
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const m = db
        .query("SELECT COUNT(*) AS n FROM effect_messages WHERE conversation_id = ?")
        .get(convId) as { n: number } | undefined;
      const e = db
        .query(
          "SELECT COUNT(*) AS n FROM effect_messages WHERE conversation_id = ? AND status = 'encrypted'",
        )
        .get(convId) as { n: number } | undefined;
      const k = db
        .query(
          "SELECT COUNT(*) AS n FROM effect_conversation_keys WHERE conversation_id = ?",
        )
        .get(convId) as { n: number } | undefined;
      return {
        messageCount: m?.n ?? 0,
        encryptedCount: e?.n ?? 0,
        ckeyCount: k?.n ?? 0,
      };
    } finally {
      db.close();
    }
  } catch {
    return { messageCount: 0, encryptedCount: 0, ckeyCount: 0 };
  }
};

import {
  type AlarmsApi,
  type BrainApi,
  type PendingMedia,
  type WakeOutcome,
  buildPersona,
  run,
} from "@x-chat/drone-core";
import { XaiConfig } from "../XaiConfig.js";
import * as XaiLanguageModel from "../XaiLanguageModel.js";
import { type LogEntry, log } from "../logger.js";
import {
  ChatExecutor,
  QuoteExecutor,
  ShellExecutor,
  XaiMediaExecutor,
} from "../tools/executors/index.js";
import { AgentToolkit, makeToolkitLayer } from "../tools/xchat-tools.js";
import { attachmentAnnotations, attachmentDescriptor } from "./annotate.js";
import { sanitizeOutboundText } from "./sanitize.js";

// ── Typing indicator loop ──

/** Start a typing indicator that fires every 4s until stopped. */
const startTypingLoop = (conversationId: ConversationId) =>
  Effect.gen(function* () {
    yield* Chat.conversation
      .sendTyping(conversationId)
      .pipe(Effect.catch(() => Effect.void));

    const fiber = yield* Effect.forever(
      Effect.gen(function* () {
        yield* Effect.sleep("4 seconds");
        yield* Chat.conversation
          .sendTyping(conversationId)
          .pipe(Effect.catch(() => Effect.void));
      }),
    ).pipe(Effect.forkScoped);

    return Effect.gen(function* () {
      yield* Fiber.interrupt(fiber);
    });
  });

// ── Conversation history injection ──

/**
 * Inject XChat conversation history as proper user/assistant Prompt messages
 * into the chat session's history Ref.
 *
 * This lets the model see a natural conversation flow instead of a text blob.
 * Messages from the bot become "assistant" messages; messages from others
 * become "user" messages (prefixed with sender name for attribution).
 */
const injectConversationHistory = (
  conversationId: ConversationId,
  convId: string,
  triggeringMsgId: string,
  myUserId: string,
  chatSession: AiChat.Service,
) =>
  Effect.gen(function* () {
    const recent = yield* Chat.messages
      .list(conversationId, { limit: 20 })
      .pipe(
        Effect.catch(() => Effect.succeed({ messages: [] as ReadonlyArray<Message> })),
      );

    const msgs = recent.messages;
    if (msgs.length === 0) return 0;

    // Resolve sender names
    const allIds = new Set<string>();
    for (const m of msgs) {
      if (m.sender?.id) allIds.add(m.sender.id);
      for (const r of m.reactions) {
        if (r.senderId) allIds.add(r.senderId);
      }
    }
    const userMap = yield* Chat.users
      .getMany([...allIds])
      .pipe(Effect.catch(() => Effect.succeed(new Map<string, UserData>())));

    // Build Prompt messages in chronological order, excluding triggering message
    const ordered = [...msgs].reverse().filter((m) => m.id !== triggeringMsgId);
    if (ordered.length === 0) return;

    // Build message texts grouped by role, merging consecutive same-role messages.
    // The Responses API expects alternating user/assistant turns.
    const turns: Array<{ role: "user" | "assistant"; text: string }> = [];

    for (const msg of ordered) {
      const senderId = msg.sender?.id ?? "unknown";
      const isBot = senderId === myUserId;
      const role: "user" | "assistant" = isBot ? "assistant" : "user";

      // Build the message with forwarded content ABOVE the main text when present
      let prefix = "";
      const mainText = msg.text ?? "";

      if (!isBot) {
        const userData = userMap.get(senderId);
        const senderName = userData?.name ?? userData?.screenName ?? senderId;
        prefix = `${senderName} [msg:${msg.id}]:`;
      } else {
        prefix = `[msg:${msg.id}]`;
      }

      let textContent: string;
      if (msg.isForwarded && msg.forwardedText) {
        textContent = `${prefix}\n[forwarded: ${msg.forwardedText}]\n${mainText}`;
      } else {
        textContent = `${prefix} ${mainText}`;
      }

      // Annotate reply context
      if (msg.replyTo) {
        const replySender = msg.replyTo.senderName ?? "someone";
        const replyPreview = msg.replyTo.previewText ?? "";
        let replyAnnotation = `[replying to ${replySender}: "${replyPreview}"`;
        const repliedMsg = msgs.find((m) => m.id === msg.replyTo?.messageSequenceId);
        if (repliedMsg?.attachment) {
          replyAnnotation += `, ${attachmentDescriptor(repliedMsg.attachment, convId)}`;
        }
        textContent += `\n${replyAnnotation}]`;
      }

      // Annotate attachments — a single message can carry SEVERAL (e.g. 2–4
      // photos in one DM), so surface every one (not just the first).
      const histAttachments = msg.attachments ?? (msg.attachment ? [msg.attachment] : []);
      const histAttachmentBlock = attachmentAnnotations(histAttachments, convId);
      if (histAttachmentBlock) {
        textContent += `\n${histAttachmentBlock}`;
      }

      // Annotate reactions
      if (msg.reactions.length > 0) {
        const reactionParts = msg.reactions.map((r) => {
          const u = userMap.get(r.senderId);
          const name = u?.name ?? u?.screenName ?? r.senderName;
          return `${r.emoji} from ${name}`;
        });
        textContent += `\n[reactions: ${reactionParts.join(", ")}]`;
      }

      if (!textContent.trim()) continue;

      // Merge consecutive same-role messages into one turn
      const lastTurn = turns[turns.length - 1];
      if (lastTurn && lastTurn.role === role) {
        lastTurn.text += `\n${textContent}`;
      } else {
        turns.push({ role, text: textContent });
      }
    }

    if (turns.length === 0) return 0;

    // Build Prompt messages from merged turns
    const promptMessages = turns.map((turn) =>
      Prompt.makeMessage(turn.role, {
        content: [Prompt.makePart("text", { text: turn.text })],
      }),
    );

    // Inject into chat history
    const historyPrompt = Prompt.fromMessages(promptMessages);
    yield* Ref.update(chatSession.history, (current) =>
      Prompt.concat(current, historyPrompt),
    );

    return turns.length;
  });

// ── Permission types ──

export type RespondTo = "everyone" | "admins_only";
/**
 * - all_messages: every message (expensive; model must NO_REPLY)
 * - mention_only: @handle or reply-to-bot only
 * - addressed: @handle, bare name, reply-to-bot, 1:1, or continuation with the bot
 *   (not side-talk about the bot). Prefer this — saves tokens vs all_messages.
 */
export type Trigger = "all_messages" | "mention_only" | "addressed";
export type UserRole = "admin" | "user";

export interface ConversationConfig {
  readonly respondTo?: RespondTo;
  readonly trigger?: Trigger;
  readonly toolkits?:
    | readonly string[]
    | { readonly admin: readonly string[]; readonly user: readonly string[] };
  readonly admins?: readonly string[];
}

export interface XChatAdapterConfig {
  readonly myUserId: string;
  allowedConversationIds: readonly string[];
  globalAdmins: readonly string[];
  globalAdminToolkits?: readonly string[];
  defaultConversationConfig: ConversationConfig;
  conversationConfig?: Record<string, ConversationConfig>;
  botHandles?: readonly string[];
  readonly accountDir?: string;
  /**
   * Bumped by the config file watcher (bin/main.ts) on every reload. The
   * adapter's reconcile loop watches this to add/remove conversation
   * watchers live — allowlist changes never require a restart.
   */
  configVersion: number;
  /** The channel's mechanics prompt (built once at boot with the skills index). */
  readonly mechanics: string;
  /** The drone's brain — absent in brainless deployments (no `drone` config). */
  readonly brain?: BrainApi;
  /** The drone's alarm clock (self-scheduled exact wakes) — requires a brain. */
  readonly alarms?: AlarmsApi;
  /** Fallback soul when no brain is configured (the seed) — keeps personality. */
  readonly fallbackSoul: string;
  /**
   * CHANNEL config: where the drone may speak with no inbound message (the
   * proactivity blast radius). Updated in place on config reload — wake
   * turns read it fresh, so edits hot-apply. Default [].
   */
  speakUnprompted: readonly string[];
}

// ── Permission helpers (pure, exported for unit testing) ──

/** Resolve the effective config for a conversation. */
export const resolveConversationConfig = (
  defaultConfig: ConversationConfig,
  conversationConfig: Record<string, ConversationConfig> | undefined,
  convId: string,
  runtimeOverrides?: Map<string, Partial<ConversationConfig>>,
): {
  respondTo: RespondTo;
  trigger: Trigger;
  toolkits:
    | readonly string[]
    | { readonly admin: readonly string[]; readonly user: readonly string[] };
  admins: readonly string[];
} => {
  const static_ = conversationConfig?.[convId];
  const runtime = runtimeOverrides?.get(convId);
  return {
    respondTo:
      runtime?.respondTo ?? static_?.respondTo ?? defaultConfig.respondTo ?? "everyone",
    trigger:
      runtime?.trigger ?? static_?.trigger ?? defaultConfig.trigger ?? "addressed",
    toolkits: runtime?.toolkits ??
      static_?.toolkits ??
      defaultConfig.toolkits ?? ["xchat"],
    admins: static_?.admins ?? defaultConfig.admins ?? [],
  };
};

/** Determine a user's role. */
export const resolveUserRole = (
  senderId: string,
  globalAdmins: readonly string[],
  conversationAdmins: readonly string[],
): UserRole =>
  globalAdmins.includes(senderId) || conversationAdmins.includes(senderId)
    ? "admin"
    : "user";

/** Resolve enabled toolkits for a role. */
export const resolveToolkits = (
  toolkits:
    | readonly string[]
    | { readonly admin: readonly string[]; readonly user: readonly string[] },
  role: UserRole,
  isGlobalAdmin = false,
  globalAdminToolkits?: readonly string[],
): ReadonlySet<string> => {
  if (isGlobalAdmin && globalAdminToolkits && globalAdminToolkits.length > 0) {
    return new Set(globalAdminToolkits);
  }
  if (Array.isArray(toolkits)) return new Set(toolkits);
  const roleToolkits = toolkits as {
    readonly admin: readonly string[];
    readonly user: readonly string[];
  };
  return new Set(role === "admin" ? roleToolkits.admin : roleToolkits.user);
};

/** Check if bot should respond given the two-axis filters. */
export const shouldRespond = (
  respondTo: RespondTo,
  trigger: Trigger,
  senderRole: UserRole,
  isAddressed: boolean,
): boolean => {
  if (respondTo === "admins_only" && senderRole !== "admin") return false;
  if (trigger === "mention_only" && !isAddressed) return false;
  if (trigger === "addressed" && !isAddressed) return false;
  return true;
};

/** 1:1 ids are colon-form lower:higher (never g…). */
export const isOneToOneConversation = (convId: string): boolean =>
  /^\d+:\d+$/.test(convId);

/** Check if a message contains a bot @mention. */
export const isBotMention = (text: string, botHandles: readonly string[]): boolean =>
  botHandles.some((handle) => text.toLowerCase().includes(`@${handle.toLowerCase()}`));

/**
 * Called by name without @ — word-boundary match on handles + display aliases
 * (e.g. "journey bot", "tatanbotter").
 */
export const isBotNameCall = (
  text: string,
  botHandles: readonly string[],
  extraNames: readonly string[] = ["journey bot", "journeybot", "tatanbot"],
): boolean => {
  const lower = text.toLowerCase();
  const names = [
    ...botHandles.map((h) => h.toLowerCase()),
    ...extraNames.map((n) => n.toLowerCase()),
  ];
  for (const name of names) {
    if (!name) continue;
    // multi-word: substring with flexible spaces
    if (name.includes(" ")) {
      const pat = name.replace(/\s+/g, "\\s+");
      if (new RegExp(`(?:^|[^\\w@])${pat}(?:$|[^\\w])`, "i").test(lower)) return true;
      continue;
    }
    if (new RegExp(`(?:^|[^\\w@])${escapeRegExp(name)}(?:$|[^\\w])`, "i").test(lower)) {
      return true;
    }
  }
  return false;
};

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Side-talk *about* the bot (or narrating it to someone else) — not addressed
 * to the bot. Spanish/English group banter patterns.
 */
export const isSideTalkAboutBot = (text: string): boolean => {
  const t = text.toLowerCase();
  const patterns = [
    /\bte tiene\b/, // "te tiene de hijo" → to another human
    /\btiene de hijo\b/,
    /\bno cach[oó]\b/,
    /\ble hablaste\b/,
    /\ba\s+[eé]l\b/,
    /\bel we[oó]n\b/,
    /\bel bot\b/,
    /\bni se inmut/,
    /\bte lo dije\b/,
    /\bmir[aá]\s+lo que\b/,
    /\bpor qu[eé] me tratas\b/, // seba to bot after roast — actually this IS to bot
  ];
  // "por qué me tratas" is TO the bot — don't treat as side talk
  if (/\b(por qu[eé]|why)\s+me\s+trat/i.test(t)) return false;
  return patterns.some((p) => p.test(t));
};

/**
 * Continuation of a thread *with* the bot: bot spoke recently, and only the
 * current sender has been talking since (not a multi-human side channel).
 */
export const isConversationContinuation = (
  recentChronological: ReadonlyArray<{ senderId: string }>,
  myUserId: string,
  currentSenderId: string,
): boolean => {
  if (recentChronological.length === 0) return false;
  // Find last bot message in the window (excluding the current uncommitted msg
  // if present as last — caller should pass history *before* current).
  let lastBot = -1;
  for (let i = recentChronological.length - 1; i >= 0; i--) {
    if (recentChronological[i]?.senderId === myUserId) {
      lastBot = i;
      break;
    }
  }
  if (lastBot < 0) return false;
  // Bot message too far back → not "ongoing"
  if (recentChronological.length - 1 - lastBot > 4) return false;
  const after = recentChronological.slice(lastBot + 1);
  // Only current sender (and maybe bot, already excluded) between bot and now
  for (const m of after) {
    if (m.senderId !== currentSenderId && m.senderId !== myUserId) return false;
  }
  return true;
};

/**
 * Whether the bot should wake for this message under trigger=addressed|mention_only.
 * mention_only only uses @ / reply; addressed also allows name + continuation.
 */
export const isAddressedToBot = (options: {
  readonly text: string;
  readonly convId: string;
  readonly myUserId: string;
  readonly senderId: string;
  readonly botHandles: readonly string[];
  readonly isReplyToBot: boolean;
  readonly trigger: Trigger;
  /** Prior messages oldest→newest, not including the current message. */
  readonly recentChronological?: ReadonlyArray<{ senderId: string }>;
}): boolean => {
  const {
    text,
    convId,
    myUserId,
    senderId,
    botHandles,
    isReplyToBot,
    trigger,
    recentChronological = [],
  } = options;

  // 1:1 is always "addressed"
  if (isOneToOneConversation(convId)) return true;

  if (isBotMention(text, botHandles) || isReplyToBot) return true;

  if (trigger === "mention_only") return false;

  // trigger === "addressed" (or all_messages callers won't use this)
  if (isSideTalkAboutBot(text)) return false;
  if (isBotNameCall(text, botHandles)) return true;
  if (
    isConversationContinuation(recentChronological, myUserId, senderId) &&
    !isSideTalkAboutBot(text)
  ) {
    return true;
  }
  return false;
};

/** Default interval between catch-up polls (10 minutes). */
export const DEFAULT_CATCH_UP_INTERVAL_MS = 600_000;

/**
 * Lower bound on the poll interval (30s). Guards against a misconfigured
 * `XCHAT_CATCH_UP_INTERVAL_MS` (e.g. `100`) hammering the backend with
 * `catchUp` GraphQL + ingest many times a second. `catchUp` is a safety net,
 * not a real-time path, so sub-30s polling is never wanted.
 */
export const MIN_CATCH_UP_INTERVAL_MS = 30_000;

/**
 * Resolve the catch-up poll interval (ms) from `XCHAT_CATCH_UP_INTERVAL_MS`.
 *
 * - unset / blank / non-numeric / negative → default (10 min)
 * - `0` → disabled (caller skips the poll)
 * - positive but below the 30s floor → clamped to 30s
 * - otherwise → that many ms (floored to an integer)
 */
export const resolveCatchUpIntervalMs = (raw: string | undefined): number => {
  if (raw === undefined || raw.trim() === "") return DEFAULT_CATCH_UP_INTERVAL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_CATCH_UP_INTERVAL_MS;
  if (n === 0) return 0; // explicitly disabled
  return Math.max(MIN_CATCH_UP_INTERVAL_MS, Math.floor(n));
};

/**
 * Watch a single conversation's message stream and respond to new messages.
 */
const watchConversation = (
  convId: string,
  config: XChatAdapterConfig,
  conversationSessions: Map<string, { session: AiChat.Service; lastResponseId?: string }>,
  runtimeOverrides: Map<string, Partial<ConversationConfig>>,
) =>
  Effect.gen(function* () {
    const _xaiConfig = yield* XaiConfig;
    const conversationId = ConversationId.make(convId);
    const { myUserId } = config;

    // Get current latest message ID so we skip everything before startup
    const initial = yield* Chat.messages
      .list(conversationId, { limit: 1 })
      .pipe(
        Effect.catch(() => Effect.succeed({ messages: [] as Array<{ id: string }> })),
      );
    let lastSeenId = initial.messages[0]?.id ?? "0";

    // Pull lightweight per-conv health stats so startup logs show whether
    // we can actually decrypt anything in this conversation. Most painful
    // failure mode: bot is "watching" a group but has 0 CKeys for it.
    const { messageCount, encryptedCount, ckeyCount } = readConversationStats(convId);

    log({
      type: "conversation_watch",
      conversationId: convId,
      lastSeenId,
      ckeyCount,
      messageCount,
      encryptedCount,
    });

    process.stderr.write(
      `[xchat] watching ${convId} (last: ${lastSeenId}, msgs: ${messageCount}, ckeys: ${ckeyCount}` +
        `${encryptedCount > 0 ? `, ⚠ ${encryptedCount} undecryptable` : ""})\n`,
    );

    // Stream messages — emits on every change (new message, edit, reaction, etc.)
    yield* Chat.messages.stream(conversationId).pipe(
      Stream.runForEach((result) =>
        Effect.gen(function* () {
          const latestMsg = result.messages[0];
          if (!latestMsg) return;

          // Skip if we already saw this message
          if (latestMsg.id === lastSeenId) return;
          // Skip if this is older (shouldn't happen with stream, but safety)
          if (BigInt(latestMsg.id) <= BigInt(lastSeenId)) return;

          lastSeenId = latestMsg.id;

          // Skip own messages
          if (latestMsg.sender?.id === myUserId) {
            log({
              type: "message_skipped",
              conversationId: convId,
              messageId: latestMsg.id,
              senderId: latestMsg.sender?.id ?? "unknown",
              reason: "own_message",
            });
            return;
          }

          const text = latestMsg.text ?? "";
          const hasAttachment = !!latestMsg.attachment;
          if (!text && !hasAttachment) {
            // Distinguish "actually empty" from "couldn't decrypt" — the
            // latter is a silent failure mode where the bot looks fine but
            // can never respond to this user. Check the raw row directly.
            const dbPath = process.env.XCHAT_DB_PATH;
            let reason: "empty" | "encrypted" = "empty";
            let blockedByKey: string | undefined;
            if (dbPath) {
              try {
                const db = new Database(dbPath, { readonly: true });
                try {
                  const row = db
                    .query(
                      "SELECT status, blocked_by_key FROM effect_messages WHERE conversation_id = ? AND sequence_id = ?",
                    )
                    .get(convId, latestMsg.id) as
                    | { status?: string; blocked_by_key?: string | null }
                    | undefined;
                  if (row?.status === "encrypted") {
                    reason = "encrypted";
                    blockedByKey = row.blocked_by_key ?? undefined;
                  }
                } finally {
                  db.close();
                }
              } catch {
                /* ignore — fall back to "empty" */
              }
            }
            log({
              type: "message_skipped",
              conversationId: convId,
              messageId: latestMsg.id,
              senderId: latestMsg.sender?.id ?? "unknown",
              reason,
              ...(blockedByKey ? { blockedByKey } : {}),
            });
            return;
          }

          const senderId = latestMsg.sender?.id ?? "unknown";
          const senderName = senderId;
          log({
            type: "message_received",
            conversationId: convId,
            messageId: latestMsg.id,
            senderId,
            senderName,
            text,
            hasAttachment,
          });

          process.stderr.write(`[xchat] ◀ ${convId} "${text.slice(0, 80)}"\n`);

          // Resolve permission config
          const effectiveConfig = resolveConversationConfig(
            config.defaultConversationConfig,
            config.conversationConfig,
            convId,
            runtimeOverrides,
          );
          const senderRole = resolveUserRole(
            senderId,
            config.globalAdmins,
            effectiveConfig.admins,
          );

          // Address detection — skip model when not for us (token saver).
          const botHandles = config.botHandles ?? [];
          const mentionInText = isBotMention(text, botHandles);
          let isReplyToBot = false;
          if (latestMsg.replyTo?.messageSequenceId) {
            const repliedMsg = yield* Chat.messages
              .get(conversationId, latestMsg.replyTo.messageSequenceId)
              .pipe(Effect.catch(() => Effect.succeed(null)));
            isReplyToBot = repliedMsg?.sender?.id === config.myUserId;
          }

          // Recent history for continuation (oldest→newest), exclude current.
          let recentChronological: Array<{ senderId: string }> = [];
          if (
            effectiveConfig.trigger === "addressed" ||
            effectiveConfig.trigger === "mention_only"
          ) {
            const hist = yield* Chat.messages
              .list(conversationId, { limit: 12 })
              .pipe(
                Effect.catch(() =>
                  Effect.succeed({ messages: [] as ReadonlyArray<Message> }),
                ),
              );
            recentChronological = [...hist.messages]
              .reverse()
              .filter((m) => m.id !== latestMsg.id)
              .map((m) => ({ senderId: m.sender?.id ?? "unknown" }));
          }

          const addressed = isAddressedToBot({
            text,
            convId,
            myUserId: config.myUserId,
            senderId,
            botHandles,
            isReplyToBot,
            trigger: effectiveConfig.trigger,
            recentChronological,
          });

          const allowed = shouldRespond(
            effectiveConfig.respondTo,
            effectiveConfig.trigger,
            senderRole,
            addressed,
          );

          if (!allowed) {
            log({
              type: "permission_check",
              conversationId: convId,
              senderId,
              senderRole,
              effectiveConfig: {
                respondTo: effectiveConfig.respondTo,
                trigger: effectiveConfig.trigger,
                toolkits: effectiveConfig.toolkits,
              },
              isMention: mentionInText,
              isReplyToBot,
              addressed,
              allowed: false,
            });
            log({
              type: "message_skipped",
              conversationId: convId,
              messageId: latestMsg.id,
              senderId,
              reason: "permission_denied",
            });
            return;
          }

          log({
            type: "permission_check",
            conversationId: convId,
            senderId,
            senderRole,
            effectiveConfig: {
              respondTo: effectiveConfig.respondTo,
              trigger: effectiveConfig.trigger,
              toolkits: effectiveConfig.toolkits,
            },
            isMention: mentionInText,
            isReplyToBot,
            addressed,
            allowed: true,
          });

          // Handle with full lifecycle. The whole turn gets ONE bounded
          // retry 45s later when it dies of a provider error: the model
          // layer's in-request backoff (~19s) covers blips, this covers
          // short outages. Without it a dead turn is dead forever —
          // lastSeenId already advanced, and the catch-up poll's delta pull
          // never re-fetches an already-ingested message (observed live
          // 2026-06-11: an unretried xAI 429 left "hello there" permanently
          // unanswered).
          const turnEffect = Effect.scoped(
            Effect.gen(function* () {
              yield* Chat.conversation
                .markRead(conversationId)
                .pipe(Effect.catch(() => Effect.void));

              const stopTyping = yield* startTypingLoop(conversationId);
              log({
                type: "typing_indicator",
                conversationId: convId,
                action: "start",
              });

              // Build input text with conversation context for tool use.
              // The sender id is included so the drone can key person notes
              // (people/ frontmatter `handles.xchat`) to the right human; the
              // time anchors relative phrases ("remind me at 5:30" needs an
              // absolute ISO for schedule_wake).
              let inputText = `[conversation: ${convId}, message: ${latestMsg.id}, sender: ${senderId}, time: ${new Date().toISOString()}]\n${text}`;
              if (latestMsg.replyTo) {
                const replySender = latestMsg.replyTo.senderName ?? "someone";
                const replyPreview = latestMsg.replyTo.previewText ?? "";
                let replyAnnotation = `[replying to ${replySender}: "${replyPreview}"`;
                // Look up the replied-to message to get its attachment info
                if (latestMsg.replyTo.messageSequenceId) {
                  const repliedMsg = yield* Chat.messages
                    .get(conversationId, latestMsg.replyTo.messageSequenceId)
                    .pipe(Effect.catch(() => Effect.succeed(null)));
                  if (repliedMsg?.attachment) {
                    replyAnnotation += `, ${attachmentDescriptor(repliedMsg.attachment, convId)}`;
                  }
                }
                inputText += `\n${replyAnnotation}]`;
              }
              // Surface ALL attachments (a DM may carry several photos), not
              // just the first.
              const liveAttachments =
                latestMsg.attachments ??
                (latestMsg.attachment ? [latestMsg.attachment] : []);
              const liveAttachmentBlock = attachmentAnnotations(liveAttachments, convId);
              if (liveAttachmentBlock) {
                inputText += `\n${liveAttachmentBlock}`;
              }
              if (latestMsg.isForwarded && latestMsg.forwardedText) {
                inputText += `\n[forwarded: ${latestMsg.forwardedText}]`;
              }
              if (!inputText.trim()) {
                inputText =
                  "[The user sent a media attachment — use view_media to see it]";
              }

              // Reuse session per conversation — only inject history on first message
              let entry = conversationSessions.get(convId);
              let historyTurnCount: number | undefined = 0;
              if (!entry) {
                const session = yield* AiChat.empty;
                historyTurnCount = yield* injectConversationHistory(
                  conversationId,
                  convId,
                  latestMsg.id,
                  myUserId,
                  session,
                );
                entry = { session };
                conversationSessions.set(convId, entry);

                log({
                  type: "session_created",
                  conversationId: convId,
                });
                log({
                  type: "history_injected",
                  conversationId: convId,
                  turnCount: historyTurnCount ?? 0,
                });
              }

              // Shared media buffer — view_media pushes here, agent loop includes in next prompt
              const pendingMedia: Array<PendingMedia> = [];
              const isGlobalAdmin = config.globalAdmins.includes(senderId);
              const enabledToolkits = resolveToolkits(
                effectiveConfig.toolkits,
                senderRole,
                isGlobalAdmin,
                config.globalAdminToolkits,
              );
              const toolkitLayer = makeToolkitLayer(
                pendingMedia,
                config.allowedConversationIds,
                enabledToolkits,
                senderRole,
                isGlobalAdmin,
                config.globalAdminToolkits,
                runtimeOverrides,
                convId,
                config.defaultConversationConfig,
                config.conversationConfig,
                config.accountDir,
                undefined,
                config.brain,
                config.alarms,
              ).pipe(
                Layer.provide(ShellExecutor.liveLayer),
                Layer.provide(ChatExecutor.liveLayer),
                Layer.provide(XaiMediaExecutor.liveLayer),
                Layer.provide(QuoteExecutor.liveLayer),
              );
              const runEffect = run({
                chat: entry.session,
                input: { text: inputText },
                toolkit: AgentToolkit,
                pendingMedia,
                conversationId: convId,
                // The loop only emits entry types that are in our LogEntry
                // union (agent_loop_round / agent_round_text / tool_call /
                // agent_loop_exhausted) — the cast bridges the core's
                // schema-agnostic logger to the app's typed one.
                log: (entry) => log(entry as unknown as LogEntry),
              }).pipe(Effect.provide(toolkitLayer));

              // Per-turn persona (live soul + ambient memory) rides the same
              // per-request override path as previous_response_id.
              const persona = yield* assembleTurnPersona(config, convId, senderId);
              const agentResult = yield* XaiLanguageModel.withConfigOverride(
                runEffect,
                entry.lastResponseId
                  ? {
                      instructions: persona,
                      previous_response_id: entry.lastResponseId,
                    }
                  : { instructions: persona },
              );

              // Store response ID for next turn
              if (agentResult.responseId) {
                entry.lastResponseId = agentResult.responseId;
              }

              log({
                type: "typing_indicator",
                conversationId: convId,
                action: "stop",
              });
              yield* stopTyping;

              for (const raw of agentResult.messages) {
                // Channel-mouth guarantee: DMs render plain text, so markdown
                // is stripped mechanically (see sanitize.ts) — instructions
                // alone demonstrably don't hold against web-search citations.
                const msg = sanitizeOutboundText(raw);
                if (msg === "") continue;
                process.stderr.write(`[xchat] ▶ ${convId} "${msg.slice(0, 80)}"\n`);
                yield* Chat.messages.send(conversationId, msg).pipe(
                  Effect.tap(() => {
                    log({
                      type: "message_sent",
                      conversationId: convId,
                      text: msg,
                    });
                    return Effect.void;
                  }),
                  Effect.catch((error: unknown) => {
                    log({
                      type: "message_send_failed",
                      conversationId: convId,
                      error: String(error),
                    });
                    process.stderr.write(
                      `[xchat] message send failed in ${convId}: ${error}\n`,
                    );
                    return Effect.void;
                  }),
                );
              }

              process.stderr.write(
                `[xchat] tokens: ${agentResult.tokenUsage.totalTokens} (in: ${agentResult.tokenUsage.inputTokens}, out: ${agentResult.tokenUsage.outputTokens})\n`,
              );

              log({
                type: "agent_response",
                conversationId: convId,
                messages: agentResult.messages,
                tokenUsage: agentResult.tokenUsage,
                totalToolCalls: agentResult.totalToolCalls,
                totalRounds: agentResult.totalRounds,
              });
            }),
          );

          yield* turnEffect.pipe(
            Effect.tapError((error: unknown) =>
              Effect.sync(() => {
                log({
                  type: "turn_retry",
                  conversationId: convId,
                  messageId: latestMsg.id,
                  error: String(error).slice(0, 300),
                });
                process.stderr.write(
                  `[xchat] turn failed in ${convId}, retrying in 45s: ${error}\n`,
                );
              }),
            ),
            Effect.retry({
              schedule: Schedule.spaced("45 seconds"),
              times: 1,
            }),
            Effect.catch((error: unknown) => {
              log({
                type: "agent_error",
                conversationId: convId,
                messageId: latestMsg.id,
                error: String(error),
              });
              process.stderr.write(`[xchat] error in ${convId}: ${error}\n`);
              return Effect.void;
            }),
          );
        }),
      ),
    );
  });

/**
 * Periodic catch-up poll — a safety net for dropped WebSocket frames.
 *
 * Every `intervalMs`, delta-sync from the bottom cursor via
 * `Chat.inbox.catchUp()` (`get_message_events_page` since the saved
 * `max_user_sequence_id`). Newly-fetched messages are ingested through the
 * SAME pipeline as live socket frames, so they fire the
 * `messages:{conversationId}` PubSub that each `watchConversation` stream is
 * subscribed to — the bot then handles them through the identical
 * permission → agent → send path, as if they had arrived over the socket.
 *
 * The watcher's `lastSeenId` guard makes this idempotent: messages already
 * delivered by the socket are skipped, so a recovered message is never
 * answered twice. Sleeps first (boot already did a full `inbox.sync`), so the
 * first poll fires at T+interval.
 */
const periodicCatchUp = (intervalMs: number) =>
  Effect.forever(
    Effect.gen(function* () {
      yield* Effect.sleep(intervalMs);
      const startedAt = Date.now();
      const ok = yield* Chat.inbox.catchUp().pipe(
        Effect.map(() => true),
        Effect.catch(() => Effect.succeed(false)),
      );
      const durationMs = Date.now() - startedAt;
      log({ type: "inbox_catch_up", success: ok, durationMs });
      process.stderr.write(
        `[xchat] catch-up ${ok ? "ok" : "failed"} (${durationMs}ms)\n`,
      );
    }),
  );

/**
 * Reconcile the running watcher fiber set against the desired allowlist:
 * fork a watcher for every desired id that has none, interrupt every watcher
 * whose id is no longer desired. Mutates `fibers` in place.
 *
 * Pure orchestration — `fork`/`interrupt` are injected so this is unit-testable
 * without SDK layers. Returns what changed.
 */
export const reconcileWatchers = <F, R = never>(options: {
  readonly fibers: Map<string, F>;
  readonly desired: readonly string[];
  readonly fork: (convId: string) => Effect.Effect<F, never, R>;
  readonly interrupt: (convId: string, fiber: F) => Effect.Effect<void>;
}): Effect.Effect<{ added: string[]; removed: string[] }, never, R> =>
  Effect.gen(function* () {
    const desiredSet = new Set(options.desired);
    const added: string[] = [];
    const removed: string[] = [];
    for (const convId of desiredSet) {
      if (!options.fibers.has(convId)) {
        const fiber = yield* options.fork(convId);
        options.fibers.set(convId, fiber);
        added.push(convId);
      }
    }
    for (const [convId, fiber] of options.fibers) {
      if (!desiredSet.has(convId)) {
        yield* options.interrupt(convId, fiber);
        options.fibers.delete(convId);
        removed.push(convId);
      }
    }
    return { added, removed };
  });

/**
 * Funnel a watcher's terminal cause into the adapter-failure deferred —
 * unless the cause is interrupt-only, which is a *deliberate* stop (the
 * reconcile loop removing the watcher, or scope shutdown), not a failure.
 * Found live: without this guard, removing a conversation from the
 * allowlist killed the whole adapter via its own failure funnel.
 */
export const reportWatcherExit = <E>(
  failure: Deferred.Deferred<never, unknown>,
  cause: Cause.Cause<E>,
): Effect.Effect<void> =>
  Cause.hasInterruptsOnly(cause)
    ? Effect.void
    : Effect.asVoid(Deferred.fail(failure, cause));

/**
 * Assemble the per-turn persona: mechanics + live soul + ambient memory for
 * this turn's participants and room (docs/drone-core-design.md, "Context
 * assembly"). Brainless deployments get mechanics + the seed soul — the bot
 * keeps its personality, it just doesn't remember.
 *
 * Participants: a 1:1's colon-form id carries both user ids; group turns
 * resolve the sender (room files carry group-level ambient context — widening
 * to full membership is a follow-up once member lists are cached per turn).
 * The room key is the conversation id — deterministic for the loader; the
 * drone can keep prettier-named room notes and read them itself.
 */
export const assembleTurnPersona = (
  config: XChatAdapterConfig,
  convId: string,
  senderId: string,
) =>
  Effect.gen(function* () {
    const { brain, mechanics, fallbackSoul } = config;
    if (!brain) {
      return buildPersona({ mechanics, soul: fallbackSoul, memoryContext: "" });
    }
    const soul = yield* brain
      .read("soul.md")
      .pipe(Effect.catch(() => Effect.succeed(fallbackSoul)));
    const handles = convId.includes(":") ? convId.split(":") : [senderId];
    const personIds: string[] = [];
    for (const handle of handles) {
      const id = yield* brain.resolvePerson("xchat", handle);
      if (id !== undefined) personIds.push(id);
    }
    const memoryContext = yield* brain.contextFor(personIds, convId);
    const persona = buildPersona({ mechanics, soul, memoryContext });
    log({
      type: "turn_context",
      conversationId: convId,
      personaBytes: Buffer.byteLength(persona, "utf-8"),
      memoryBytes: Buffer.byteLength(memoryContext, "utf-8"),
      files: personIds.map((id) => `people/${id}.md`),
    });
    return persona;
  });

// ── Wake-turn support (the clock's borrowed eyes and mouth) ──

/** Max messages per room in a wake digest. */
export const DIGEST_ROOM_CAP = 50;

/** Pure digest formatter for one room — testable without the SDK. */
export const formatRoomDigest = (options: {
  readonly convId: string;
  readonly messages: ReadonlyArray<{
    readonly senderName: string;
    readonly senderId?: string;
    readonly timestamp: Date;
    readonly text: string;
  }>;
  /** True when the fetch window may have missed older messages. */
  readonly truncated: boolean;
}): string => {
  if (options.messages.length === 0) return "";
  const lines = options.messages.map(
    (m) => `  ${m.senderName} [${m.timestamp.toISOString().slice(11, 16)}]: ${m.text}`,
  );
  // Name → sender-id mapping in the header so the capture pass can write
  // correct people/ frontmatter handles (names alone aren't identities —
  // found in the first capture-eval run, which wrote handles.xchat: "Zach").
  const people = [
    ...new Map(
      options.messages
        .filter((m) => m.senderId)
        .map((m) => [m.senderName, m.senderId as string]),
    ).entries(),
  ]
    .map(([name, id]) => `${name}=${id}`)
    .join(", ");
  const header = people
    ? `[conversation: ${options.convId} | people: ${people}]`
    : `[conversation: ${options.convId}]`;
  const overflow = options.truncated ? "\n  (+ possibly earlier messages)" : "";
  return `${header}\n${lines.join("\n")}${overflow}`;
};

/**
 * The channel's ambient eyes for wake turns, plus speakable-room names for
 * the wake prompt. `digest(since)` reads every watched room's activity since
 * the given time (per-room cap, chronological) and refreshes the room-name
 * cache that the sync `speakable()` reads — the heartbeat always runs digest
 * before building the prompt, so names are at most one wake stale.
 */
export const makeWakeEyes = (config: XChatAdapterConfig) => {
  const roomNames = new Map<string, string>();

  const digest = (since: Date) =>
    Effect.gen(function* () {
      const sections: string[] = [];
      // Never treat "*" as a conversation id. Under fanout, digest the
      // speakUnprompted rooms (proactive blast radius) + any explicit ids.
      const digestIds = config.allowedConversationIds.includes("*")
        ? [
            ...new Set([
              ...config.allowedConversationIds.filter((id) => id !== "*"),
              ...config.speakUnprompted,
            ]),
          ]
        : [...config.allowedConversationIds];
      for (const convId of digestIds) {
        const conversationId = ConversationId.make(convId);
        const recent = yield* Chat.messages
          .list(conversationId, { limit: DIGEST_ROOM_CAP })
          .pipe(
            Effect.catch(() =>
              Effect.succeed({ messages: [] as ReadonlyArray<Message> }),
            ),
          );
        const fresh = recent.messages.filter(
          (m) => m.timestamp.getTime() > since.getTime() && (m.text ?? "") !== "",
        );
        if (fresh.length === 0) continue;

        const senderIds = [...new Set(fresh.map((m) => m.sender?.id ?? "unknown"))];
        const users = yield* Chat.users
          .getMany(senderIds)
          .pipe(Effect.catch(() => Effect.succeed(new Map<string, UserData>())));
        const chronological = [...fresh].reverse();
        sections.push(
          formatRoomDigest({
            convId,
            messages: chronological.map((m) => {
              const u = users.get(m.sender?.id ?? "");
              return {
                senderName: u?.name ?? u?.screenName ?? m.sender?.id ?? "unknown",
                senderId: m.sender?.id,
                timestamp: m.timestamp,
                text: m.text ?? "",
              };
            }),
            truncated:
              fresh.length === recent.messages.length &&
              recent.messages.length === DIGEST_ROOM_CAP,
          }),
        );
      }
      // Refresh speakable room names (cheap; speak list is small).
      for (const convId of config.speakUnprompted) {
        const detail = yield* Chat.conversation
          .detail(ConversationId.make(convId))
          .pipe(Effect.catch(() => Effect.succeed(undefined)));
        const title = (detail as { title?: string } | undefined)?.title;
        roomNames.set(convId, title && title.trim() !== "" ? title : convId);
      }
      return sections.join("\n\n");
    });

  const speakable = (): ReadonlyArray<string> =>
    config.speakUnprompted.map((id) => roomNames.get(id) ?? id);

  return { digest, speakable };
};

/**
 * The wake-mode toolkit: least-privileged (role user, never coding), no
 * current conversation (the cross-conv admin gate is skipped), and the
 * allowlist — the sole outbound gate for send/react/voice — is the channel's
 * speakUnprompted list. Read fresh per wake so config edits hot-apply.
 */
export const makeWakeToolkitLayer = (
  config: XChatAdapterConfig,
  pendingMedia: Array<PendingMedia>,
) =>
  makeToolkitLayer(
    pendingMedia,
    config.speakUnprompted,
    new Set(["xchat", "xai"]),
    "user",
    false,
    undefined,
    new Map(),
    undefined, // wake mode
    config.defaultConversationConfig,
    config.conversationConfig,
    config.accountDir,
    undefined,
    config.brain,
    config.alarms,
  );

/**
 * Participant ids from a digest's room headers (`people: Name=id, ...`) —
 * so wake/capture turns get those people's notes ambiently instead of
 * groping for filenames (found by the limits evals: blind capture turns
 * read people/<id>.md, miss people/<name>.md, and lose context).
 */
export const parseDigestPeople = (digest: string): string[] => {
  const ids = new Set<string>();
  for (const match of digest.matchAll(/\|\s*people:\s*([^\]]+)\]/g)) {
    for (const pair of (match[1] as string).split(",")) {
      const id = pair.split("=")[1]?.trim();
      if (id) ids.add(id);
    }
  }
  return [...ids];
};

/**
 * The host executor for clock wakes: a fresh session, the wake-mode toolkit,
 * persona = mechanics + live soul + memory.md + the person files of everyone
 * active in the digest (resolved via the digest's people headers), and the
 * wake prompt as the turn input. Terminal text is returned to the heartbeat
 * for suppression, never delivered (the two-mouths rule). Never fails — the
 * clock must survive any wake.
 */
export const makeExecuteWake = (config: XChatAdapterConfig) => (prompt: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const session = yield* AiChat.empty;
      const pendingMedia: Array<PendingMedia> = [];
      const toolkitLayer = makeWakeToolkitLayer(config, pendingMedia).pipe(
        Layer.provide(ShellExecutor.liveLayer),
        Layer.provide(ChatExecutor.liveLayer),
        Layer.provide(XaiMediaExecutor.liveLayer),
        Layer.provide(QuoteExecutor.liveLayer),
      );
      const soul = config.brain
        ? yield* config.brain
            .read("soul.md")
            .pipe(Effect.catch(() => Effect.succeed(config.fallbackSoul)))
        : config.fallbackSoul;
      let memoryContext = "";
      if (config.brain) {
        const personIds: string[] = [];
        for (const handle of parseDigestPeople(prompt)) {
          const id = yield* config.brain.resolvePerson("xchat", handle);
          if (id !== undefined) personIds.push(id);
        }
        memoryContext = yield* config.brain.contextFor(personIds, undefined);
      }
      const persona = buildPersona({
        mechanics: config.mechanics,
        soul,
        memoryContext,
      });
      const result = yield* run({
        chat: session,
        input: { text: prompt },
        toolkit: AgentToolkit,
        pendingMedia,
        conversationId: "(wake)",
        log: (entry) => log(entry as unknown as LogEntry),
      }).pipe(Effect.provide(toolkitLayer), (effect) =>
        XaiLanguageModel.withConfigOverride(effect, { instructions: persona }),
      );
      return {
        suppressedText: result.messages,
        toolCalls: result.totalToolCalls,
        rounds: result.totalRounds,
        tokens: result.tokenUsage.totalTokens,
      } satisfies WakeOutcome;
    }),
  ).pipe(
    Effect.map(
      (outcome): WakeOutcome => ({
        suppressedText: outcome.suppressedText,
        toolCalls: outcome.toolCalls,
        rounds: outcome.rounds,
        tokens: outcome.tokens,
      }),
    ),
    Effect.catch((error: unknown) => {
      log({ type: "agent_error", conversationId: "(wake)", error: String(error) });
      return Effect.succeed<WakeOutcome>({
        suppressedText: [],
        toolCalls: 0,
        rounds: 0,
        tokens: 0,
      });
    }),
  );

/** How often the reconcile loop checks `configVersion` for a change. */
const RECONCILE_POLL_MS = 1_000;

/**
 * Expand allowlist. `"*"` means "every conversation currently in the local
 * inbox" — the SDK WS fanout already delivers frames for all of them into
 * SQLite/PubSub; we just need a watcher fiber per id so the agent wakes.
 * Explicit ids are always kept. `"*"` itself is never a watcher target.
 */
export const expandAllowlist = (allow: readonly string[]) =>
  Effect.gen(function* () {
    const explicit = allow.filter((id) => id !== "*");
    if (!allow.includes("*")) return explicit as readonly string[];

    // Page local inbox (after sync). High limit covers typical bot inboxes;
    // fetchMore while hasMore so new groups aren't invisible forever.
    const ids = new Set<string>(explicit);
    let page = yield* Chat.inbox.list({ limit: 200 }).pipe(
      Effect.catch(() =>
        Effect.succeed({
          conversations: [] as Array<{ id: string }>,
          hasMore: false,
        }),
      ),
    );
    for (const c of page.conversations) ids.add(String(c.id));
    let guard = 0;
    while (page.hasMore && guard < 20) {
      guard += 1;
      const more = yield* Chat.inbox.fetchMore().pipe(
        Effect.catch(() => Effect.succeed({ hasMore: false })),
      );
      page = yield* Chat.inbox.list({ limit: 200 }).pipe(
        Effect.catch(() =>
          Effect.succeed({
            conversations: [] as Array<{ id: string }>,
            hasMore: false,
          }),
        ),
      );
      for (const c of page.conversations) ids.add(String(c.id));
      if (!more.hasMore) break;
    }
    return [...ids] as readonly string[];
  });

/**
 * Listen for XChat messages on all allowlisted conversations in parallel.
 * Each conversation gets its own message stream watcher.
 *
 * Watchers are forked into a reconciled fiber set (not a static `Effect.all`),
 * so allowlist changes picked up by the config file watcher apply live:
 * added ids get a watcher (fresh `lastSeenId` — history before the attach is
 * deliberately skipped, same as boot), removed ids get interrupted. A watcher
 * *failure* still fails the whole adapter exactly as before — forked fibers
 * funnel failures into a Deferred the main body races — because a silently
 * dead watcher (bot looks healthy, conversation is deaf) is the worse outcome.
 *
 * When the allowlist contains `"*"`, desired ids are expanded from the live
 * inbox on every reconcile tick so newly-created 1:1s/groups get a watcher
 * without a restart (SDK fanout already ingested them).
 */
export const listenAndRespond = (config: XChatAdapterConfig) =>
  Effect.gen(function* () {
    // Sync inbox first (needed before * expansion)
    const syncResult = yield* Chat.inbox.sync({ full: true }).pipe(
      Effect.map(() => true),
      Effect.catch(() => Effect.succeed(false)),
    );
    log({
      type: "inbox_sync",
      success: syncResult,
      error: syncResult ? undefined : "inbox sync failed",
    });

    // Per-conversation persistent sessions (in-memory)
    const conversationSessions = new Map<
      string,
      { session: AiChat.Service; lastResponseId?: string }
    >();
    const runtimeOverrides = new Map<string, Partial<ConversationConfig>>();

    const watcherFailure = yield* Deferred.make<never, unknown>();
    const watcherFibers = new Map<string, Fiber.Fiber<unknown, unknown>>();

    const forkWatcher = (convId: string) =>
      watchConversation(convId, config, conversationSessions, runtimeOverrides).pipe(
        Effect.onError((cause) => reportWatcherExit(watcherFailure, cause)),
        Effect.forkScoped,
      );

    const reconcile = () =>
      Effect.gen(function* () {
        const desired = yield* expandAllowlist(config.allowedConversationIds);
        return yield* reconcileWatchers({
          fibers: watcherFibers,
          desired,
          fork: forkWatcher,
          interrupt: (_convId, fiber) => Fiber.interrupt(fiber),
        });
      });

    {
      const { added } = yield* reconcile();
      const fanout = config.allowedConversationIds.includes("*");
      process.stderr.write(
        `[xchat] listening on ${watcherFibers.size} conversations` +
          `${fanout ? " (allowlist=*, inbox fanout)" : ""}\n`,
      );
      if (added.length > 0) {
        process.stderr.write(`[xchat] initial watchers: ${added.length}\n`);
      }
    }

    // Run a periodic catch-up poll alongside the watchers so dropped socket
    // frames are recovered within the interval. `0` disables it.
    const catchUpIntervalMs = resolveCatchUpIntervalMs(
      process.env.XCHAT_CATCH_UP_INTERVAL_MS,
    );
    if (catchUpIntervalMs > 0) {
      process.stderr.write(
        `[xchat] catch-up poll every ${Math.round(catchUpIntervalMs / 1000)}s\n`,
      );
      yield* Effect.forkScoped(periodicCatchUp(catchUpIntervalMs));
    }

    // Reconcile loop — config reloads OR inbox growth under allowlist=*
    // (new DMs/groups) attach watchers within RECONCILE_POLL_MS.
    const fanoutMode = () => config.allowedConversationIds.includes("*");
    // Under *, also re-sync inbox occasionally so brand-new convs appear.
    let ticksSinceInboxSync = 0;
    const INBOX_RESYNC_TICKS = 30; // ~30s at 1s poll

    const reconcileLoop = Effect.gen(function* () {
      let lastVersion = config.configVersion;
      let lastDesiredKey = "";
      while (true) {
        yield* Effect.sleep(`${RECONCILE_POLL_MS} millis`);
        const versionChanged = config.configVersion !== lastVersion;
        lastVersion = config.configVersion;

        if (fanoutMode()) {
          ticksSinceInboxSync += 1;
          if (ticksSinceInboxSync >= INBOX_RESYNC_TICKS) {
            ticksSinceInboxSync = 0;
            yield* Chat.inbox.sync({ full: false }).pipe(
              Effect.catch(() => Effect.void),
            );
          }
        } else if (!versionChanged) {
          continue;
        }

        const desired = yield* expandAllowlist(config.allowedConversationIds);
        const desiredKey = desired.slice().sort().join("\0");
        if (!versionChanged && desiredKey === lastDesiredKey) continue;
        lastDesiredKey = desiredKey;

        const { added, removed } = yield* reconcileWatchers({
          fibers: watcherFibers,
          desired,
          fork: forkWatcher,
          interrupt: (_convId, fiber) => Fiber.interrupt(fiber),
        });
        if (added.length > 0 || removed.length > 0) {
          log({
            type: "watcher_reconcile",
            added,
            removed,
            watching: [...watcherFibers.keys()],
          });
          process.stderr.write(
            `[xchat] watchers reconciled (+${added.length}/−${removed.length}) → ${watcherFibers.size} active\n`,
          );
        }
      }
    });

    // Any watcher failure fails the adapter, exactly like Effect.all did.
    yield* Effect.raceFirst(reconcileLoop, Deferred.await(watcherFailure));
  });
