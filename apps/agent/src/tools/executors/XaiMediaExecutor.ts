/**
 * XaiMediaExecutor -- side-effect service for generate_image / generate_video tools.
 *
 * Live: calls xAI image/video APIs, downloads results, saves to disk, extracts frames.
 * Mock: returns mock bytes and paths without any network or disk I/O.
 */
import { Context, Effect, Layer } from "effect";

import { XaiConfig } from "../../XaiConfig.js";
import { fetchWithTimeout } from "../fetch-with-timeout.js";
import { MEDIA_TMP_DIR } from "../media-tmp.js";
import { extFromMime } from "../mime.js";

// ── Tmp dir ──

const ensureTmpDir = () => {
  const { mkdirSync } = require("node:fs") as typeof import("node:fs");
  mkdirSync(MEDIA_TMP_DIR, { recursive: true });
};

// ── Types ──

export interface GeneratedImage {
  readonly bytes: Uint8Array;
  readonly path: string;
  /** Actual MIME type reported by the API (e.g. quality model returns image/png). */
  readonly mimeType: string;
}

export interface GeneratedVideo {
  readonly videoBytes: Uint8Array;
  readonly videoPath: string;
  readonly duration: number | null;
  readonly frameBytes: Uint8Array | null;
}

// ── Service ──

export class XaiMediaExecutor extends Context.Service<
  XaiMediaExecutor,
  {
    readonly generateImages: (
      body: Record<string, unknown>,
      endpoint: string,
    ) => Effect.Effect<readonly GeneratedImage[], string>;
    readonly generateVideo: (
      body: Record<string, unknown>,
      endpoint: string,
    ) => Effect.Effect<GeneratedVideo, string>;
  }
