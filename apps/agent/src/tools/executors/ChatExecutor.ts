/**
 * ChatExecutor -- side-effect service for xchat-tools handlers.
 *
 * Live: wraps Chat SDK calls, xAI audio APIs, and ffmpeg processing.
 * Mock: returns mock structured data from evalCase.mockMedia etc.
 */
import {
  Chat,
  ChatContext,
  ConversationId,
  SendMessage,
  UserId,
} from "@x-chat/xchat-sdk";
import { Context, Effect, Layer } from "effect";

import { XaiConfig } from "../../XaiConfig.js";
import { fetchWithTimeout } from "../fetch-with-timeout.js";
import { MEDIA_TMP_DIR } from "../media-tmp.js";
import { extFromMime, mimeFromExt } from "../mime.js";

// ── Types ──

export type ViewMediaResult =
  | {
      readonly _tag: "image";
      readonly bytes: Uint8Array;
      readonly mimeType: string;
      /** On-disk path of the saved image, so the model can edit/animate it. */
      readonly path: string;
    }
  | { readonly _tag: "audio"; readonly transcription: string }
  | {
      readonly _tag: "video";
      readonly frameBytes: Uint8Array | null;
      /** On-disk path of the extracted frame (usable as a source image). */
      readonly framePath: string | null;
    }
  | {
      readonly _tag: "gif";
      readonly frameBytes: Uint8Array | null;
      readonly framePath: string | null;
    }
  | {
      readonly _tag: "unsupported";
      readonly mediaType: string | null;
      readonly mimeType: string;
    };

export type MediaKind = "audio" | "gif" | "image" | "video" | "unsupported";

/**
 * Decide how to handle a downloaded media item from its stored type + mimeType.
 *
 * A media item sent as a generic FILE attachment arrives with type=FILE (not
 * VIDEO/IMAGE/AUDIO), so its real kind has to be read off the mimeType — a
 * file-attached video/mp4 otherwise fell through to "unsupported" (observed
 * live in prod 2026-06-16). An absent or FILE wrapper means "route by
 * mimeType"; a specific wrapper (GIF especially) wins so animated gifs still
 * get first-frame treatment instead of being staged as a static image.
 */
export const classifyMedia = (mediaType: string | null, mimeType: string): MediaKind => {
  const byMime = !mediaType || mediaType === "FILE";
  if (mediaType === "AUDIO" || (byMime && mimeType.startsWith("audio/"))) {
    return "audio";
  }
  if (mediaType === "GIF") return "gif";
  if (mediaType === "IMAGE" || (byMime && mimeType.startsWith("image/"))) {
    return "image";
  }
  if (mediaType === "VIDEO" || (byMime && mimeType.startsWith("video/"))) {
    return "video";
  }
  return "unsupported";
};

export interface SendMessageResult {
  readonly messageId: string;
}

export interface MessageSearchHit {
  readonly conversationId: string;
  readonly senderName: string | null;
  readonly text: string | null;
}

export interface ConversationSearchHit {
  readonly id: string;
  readonly displayTitle: string;
}

export type ConversationDetail =
  | {
      readonly _tag: "group";
      readonly displayTitle: string;
      readonly memberCount: number;
      readonly memberNames: readonly string[];
    }
  | {
      readonly _tag: "direct";
      readonly displayTitle: string;
      readonly otherUserName: string;
    };

// ── Service ──

export class ChatExecutor extends Context.Service<
  ChatExecutor,
  {
    readonly viewMedia: (
      convId: string,
      mediaKey: string,
    ) => Effect.Effect<ViewMediaResult, string>;
    readonly reactToMessage: (
      convId: string,
      messageId: string,
      emoji: string,
    ) => Effect.Effect<void, string>;
    readonly sendMessage: (
      convId: string,
      text: string | null,
      mediaPath: string | null,
    ) => Effect.Effect<SendMessageResult, string>;
    readonly searchMessages: (
      query: string,
      fromUserId: string | null,
      hasAttachment: boolean | null,
      limit: number,
    ) => Effect.Effect<readonly MessageSearchHit[], string>;
    readonly searchConversations: (
      query: string,
    ) => Effect.Effect<readonly ConversationSearchHit[], string>;
    readonly getConversationDetail: (
      convId: string,
    ) => Effect.Effect<ConversationDetail, string>;
    readonly sendVoiceNote: (convId: string, text: string) => Effect.Effect<void, string>;
  }
