/**
 * xchat-tools.ts -- XChat-specific agent tools.
 *
 * Handlers consume executor services (ChatExecutor, ShellExecutor, XaiMediaExecutor)
 * for all side effects. Formatting stays in handlers. No mock drift.
 */
import { Effect, Layer, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";

import {
  type AlarmsApi,
  type BrainApi,
  BrainList,
  BrainRead,
  BrainService,
  BrainWrite,
  CancelWake,
  EditWake,
  ListScheduledWakes,
  type PendingMedia,
  ScheduleWake,
  makeBrainHandlers,
  makeClockHandlers,
} from "@x-chat/drone-core";
import { sanitizeOutboundText } from "../adapters/sanitize.js";
import { resolveConversationConfig } from "../adapters/xchat.js";
import type { ConversationConfig, UserRole } from "../adapters/xchat.js";
import { loadAgentConfig, saveAgentConfig } from "../config.js";
import { log } from "../logger.js";
import { Bash, bashHandler } from "./bash-tool.js";
import { BunRun, bunRunHandler } from "./bun-tool.js";
import {
  ChatExecutor,
  QuoteExecutor,
  ShellExecutor,
  XaiMediaExecutor,
} from "./executors/index.js";
import { GetQuote, getQuoteHandler } from "./quote-tool.js";
import { UseSkill, useSkillHandler } from "./skill-tool.js";
import { truncateResult } from "./truncate.js";
import { TTS_INLINE_LIST, TTS_WRAPPING_LIST } from "./voice-tags.js";
import {
  GenerateImage,
  GenerateVideo,
  generateImageHandler,
  generateVideoHandler,
} from "./xai-tools.js";

/** Which named toolkit each tool belongs to. */
export const TOOL_TOOLKIT: Record<string, string> = {
  view_media: "xchat",
  react_to_message: "xchat",
  send_message: "xchat",
  search_messages: "xchat",
  search_conversations: "xchat",
  get_conversation_info: "xchat",
  send_voice_note: "xchat",
  generate_image: "xai",
  generate_video: "xai",
  // Real market data — always-on (like "core"), a correctness tool: the bot
  // should never be left guessing a price because a conversation's toolkit
  // config happened to omit it.
  get_quote: "data",
  bash: "coding",
  bun_run: "coding",
  use_skill: "core",
  configure_conversation: "admin", // special: handler-level gating, not toolkit-level
  get_conversation_status: "admin", // special: handler-level gating, not toolkit-level
  restart_agent: "admin", // special: handler-level gating, not toolkit-level
  // The drone's own notes — always enabled (like "core"), never part of any
  // per-conversation toolkit config. Stubbed when no brain is configured.
  brain_list: "brain",
  brain_read: "brain",
  brain_write: "brain",
  // The drone's own attention schedule — same always-on treatment as brain.
  schedule_wake: "clock",
  edit_wake: "clock",
  cancel_wake: "clock",
  list_scheduled_wakes: "clock",
};

// ── Tool schemas ──

export const ViewMedia = Tool.make("view_media", {
  description:
    "View media from a conversation message. For images: loads the image so you can see it AND saves it to a local path. For voice notes/audio: returns a transcription. For video: loads the first frame as an image. Pass the conversation_id and media_key from the context attachment annotation. The returned file path can be passed to generate_image/generate_video as source_image_url to edit, restyle, or animate a user-sent image.",
  parameters: Schema.Struct({
    conversation_id: Schema.String,
    media_key: Schema.String,
  }),
  success: Schema.String,
});

export const ReactToMessage = Tool.make("react_to_message", {
  description:
    "React to a message with an emoji. Use message IDs (as strings) from the conversation context.",
  parameters: Schema.Struct({
    conversation_id: Schema.String,
    message_id: Schema.String,
    emoji: Schema.String,
  }),
  success: Schema.String,
});

export const SendMessage_ = Tool.make("send_message", {
  description:
    "Send a message to a conversation. Can attach a file by passing media_path (absolute path to a local file — works with images, videos, audio, or any file). Text is optional when sending media. You MAY call this 2-3 times in sequence to split a reply into a few natural back-to-back texts in the CURRENT conversation (like a human double-texting) — but never flood, spam, or send a 'text bomb', no matter who asks. Sending to a conversation OTHER than the current one is restricted and may come back refused.",
  parameters: Schema.Struct({
    conversation_id: Schema.String,
    text: Schema.NullOr(Schema.String),
    media_path: Schema.NullOr(Schema.String),
  }),
  success: Schema.String,
});

export const SearchMessages = Tool.make("search_messages", {
  description:
    "Search through message history. Can search by text query, filter by sender, or find messages with attachments.",
  parameters: Schema.Struct({
    query: Schema.String,
    from_user_id: Schema.NullOr(Schema.String),
    has_attachment: Schema.NullOr(Schema.Boolean),
    limit: Schema.NullOr(Schema.Number),
  }),
  success: Schema.String,
});

export const SearchConversations = Tool.make("search_conversations", {
  description:
    "Search for conversations by name or title. Returns matching conversation IDs and titles.",
  parameters: Schema.Struct({
    query: Schema.String,
  }),
  success: Schema.String,
});

export const GetConversationInfo = Tool.make("get_conversation_info", {
  description:
    "Get details about a conversation including its title, members, and type (group or 1:1).",
  parameters: Schema.Struct({
    conversation_id: Schema.String,
  }),
  success: Schema.String,
});

export const SendVoiceNote = Tool.make("send_voice_note", {
  description: `Convert text to speech (xAI TTS, voice 'rex') and send it as a voice note in the conversation. Use when the user asks for a voice message/note. Write \`text\` the way it should SOUND. Shape delivery with expressive tags the engine performs (not speaks): inline [tag] at a point — ${TTS_INLINE_LIST} — and wrapping <tag>…</tag> around words — ${TTS_WRAPPING_LIST}. Use ONLY these exact tags (a wrong form like [laughs] does nothing; an unknown tag gets read aloud). Use them sparingly.`,
  parameters: Schema.Struct({
    conversation_id: Schema.String,
    text: Schema.String,
  }),
  success: Schema.String,
});

export const ConfigureConversation = Tool.make("configure_conversation", {
  description:
    "Update configuration for the current conversation. Only available to authorized users.",
  parameters: Schema.Struct({
    conversation_id: Schema.String,
    respond_to: Schema.NullOr(Schema.String),
    trigger: Schema.NullOr(Schema.String),
  }),
  success: Schema.String,
});

export const GetConversationStatus = Tool.make("get_conversation_status", {
  description:
    "Get the current configuration status for a conversation, including response mode and trigger settings.",
  parameters: Schema.Struct({
    conversation_id: Schema.String,
  }),
  success: Schema.String,
});

export const RestartAgent = Tool.make("restart_agent", {
  description:
    "Restart the agent process. Pulls latest code from main, installs dependencies, and restarts. Only available to admins.",
  parameters: Schema.Struct({
    reason: Schema.NullOr(Schema.String),
  }),
  success: Schema.String,
});

/** Combined toolkit with all XChat agent tools (+ the drone's brain tools). */
export const AgentToolkit = Toolkit.make(
  ViewMedia,
  ReactToMessage,
  SendMessage_,
  SearchMessages,
  SearchConversations,
  GetConversationInfo,
  SendVoiceNote,
  GenerateImage,
  GenerateVideo,
  Bash,
  BunRun,
  UseSkill,
  ConfigureConversation,
  GetConversationStatus,
  RestartAgent,
  BrainList,
  BrainRead,
  BrainWrite,
  ScheduleWake,
  EditWake,
  CancelWake,
  ListScheduledWakes,
  GetQuote,
);

// ── Handler factory ──

/**
 * Create all tool handlers for the XChat toolkit.
 * Handlers consume ChatExecutor for all SDK/network side effects.
 * Formatting stays here; no mock drift possible.
 */
export const makeHandlers = (
  pendingMedia: Array<PendingMedia>,
  allowedConversationIds: readonly string[],
  exec: typeof ChatExecutor.Service,
  /** Per-turn set of `${conversationId}\n${mediaPath}` already sent, to dedupe. */
  sentSendKeys: Set<string>,
  /** Role of the message sender — gates cross-conversation sends to admins. */
  senderRole: UserRole,
  /**
   * The conversation the current message arrived in (the "current" conv).
   * `undefined` = WAKE MODE: a clock-driven turn with no current conversation
   * — the cross-conversation admin gate is skipped and the allowlist
   * (= the channel's speakUnprompted list) is the sole outbound gate.
   */
  currentConvId: string | undefined,
) => ({
  view_media: (params: {
    readonly conversation_id: string;
    readonly media_key: string;
  }) =>
    Effect.gen(function* () {
      const result = yield* exec.viewMedia(params.conversation_id, params.media_key);

      log({
        type: "media_download",
        conversationId: params.conversation_id,
        mediaKey: params.media_key,
        mediaType: result._tag,
        mimeType:
          result._tag === "image"
            ? result.mimeType
            : result._tag === "unsupported"
              ? result.mimeType
              : "n/a",
        success: true,
      });

      switch (result._tag) {
        case "image":
          pendingMedia.push({ bytes: result.bytes, mimeType: result.mimeType });
          return `Image downloaded and saved to: ${result.path}\nIt will be shown to you next so you can describe it. To edit, restyle, or animate it, pass this exact path as source_image_url to generate_image or generate_video.`;
        case "audio":
          return `[Voice note transcription]: "${result.transcription}"`;
        case "gif":
          if (result.frameBytes) {
            pendingMedia.push({ bytes: result.frameBytes, mimeType: "image/jpeg" });
            return `GIF first frame loaded and saved to: ${result.framePath}\nIt will be shown to you next so you can describe it. To edit or animate the frame, pass this path as source_image_url.`;
          }
          return yield* Effect.fail("Failed to extract GIF frame.");
        case "video":
          if (result.frameBytes) {
            pendingMedia.push({ bytes: result.frameBytes, mimeType: "image/jpeg" });
            return `Video frame extracted and saved to: ${result.framePath}\nIt will be shown to you next so you can describe it. To edit or animate the frame, pass this path as source_image_url.`;
          }
          return yield* Effect.fail("Failed to extract video frame.");
        case "unsupported":
          return `Unsupported media: type=${result.mediaType}, mimeType=${result.mimeType}`;
      }
    }).pipe(
      Effect.catch((e) => {
        log({
          type: "media_download",
          conversationId: params.conversation_id,
          mediaKey: params.media_key,
          mediaType: null,
          mimeType: "unknown",
          success: false,
          error: String(e),
        });
        return Effect.fail("Error viewing media");
      }),
    ),

  react_to_message: (params: {
    readonly conversation_id: string;
    readonly message_id: string;
    readonly emoji: string;
  }) =>
    Effect.gen(function* () {
      // A reaction is outbound speech — allowlist-gated like every other
      // mouth (on wake turns the allowlist IS the speakUnprompted list, and
      // this gate is what keeps unprompted reactions scoped).
      if (
        !allowedConversationIds.includes("*") &&
        !allowedConversationIds.includes(params.conversation_id)
      ) {
        return yield* Effect.fail(
          `Blocked: conversation ${params.conversation_id} is not in the allowlist`,
        );
      }
      yield* exec.reactToMessage(params.conversation_id, params.message_id, params.emoji);
      return `Done. Reaction ${params.emoji} applied to message ${params.message_id}. The reaction is now visible to the user.`;
    }).pipe(Effect.catch((e) => Effect.fail(`Failed to react: ${e}`))),

  send_message: (rawParams: {
    readonly conversation_id: string;
    readonly text: string | null;
    readonly media_path: string | null;
  }) =>
    Effect.gen(function* () {
      // Channel-mouth guarantee: DMs render plain text (see sanitize.ts).
      const params = {
        ...rawParams,
        text: rawParams.text === null ? null : sanitizeOutboundText(rawParams.text),
      };
      // Sending to a conversation OTHER than the current one is admin-only.
      // Sending to the CURRENT conversation stays open to everyone (incl.
      // natural sequential double-texting). Generic refusal on a cross-convo
      // attempt — never reveal the boundary, who's allowed, or any internal
      // detail to the model (it could surface in a DM). Wake mode (no current
      // conversation) skips this gate: the allowlist below — which wake turns
      // set to the channel's speakUnprompted list — is the sole send gate.
      if (
        currentConvId !== undefined &&
        params.conversation_id !== currentConvId &&
        senderRole !== "admin"
      ) {
        return yield* Effect.fail("Can't send to that conversation.");
      }
      if (
        !allowedConversationIds.includes("*") &&
        !allowedConversationIds.includes(params.conversation_id)
      ) {
        return yield* Effect.fail(
          `Blocked: conversation ${params.conversation_id} is not in the allowlist`,
        );
      }
      // Dedupe media within a turn. The model intermittently calls send_message
      // twice for the same generated file (it sends, gets an empty follow-up
      // prompt, and sends again), delivering the image twice. Suppress the
      // repeat send and nudge it to stop. Keyed on conv+path so the same file
      // can still legitimately go to a different conversation.
      if (params.media_path) {
        const key = `${params.conversation_id}\n${params.media_path}`;
        if (sentSendKeys.has(key)) {
          return `Already sent ${params.media_path} to ${params.conversation_id} this turn — not sending it again. You're done; output NO_REPLY.`;
        }
        const result = yield* exec.sendMessage(
          params.conversation_id,
          params.text,
          params.media_path,
        );
        sentSendKeys.add(key);
        return `Done. Message sent (id: ${result.messageId}) with attached file: ${params.media_path}. The media has been delivered and is now visible to the user.`;
      }
      // Dedupe the IDENTICAL text within a turn. The model occasionally fires
      // the exact same message twice (sends, gets an empty follow-up prompt,
      // repeats) — an accidental duplicate, not intentional double-texting
      // (which sends DIFFERENT messages). Suppress the verbatim repeat.
      const textKey = `${params.conversation_id}\ntext:${params.text ?? ""}`;
      if (params.text && sentSendKeys.has(textKey)) {
        return `Already sent that exact message to ${params.conversation_id} this turn — not sending it again. Output NO_REPLY unless you have something new to add.`;
      }
      const result = yield* exec.sendMessage(
        params.conversation_id,
        params.text,
        params.media_path,
      );
      if (params.text) sentSendKeys.add(textKey);
      return `Done. Message sent (id: ${result.messageId}). The message has been delivered to the conversation.`;
    }).pipe(Effect.catch((e) => Effect.fail(`Failed to send: ${e}`))),

  search_messages: (params: {
    readonly query: string;
    readonly from_user_id: string | null;
    readonly has_attachment: boolean | null;
    readonly limit: number | null;
  }) =>
    Effect.gen(function* () {
      const results = yield* exec.searchMessages(
        params.query,
        params.from_user_id,
        params.has_attachment,
        params.limit ?? 10,
      );

      if (results.length === 0) return "No messages found.";

      const formatted = results
        .map((r) => {
          const text = r.text?.slice(0, 100) ?? "(no text)";
          return `[${r.conversationId}] ${r.senderName ?? "unknown"}: ${text}`;
        })
        .join("\n");

      return `Found ${results.length} messages:\n${formatted}`;
    }).pipe(Effect.catch((e) => Effect.fail(`Search failed: ${e}`))),

  search_conversations: (params: { readonly query: string }) =>
    Effect.gen(function* () {
      const results = yield* exec.searchConversations(params.query);
      if (results.length === 0) return "No conversations found.";

      const formatted = results.map((c) => `${c.id}: ${c.displayTitle}`).join("\n");
      return `Found ${results.length} conversations:\n${formatted}`;
    }).pipe(Effect.catch((e) => Effect.fail(`Search failed: ${e}`))),

  get_conversation_info: (params: { readonly conversation_id: string }) =>
    Effect.gen(function* () {
      const detail = yield* exec.getConversationDetail(params.conversation_id);

      if (detail._tag === "group") {
        return `Type: group\nTitle: ${detail.displayTitle}\nMembers (${detail.memberCount}): ${detail.memberNames.join(", ")}`;
      }
      return `Type: direct\nTitle: ${detail.displayTitle}\nOther user: ${detail.otherUserName}`;
    }).pipe(Effect.catch((e) => Effect.fail(`Failed to get info: ${e}`))),

  send_voice_note: (params: {
    readonly conversation_id: string;
    readonly text: string;
  }) =>
    Effect.gen(function* () {
      if (
        !allowedConversationIds.includes("*") &&
        !allowedConversationIds.includes(params.conversation_id)
      ) {
        return yield* Effect.fail(
          `Blocked: conversation ${params.conversation_id} is not in the allowlist`,
        );
      }
      yield* exec.sendVoiceNote(params.conversation_id, params.text);
      return `Done. Voice note delivered to conversation ${params.conversation_id}. The user can now listen to it.`;
    }).pipe(Effect.catch((e) => Effect.fail(`Failed to send voice note: ${e}`))),
});

/**
 * Create the full toolkit Layer for a given pendingMedia array and allowlist.
 *
 * The returned layer requires ShellExecutor, ChatExecutor, and XaiMediaExecutor.
 * In production, provide live executor layers. In evals, provide mock layers.
 */
export const makeToolkitLayer = (
  pendingMedia: Array<PendingMedia>,
  allowedConversationIds: readonly string[],
  enabledToolkits: ReadonlySet<string>,
  senderRole: UserRole,
  isGlobalAdmin: boolean,
  globalAdminToolkits: readonly string[] | undefined,
  runtimeOverrides: Map<string, Partial<ConversationConfig>>,
  /** `undefined` = wake mode (clock-driven turn, no current conversation). */
  currentConvId: string | undefined,
  defaultConversationConfig: ConversationConfig,
  conversationConfig: Record<string, ConversationConfig> | undefined,
  accountDir?: string,
  recordedCalls?: Array<{ name: string; args: Record<string, unknown> }>,
  brain?: BrainApi,
  alarms?: AlarmsApi,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const chatExec = yield* ChatExecutor;
      const shellExec = yield* ShellExecutor;
      const xaiExec = yield* XaiMediaExecutor;
      const quoteExec = yield* QuoteExecutor;

      // The drone's brain tools — real handlers when a brain is configured,
      // model-readable stubs otherwise (brainless mode keeps the old behavior).
      const brainHandlers = brain
        ? yield* makeBrainHandlers.pipe(Effect.provideService(BrainService, brain))
        : undefined;
      const noBrain = () =>
        Effect.succeed(
          "You don't have a brain configured in this deployment — no notes to read or write.",
        );

      // The drone's clock tools — same brain-style stubbing without a brain
      // (alarms are brain state; no brain means nowhere durable to keep them).
      const clockHandlers = alarms ? makeClockHandlers(alarms) : undefined;
      const noClock = () =>
        Effect.succeed(
          "You don't have a clock configured in this deployment — no wakes to schedule.",
        );

      // Per-turn (one toolkit build = one incoming message) — survives across
      // the agent loop's rounds so a repeat send of the same media is caught.
      const sentSendKeys = new Set<string>();
      const handlers = makeHandlers(
        pendingMedia,
        allowedConversationIds,
        chatExec,
        sentSendKeys,
        senderRole,
        currentConvId,
      );

      /** Log a tool call result with an explicit success boolean. */
      const logToolResult = (
        toolName: string,
        params: unknown,
        result: string,
        success: boolean,
      ) => {
        const paramsObj = params as Record<string, unknown>;
        const conversationId =
          typeof paramsObj.conversation_id === "string"
            ? paramsObj.conversation_id
            : (currentConvId ?? "(wake)");
        log({
          type: "tool_call",
          conversationId,
          toolName,
          args: paramsObj,
          result,
          success,
        });
      };

      /**
       * Wrap a handler that may fail (Effect<string, string, R>) into a gated,
       * logged handler that always succeeds (Effect<string, never, R>).
       *
       * - On success: logs with success=true, truncates, returns the result string.
       * - On failure: logs with success=false, truncates, returns the error string.
       * - If the tool's toolkit is not enabled, blocks with a tool_blocked log.
       */
      const logged =
        <A extends Record<string, unknown>, R>(
          toolName: string,
          handler: (params: A) => Effect.Effect<string, string, R>,
        ) =>
        (params: A): Effect.Effect<string, never, R> => {
          const kit = TOOL_TOOLKIT[toolName];
          // "core", "brain", and "clock" are always-on: skills are universal,
          // and the drone's own notes/attention are its business, not
          // per-conversation config.
          if (
            kit !== "core" &&
            kit !== "brain" &&
            kit !== "clock" &&
            kit !== "data" &&
            (!kit || !enabledToolkits.has(kit))
          ) {
            recordedCalls?.push({
              name: toolName,
              args: params as Record<string, unknown>,
            });
            log({
              type: "tool_blocked",
              toolName,
              reason: "toolkit_not_enabled",
              toolkit: kit ?? "unknown",
            });
            return Effect.succeed("This tool is not available in this conversation.");
          }
          recordedCalls?.push({
            name: toolName,
            args: params as Record<string, unknown>,
          });
          return handler(params).pipe(
            Effect.tap((result) => {
              logToolResult(toolName, params, result, true);
              return Effect.void;
            }),
            Effect.map(truncateResult),
            Effect.catch((error) => {
              const errorMsg = typeof error === "string" ? error : String(error);
              logToolResult(toolName, params, errorMsg, false);
              return Effect.succeed(truncateResult(errorMsg));
            }),
          );
        };

      return AgentToolkit.toLayer({
        view_media: logged("view_media", (params) => handlers.view_media(params)),
        react_to_message: logged("react_to_message", (params) =>
          handlers.react_to_message(params),
        ),
        send_message: logged("send_message", (params) => handlers.send_message(params)),
        search_messages: logged("search_messages", (params) =>
          handlers.search_messages(params),
        ),
        search_conversations: logged("search_conversations", (params) =>
          handlers.search_conversations(params),
        ),
        get_conversation_info: logged("get_conversation_info", (params) =>
          handlers.get_conversation_info(params),
        ),
        send_voice_note: logged("send_voice_note", (params) =>
          handlers.send_voice_note(params),
        ),
        generate_image: logged("generate_image", (params) =>
          generateImageHandler(pendingMedia, xaiExec)(params),
        ),
        generate_video: logged("generate_video", (params) =>
          generateVideoHandler(pendingMedia, xaiExec)(params),
        ),
        bash: logged("bash", (params) => bashHandler(shellExec)(params)),
        bun_run: logged("bun_run", (params) => bunRunHandler(shellExec)(params)),
        use_skill: logged("use_skill", (params) => useSkillHandler(params)),
        get_quote: logged("get_quote", (params) => getQuoteHandler(quoteExec)(params)),
        configure_conversation: (params: {
          readonly conversation_id: string;
          readonly respond_to: string | null;
          readonly trigger: string | null;
        }) => {
          recordedCalls?.push({
            name: "configure_conversation",
            args: params as Record<string, unknown>,
          });
          if (senderRole !== "admin") {
            return Effect.succeed("This tool is not available in this conversation.");
          }
          // Wake turns are role-user so this is unreachable there; the guard
          // is for type soundness (no current conversation to default to).
          const convId = params.conversation_id || currentConvId;
          if (convId === undefined) {
            return Effect.succeed("This tool is not available here.");
          }
          if (!allowedConversationIds.includes(convId)) {
            return Effect.succeed(
              `Blocked: conversation ${convId} is not in the allowlist`,
            );
          }
          const errors: string[] = [];
          const existing = runtimeOverrides.get(convId) ?? {};
          const override: Record<string, unknown> = { ...existing };
          if (params.respond_to !== null) {
            if (params.respond_to === "everyone" || params.respond_to === "admins_only") {
              override.respondTo = params.respond_to;
            } else {
              errors.push(
                `Invalid respond_to: "${params.respond_to}" (expected "everyone" or "admins_only")`,
              );
            }
          }
          if (params.trigger !== null) {
            if (params.trigger === "all_messages" || params.trigger === "mention_only") {
              override.trigger = params.trigger;
            } else {
              errors.push(
                `Invalid trigger: "${params.trigger}" (expected "all_messages" or "mention_only")`,
              );
            }
          }
          if (errors.length > 0) {
            const msg = `Configuration rejected: ${errors.join("; ")}`;
            logToolResult("configure_conversation", params, msg, false);
            return Effect.succeed(msg);
          }
          runtimeOverrides.set(convId, override as Partial<ConversationConfig>);

          // Persist to disk
          let persisted = true;
          if (accountDir) {
            try {
              const config = loadAgentConfig(accountDir);
              const existing = config.conversations[convId] ?? {};
              config.conversations[convId] = {
                ...existing,
                ...override,
              } as ConversationConfig;
              saveAgentConfig(accountDir, config);
            } catch (e) {
              persisted = false;
              logToolResult(
                "configure_conversation",
                params,
                `Persistence failed: ${e}`,
                false,
              );
            }
          }

          const resultMsg = persisted
            ? "Configuration updated."
            : "Configuration updated for this session, but failed to save to disk. Changes will be lost on restart.";
          logToolResult("configure_conversation", params, resultMsg, persisted);
          return Effect.succeed(resultMsg);
        },
        get_conversation_status: (params: { readonly conversation_id: string }) => {
          recordedCalls?.push({
            name: "get_conversation_status",
            args: params as Record<string, unknown>,
          });
          if (senderRole !== "admin") {
            return Effect.succeed("This tool is not available in this conversation.");
          }
          const convId = params.conversation_id || currentConvId;
          if (convId === undefined) {
            return Effect.succeed("This tool is not available here.");
          }
          if (!allowedConversationIds.includes(convId)) {
            return Effect.succeed(
              `Blocked: conversation ${convId} is not in the allowlist`,
            );
          }
          const effective = resolveConversationConfig(
            defaultConversationConfig,
            conversationConfig,
            convId,
            runtimeOverrides,
          );
          const effectiveToolkits =
            isGlobalAdmin && globalAdminToolkits && globalAdminToolkits.length > 0
              ? globalAdminToolkits
              : effective.toolkits;
          const status = [
            `respond_to: ${effective.respondTo}`,
            `trigger: ${effective.trigger}`,
            `toolkits: ${JSON.stringify(effectiveToolkits)}`,
          ].join("\n");
          logToolResult("get_conversation_status", params, status, true);
          return Effect.succeed(status);
        },
        restart_agent: (params: { readonly reason: string | null }) => {
          recordedCalls?.push({
            name: "restart_agent",
            args: params as Record<string, unknown>,
          });
          if (senderRole !== "admin") {
            return Effect.succeed("This tool is not available in this conversation.");
          }

          return Effect.sync(() => {
            const fs = require("node:fs") as typeof import("node:fs");
            const cp = require("node:child_process") as typeof import("node:child_process");
            const path = require("node:path") as typeof import("node:path");

            const asIdx = process.argv.indexOf("--as");
            const aIdx = process.argv.indexOf("-a");
            const flagIdx = asIdx !== -1 ? asIdx : aIdx;
            const handle = flagIdx !== -1 ? process.argv[flagIdx + 1] : null;
            if (!handle) {
              return "Cannot restart: unable to determine account handle from process arguments.";
            }

            // Product repo = xchat-agent-harness (apps/agent/src/tools → ../../../../)
            const repoDir = path.resolve(import.meta.dirname, "../../../..");
            const restartSh = path.join(repoDir, "scripts/restart.sh");
            const logFile = "/tmp/xchat-restart.log";
            if (!fs.existsSync(restartSh)) {
              return `Cannot restart: missing ${restartSh}`;
            }

            const child = cp.spawn("bash", [restartSh, String(handle)], {
              detached: true,
              stdio: "ignore",
              env: { ...process.env, XCHAT_RESTART_REASON: params.reason ?? "" },
            });
            child.unref();

            logToolResult("restart_agent", params, "Restart script spawned", true);
            return `Restarting harness agent now (log: ${logFile}).`;
          });
        },
        brain_list: logged("brain_list", (params) =>
          brainHandlers ? brainHandlers.brain_list(params) : noBrain(),
        ),
        brain_read: logged("brain_read", (params) =>
          brainHandlers ? brainHandlers.brain_read(params) : noBrain(),
        ),
        brain_write: logged("brain_write", (params) =>
          brainHandlers ? brainHandlers.brain_write(params) : noBrain(),
        ),
        schedule_wake: logged("schedule_wake", (params) =>
          clockHandlers ? clockHandlers.schedule_wake(params) : noClock(),
        ),
        edit_wake: logged("edit_wake", (params) =>
          clockHandlers ? clockHandlers.edit_wake(params) : noClock(),
        ),
        cancel_wake: logged("cancel_wake", (params) =>
          clockHandlers ? clockHandlers.cancel_wake(params) : noClock(),
        ),
        list_scheduled_wakes: logged("list_scheduled_wakes", (params) =>
          clockHandlers ? clockHandlers.list_scheduled_wakes(params) : noClock(),
        ),
      });
    }),
  );