>()("XaiMediaExecutor") {
  /** Live layer: calls real xAI APIs, saves files, extracts frames. Requires XaiConfig. */
  static liveLayer = Layer.effect(this)(
    Effect.gen(function* () {
      const xaiCfg = yield* XaiConfig;

      return {
        generateImages: (body: Record<string, unknown>, endpoint: string) =>
          Effect.gen(function* () {
            // The configured image model is an xAI-API concern, so the executor
            // owns it — the handler stays model-agnostic.
            const requestBody = { ...body, model: xaiCfg.imageModel };
            const responseData = yield* Effect.tryPromise({
              try: async () => {
                const response = await fetchWithTimeout(
                  endpoint,
                  {
                    method: "POST",
                    headers: {
                      Authorization: `Bearer ${xaiCfg.apiKey}`,
                      "Content-Type": "application/json",
                    },
                    body: JSON.stringify(requestBody),
                  },
                  60_000,
                );
                if (!response.ok) {
                  const errorText = await response.text();
                  throw new Error(`Image API failed (${response.status}): ${errorText}`);
                }
                return (await response.json()) as {
                  data: Array<{ url?: string; b64_json?: string; mime_type?: string }>;
                };
              },
              catch: (e) => `Image generation error: ${e}`,
            });

            ensureTmpDir();
            const { writeFileSync } = require("node:fs") as typeof import("node:fs");
            const { resolve } = require("node:path") as typeof import("node:path");
            const images: GeneratedImage[] = [];
            const ts = Date.now();

            for (let i = 0; i < responseData.data.length; i++) {
              const item = responseData.data[i];
              if (!item) continue;

              let imageBytes: Uint8Array;
              if (item.b64_json) {
                imageBytes = new Uint8Array(Buffer.from(item.b64_json, "base64"));
              } else if (item.url) {
                const imgUrl = item.url;
                const imgResponse = yield* Effect.tryPromise({
                  try: async () => {
                    const resp = await fetch(imgUrl);
                    if (!resp.ok)
                      throw new Error(`Failed to download image: ${resp.status}`);
                    return new Uint8Array(await resp.arrayBuffer());
                  },
                  catch: (e) => `Image download error: ${e}`,
                });
                imageBytes = imgResponse;
              } else {
                continue;
              }

              // Honor the API's reported MIME type — the quality model returns
              // PNG while edits return JPEG. Saving with the wrong extension
              // makes send_message declare the wrong content-type at upload
              // (it derives MIME from the file extension), corrupting the media.
              const mimeType = item.mime_type ?? "image/jpeg";
              const ext = extFromMime(mimeType) ?? "jpg";
              const filePath = resolve(MEDIA_TMP_DIR, `img_${ts}_${i}.${ext}`);
              writeFileSync(filePath, imageBytes);
              images.push({ bytes: imageBytes, path: filePath, mimeType });
            }

            if (images.length === 0) {
              return yield* Effect.fail("Image generation failed: no images returned");
            }
            return images as readonly GeneratedImage[];
          }),

        generateVideo: (body: Record<string, unknown>, endpoint: string) =>
          Effect.gen(function* () {
            const requestBody = { ...body, model: xaiCfg.videoModel };
            // Step 1: Start generation
            const requestId = yield* Effect.tryPromise({
              try: async () => {
                const response = await fetchWithTimeout(
                  endpoint,
                  {
                    method: "POST",
                    headers: {
                      Authorization: `Bearer ${xaiCfg.apiKey}`,
                      "Content-Type": "application/json",
                    },
                    body: JSON.stringify(requestBody),
                  },
                  30_000,
                );
                if (!response.ok) {
                  const errorText = await response.text();
                  throw new Error(`Video API failed (${response.status}): ${errorText}`);
                }
                const data = (await response.json()) as {
                  request_id: string;
                };
                return data.request_id;
              },
              catch: (e) => `Video generation start error: ${e}`,
            });

            // Step 2: Poll for result
            const maxPollMs = 10 * 60 * 1000;
            const pollIntervalMs = 5_000;
            const startTime = Date.now();

            const videoResult = yield* Effect.tryPromise({
              try: async () => {
                while (Date.now() - startTime < maxPollMs) {
                  await new Promise((r) => setTimeout(r, pollIntervalMs));
                  const resp = await fetch(`https://api.x.ai/v1/videos/${requestId}`, {
                    headers: {
                      Authorization: `Bearer ${xaiCfg.apiKey}`,
                    },
                  });
                  if (!resp.ok)
                    throw new Error(
                      `Video poll failed (${resp.status}): ${await resp.text()}`,
                    );
                  const data = (await resp.json()) as {
                    status: "pending" | "done" | "expired" | "failed";
                    video?: {
                      url: string;
                      duration: number;
                    };
                  };
                  if (data.status === "done" && data.video) return data.video;
                  if (data.status === "expired")
                    throw new Error("Video generation request expired");
                  if (data.status === "failed")
                    throw new Error("Video generation failed");
                }
                throw new Error("Video generation timed out after 10 minutes");
              },
              catch: (e) => `Video polling error: ${e}`,
            });

            // Step 3: Download video and save
            ensureTmpDir();
            const { writeFileSync } = require("node:fs") as typeof import("node:fs");
            const { resolve } = require("node:path") as typeof import("node:path");

            const videoBytes = yield* Effect.tryPromise({
              try: async () => {
                const resp = await fetch(videoResult.url);
                if (!resp.ok) throw new Error(`Failed to download video: ${resp.status}`);
                return new Uint8Array(await resp.arrayBuffer());
              },
              catch: (e) => `Video download error: ${e}`,
            });

            const ts = Date.now();
            const videoPath = resolve(MEDIA_TMP_DIR, `video_${ts}.mp4`);
            writeFileSync(videoPath, videoBytes);

            // Step 4: Extract first frame for model preview
            const frameBytes = yield* Effect.tryPromise({
              try: async () => {
                const { spawnSync } = await import("node:child_process");
                const { readFileSync, unlinkSync } = await import("node:fs");
                const framePath = resolve(MEDIA_TMP_DIR, `video_frame_${ts}.jpg`);
                const result = spawnSync(
                  "ffmpeg",
                  ["-y", "-i", videoPath, "-frames:v", "1", "-q:v", "2", framePath],
                  { timeout: 10_000 },
                );
                if (result.status !== 0) return null;
                try {
                  const bytes = new Uint8Array(readFileSync(framePath));
                  unlinkSync(framePath);
                  return bytes;
                } catch {
                  return null;
                }
              },
              catch: () => "frame extraction failed",
            }).pipe(Effect.catch(() => Effect.succeed(null)));

            return {
              videoBytes,
              videoPath,
              duration: videoResult.duration ?? null,
              frameBytes,
            } satisfies GeneratedVideo;
          }),
      };
    }),
  );

  /** Mock layer: returns valid placeholder image bytes and mock paths without any I/O. */
  static mockLayer = Layer.succeed(this)({
    generateImages: (body: Record<string, unknown>) => {
      const n = typeof body.n === "number" && body.n > 0 ? body.n : 1;
      const images: GeneratedImage[] = Array.from({ length: n }, (_, i) => ({
        bytes: new Uint8Array(0),
        path: `${MEDIA_TMP_DIR}/img_mock_${i}.jpg`,
        mimeType: "image/jpeg",
      }));
      return Effect.succeed<readonly GeneratedImage[]>(images);
    },
    generateVideo: () =>
      Effect.succeed<GeneratedVideo>({
        videoBytes: new Uint8Array(0),
        videoPath: `${MEDIA_TMP_DIR}/video_mock.mp4`,
        duration: 5,
        frameBytes: null,
      }),
  });
}