>()("ChatExecutor") {
  /** Live layer: wraps real Chat SDK and xAI APIs. Requires ChatContext + XaiConfig. */
  static liveLayer = Layer.effect(this)(
    Effect.gen(function* () {
      const chatCtx = yield* ChatContext;
      const xaiCfg = yield* XaiConfig;

      const provide = <A, E>(eff: Effect.Effect<A, E, ChatContext>) =>
        Effect.provideService(eff, ChatContext, chatCtx);

      return {
        viewMedia: (convId: string, mediaKey: string) =>
          provide(
            Effect.gen(function* () {
              const mediaRow = yield* chatCtx.storage
                .getMediaByHashKey(mediaKey)
                .pipe(Effect.catch(() => Effect.succeed(null)));
              const mediaType = mediaRow?.type?.toUpperCase() ?? null;

              const { bytes, mimeType } = yield* Chat.media
                .download(ConversationId.make(convId), mediaKey)
                .pipe(Effect.mapError(() => "Failed to download media"));

              const kind = classifyMedia(mediaType, mimeType);

              if (kind === "audio") {
                const transcription = yield* transcribeAudio(
                  bytes,
                  mimeType,
                  xaiCfg.sttApiKey,
                );
                return { _tag: "audio" as const, transcription };
              }

              if (kind === "gif") {
                const frame = yield* extractFirstFrame(bytes);
                const framePath = frame ? saveMediaToTmp(frame, "image/jpeg") : null;
                return { _tag: "gif" as const, frameBytes: frame, framePath };
              }

              if (kind === "image") {
                // Stage the image on disk so the model can pass this path back as
                // generate_image's source_image_url to edit/restyle it.
                const path = saveMediaToTmp(bytes, mimeType);
                return { _tag: "image" as const, bytes, mimeType, path };
              }

              if (kind === "video") {
                const frame = yield* extractFirstFrame(bytes);
                const framePath = frame ? saveMediaToTmp(frame, "image/jpeg") : null;
                return { _tag: "video" as const, frameBytes: frame, framePath };
              }

              return {
                _tag: "unsupported" as const,
                mediaType,
                mimeType,
              } satisfies ViewMediaResult;
            }),
          ).pipe(Effect.mapError((e) => (typeof e === "string" ? e : String(e)))),

        reactToMessage: (convId: string, messageId: string, emoji: string) =>
          provide(
            Chat.messages.react(ConversationId.make(convId), messageId, emoji),
          ).pipe(Effect.mapError(() => "Failed to react")),

        sendMessage: (convId: string, text: string | null, mediaPath: string | null) =>
          provide(
            Effect.gen(function* () {
              const sendOpts: {
                text?: string;
                media?: {
                  fileBytes: Uint8Array;
                  filename: string;
                  mimeType: string;
                  durationMs?: number;
                  dimensions?: { width: number; height: number };
                };
              } = {};

              if (text) sendOpts.text = text;

              if (mediaPath) {
                // biome-ignore format: TypeScript requires typeof import on one line
                const { readFileSync, existsSync } = require("node:fs") as typeof import("node:fs");
                const { basename } = require("node:path") as typeof import("node:path");

                let fileBytes: Uint8Array;
                if (mediaPath.startsWith("http://") || mediaPath.startsWith("https://")) {
                  const resp = yield* Effect.tryPromise({
                    try: async () => {
                      const r = await fetch(mediaPath);
                      if (!r.ok) throw new Error(`Download failed: ${r.status}`);
                      return new Uint8Array(await r.arrayBuffer());
                    },
                    catch: (e) => `Failed to download media: ${e}`,
                  });
                  fileBytes = resp;
                } else {
                  if (!existsSync(mediaPath)) {
                    return yield* Effect.fail(`File not found: ${mediaPath}`);
                  }
                  fileBytes = new Uint8Array(readFileSync(mediaPath));
                }
                const filename = basename(mediaPath);
                const ext = filename.split(".").pop()?.toLowerCase() ?? "";
                const mime = mimeFromExt(ext) ?? "application/octet-stream";

                let durationMs: number | undefined;
                let dimensions: { width: number; height: number } | undefined;
                const isAudioVideo =
                  mime.startsWith("audio/") || mime.startsWith("video/");
                const isImage = mime.startsWith("image/");
                if (isAudioVideo || isImage) {
                  try {
                    const cp = require("node:child_process");
                    const { spawnSync } = cp as typeof import("node:child_process");
                    if (
                      !mediaPath.startsWith("http://") &&
                      !mediaPath.startsWith("https://")
                    ) {
                      const probe = spawnSync(
                        "ffprobe",
                        [
                          "-v",
                          "quiet",
                          "-show_entries",
                          "format=duration:stream=width,height",
                          "-of",
                          "json",
                          mediaPath,
                        ],
                        { timeout: 5_000 },
                      );
                      const probeData = JSON.parse(
                        probe.stdout?.toString().trim() || "{}",
                      );
                      const dur = Number.parseFloat(probeData?.format?.duration || "0");
                      if (dur > 0) durationMs = Math.round(dur * 1000);
                      const stream = probeData?.streams?.[0];
                      if (stream?.width && stream?.height) {
                        dimensions = {
                          width: stream.width,
                          height: stream.height,
                        };
                      }
                    }
                  } catch {
                    // Probe failed, send without metadata
                  }
                }

                sendOpts.media = {
                  fileBytes,
                  filename,
                  mimeType: mime,
                  durationMs,
                  dimensions,
                };
              }

              const result = yield* Chat.messages.send(
                ConversationId.make(convId),
                SendMessage.make(sendOpts),
              );
              return { messageId: result.messageId };
            }),
          ).pipe(
            Effect.mapError((e) => (typeof e === "string" ? e : `Failed to send: ${e}`)),
          ),

        searchMessages: (
          query: string,
          fromUserId: string | null,
          hasAttachment: boolean | null,
          limit: number,
        ) =>
          provide(
            Effect.gen(function* () {
              const filter: { from?: UserId; hasAttachment?: boolean } = {};
              if (fromUserId) filter.from = UserId.make(fromUserId);
              if (hasAttachment) filter.hasAttachment = true;
              const results = yield* Chat.search.messages(query, {
                filter,
                limit,
              });
              return results.map((r) => ({
                conversationId: r.conversationId,
                senderName: r.senderName ?? null,
                text: r.text ?? null,
              }));
            }),
          ).pipe(Effect.mapError((e) => `Search failed: ${e}`)),

        searchConversations: (query: string) =>
          provide(
            Effect.gen(function* () {
              const results = yield* Chat.search.conversations(query);
              return results.map((c) => ({
                id: c.id,
                displayTitle: c.displayTitle,
              }));
            }),
          ).pipe(Effect.mapError((e) => `Search failed: ${e}`)),

        getConversationDetail: (convId: string) =>
          provide(
            Effect.gen(function* () {
              const detail = yield* Chat.conversation.detail(ConversationId.make(convId));

              if (detail.type === "group") {
                const members = detail.memberPreview.map((m) => {
                  const user = m.user;
                  return user._tag === "ResolvedUser"
                    ? `${user.displayName} (@${user.screenName})`
                    : `User ${user.userId} (loading...)`;
                });
                return {
                  _tag: "group" as const,
                  displayTitle: detail.displayTitle,
                  memberCount: detail.memberCount,
                  memberNames: members,
                };
              }

              const otherUser = detail.otherUser;
              const otherName =
                otherUser._tag === "ResolvedUser"
                  ? `${otherUser.displayName} (@${otherUser.screenName})`
                  : `User ${otherUser.userId}`;
              return {
                _tag: "direct" as const,
                displayTitle: detail.displayTitle,
                otherUserName: otherName,
              };
            }),
          ).pipe(Effect.mapError((e) => `Failed to get info: ${e}`)),

        sendVoiceNote: (convId: string, text: string) =>
          provide(
            Effect.gen(function* () {
              const mp3Bytes = yield* Effect.tryPromise({
                try: async () => {
                  const apiKey = xaiCfg.apiKey;
                  if (!apiKey) throw new Error("XAI_API_KEY not configured");
                  const response = await fetchWithTimeout(
                    "https://api.x.ai/v1/tts",
                    {
                      method: "POST",
                      headers: {
                        Authorization: `Bearer ${apiKey}`,
                        "Content-Type": "application/json",
                      },
                      body: JSON.stringify({
                        // xAI TTS voice ids are lowercase: eve | ara | rex | sal | leo.
                        // `text` may carry expressive tags the engine performs (not
                        // speaks). The canonical tag set lives in tools/voice-tags.ts
                        // and is injected into the model's prompt + send_voice_note
                        // description from there; a wrong/unknown tag is read aloud.
                        text,
                        voice_id: "rex",
                        output_format: {
                          codec: "mp3",
                          sample_rate: 44100,
                          bit_rate: 128000,
                        },
                        language: "en",
                      }),
                    },
                    30_000,
                  );
                  if (!response.ok) throw new Error(`TTS API failed: ${response.status}`);
                  return new Uint8Array(await response.arrayBuffer());
                },
                catch: (e) => `TTS error: ${e}`,
              });

              const { m4aBytes, durationMs } = yield* Effect.tryPromise({
                try: async () => {
                  const { spawnSync } = await import("node:child_process");
                  const { writeFileSync, readFileSync, unlinkSync } = await import(
                    "node:fs"
                  );
                  const { resolve } = await import("node:path");
                  const { tmpdir } = await import("node:os");

                  const ts = Date.now();
                  const mp3Path = resolve(tmpdir(), `tts_${ts}.mp3`);
                  const m4aPath = resolve(tmpdir(), `tts_${ts}.m4a`);
                  writeFileSync(mp3Path, mp3Bytes);

                  const result = spawnSync(
                    "ffmpeg",
                    [
                      "-y",
                      "-i",
                      mp3Path,
                      "-ac",
                      "1",
                      "-channel_layout",
                      "mono",
                      "-c:a",
                      "aac",
                      "-b:a",
                      "128k",
                      m4aPath,
                    ],
                    { timeout: 10_000 },
                  );
                  if (result.status !== 0)
                    throw new Error(`ffmpeg exited with code ${result.status}`);

                  const probe = spawnSync(
                    "ffprobe",
                    [
                      "-v",
                      "quiet",
                      "-show_entries",
                      "format=duration",
                      "-of",
                      "csv=p=0",
                      m4aPath,
                    ],
                    { timeout: 5_000 },
                  );
                  const durationSec = Number.parseFloat(
                    probe.stdout?.toString().trim() || "0",
                  );
                  const probedDurationMs =
                    durationSec > 0 ? Math.round(durationSec * 1000) : undefined;
                  const m4a = new Uint8Array(readFileSync(m4aPath));
                  unlinkSync(mp3Path);
                  unlinkSync(m4aPath);
                  return { m4aBytes: m4a, durationMs: probedDurationMs };
                },
                catch: (e) => `MP3 to M4A conversion error: ${e}`,
              });

              yield* Chat.messages.send(
                ConversationId.make(convId),
                SendMessage.make({
                  media: {
                    fileBytes: m4aBytes,
                    filename: `voice_note_${Date.now()}.m4a`,
                    mimeType: "audio/mp4",
                    durationMs,
                  },
                }),
              );
            }),
          ).pipe(
            Effect.mapError((e) =>
              typeof e === "string" ? e : `Failed to send voice note: ${e}`,
            ),
          ),
      };
    }),
  );

  /** Mock layer factory: returns mock structured data for evals. */
  static mockLayer = (
    mockMedia?: Record<
      string,
      | { readonly type: "image"; readonly bytes: Uint8Array; readonly mimeType: string }
      | { readonly type: "video"; readonly bytes: Uint8Array; readonly mimeType: string }
      | { readonly type: "audio" }
    >,
  ) =>
    Layer.succeed(ChatExecutor)({
      viewMedia: (_convId: string, mediaKey: string) => {
        const data = mockMedia?.[mediaKey];
        if (!data)
          return Effect.succeed<ViewMediaResult>({
            _tag: "unsupported",
            mediaType: null,
            mimeType: "unknown",
          });
        if (data.type === "image")
          return Effect.succeed<ViewMediaResult>({
            _tag: "image",
            bytes: data.bytes,
            mimeType: data.mimeType,
            path: `${MEDIA_TMP_DIR}/view_mock_${mediaKey}.jpg`,
          });
        if (data.type === "audio")
          return Effect.succeed<ViewMediaResult>({
            _tag: "audio",
            transcription: "This is a mock transcription of the audio.",
          });
        if (data.type === "video")
          return Effect.succeed<ViewMediaResult>({
            _tag: "video",
            frameBytes: data.bytes,
            framePath: `${MEDIA_TMP_DIR}/view_mock_${mediaKey}.jpg`,
          });
        return Effect.succeed<ViewMediaResult>({
          _tag: "unsupported",
          mediaType: null,
          mimeType: "unknown",
        });
      },
      reactToMessage: () => Effect.succeed(undefined as undefined),
      sendMessage: () =>
        Effect.succeed<SendMessageResult>({
          messageId: `${Date.now()}${Math.floor(Math.random() * 1e6)}`,
        }),
      searchMessages: () => Effect.succeed<readonly MessageSearchHit[]>([]),
      searchConversations: () => Effect.succeed<readonly ConversationSearchHit[]>([]),
      getConversationDetail: () =>
        Effect.succeed<ConversationDetail>({
          _tag: "group",
          displayTitle: "Test Group",
          memberCount: 2,
          memberNames: ["Alice", "Bob"],
        }),
      sendVoiceNote: () => Effect.succeed(undefined as undefined),
    });
}

// ── Internal helpers (from xchat-tools.ts) ──

/**
 * Stage downloaded media on disk so the model can reference it by path (e.g.
 * pass it as generate_image's source_image_url). Mirrors where XaiMediaExecutor
 * saves generated media. The extension matches the MIME type so a later
 * send_message (which derives content-type from the extension) stays correct.
 */
const saveMediaToTmp = (bytes: Uint8Array, mimeType: string): string => {
  // biome-ignore format: TypeScript requires typeof import on one line
  const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  const { resolve } = require("node:path") as typeof import("node:path");
  mkdirSync(MEDIA_TMP_DIR, { recursive: true });
  const ext = extFromMime(mimeType) ?? "jpg";
  const path = resolve(
    MEDIA_TMP_DIR,
    `view_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`,
  );
  writeFileSync(path, bytes);
  return path;
};

const transcribeAudio = (bytes: Uint8Array, mimeType: string, sttApiKey: string) =>
  Effect.tryPromise({
    try: async () => {
      if (!sttApiKey) throw new Error("XAI API key not configured for STT");
      const ext = mimeType.includes("mp4") ? "m4a" : (mimeType.split("/")[1] ?? "m4a");
      const formData = new FormData();
      const ab = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(ab).set(bytes);
      formData.append("file", new Blob([ab], { type: mimeType }), `audio.${ext}`);

      // xAI Speech-to-Text: POST /v1/stt with a multipart `file`. Responds with
      // JSON `{ text, language, duration, words: [...] }`, so we read `.text`.
      const response = await fetchWithTimeout(
        "https://api.x.ai/v1/stt",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${sttApiKey}` },
          body: formData,
        },
        30_000,
      );
      if (!response.ok) throw new Error(`Transcription failed: ${response.status}`);
      const result = (await response.json()) as { text: string };
      return result.text.trim();
    },
    catch: (e) => `Transcription error: ${e}`,
  });

const FFMPEG_TIMEOUT_MS = 10_000;

const extractFirstFrame = (videoBytes: Uint8Array) =>
  Effect.tryPromise({
    try: async () => {
      const { spawn } = await import("node:child_process");
      const { writeFileSync, unlinkSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { resolve } = await import("node:path");

      const tmpFile = resolve(tmpdir(), `frame-${Date.now()}.bin`);
      writeFileSync(tmpFile, videoBytes);

      try {
        const proc = spawn("ffmpeg", [
          "-i",
          tmpFile,
          "-vframes",
          "1",
          "-f",
          "image2pipe",
          "-vcodec",
          "mjpeg",
          "pipe:1",
        ]);

        const timeout = setTimeout(() => proc.kill("SIGKILL"), FFMPEG_TIMEOUT_MS);
        const chunks: Uint8Array[] = [];
        proc.stdout.on("data", (chunk: Buffer) => chunks.push(new Uint8Array(chunk)));
        proc.stderr.on("data", () => {});

        const exitCode = await new Promise<number>((resolve) =>
          proc.on("close", resolve),
        );
        clearTimeout(timeout);
        if (exitCode !== 0 || chunks.length === 0) return null;

        const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
        const result = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
          result.set(chunk, offset);
          offset += chunk.length;
        }
        return result;
      } finally {
        try {
          unlinkSync(tmpFile);
        } catch {}
      }
    },
    catch: () => null,
  });
