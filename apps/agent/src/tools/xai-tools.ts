import type { PendingMedia } from "@x-chat/drone-core";
import { Effect, Schema, SchemaGetter } from "effect";
import { Tool } from "effect/unstable/ai";
import type { XaiMediaExecutor } from "./executors/index.js";
import { isInMediaTmp } from "./media-tmp.js";
import { mimeFromExt } from "./mime.js";
import type { ToolHandler } from "./types.js";

/**
 * Schema that accepts number, string-encoded number, or null → decodes to number | null.
 * Grok sometimes serializes numeric tool params as strings (e.g. duration: "8" instead of 8).
 */
const LenientNumber = Schema.Union([Schema.Number, Schema.String]).pipe(
  Schema.decodeTo(Schema.Number, {
    decode: SchemaGetter.transform((input) =>
      typeof input === "string" ? Number(input) : input,
    ),
    encode: SchemaGetter.transform((n) => n),
  }),
);

/**
 * Whether an optional string param is actually provided. Grok frequently passes
 * "" (empty string), not null, for unused fields (source urls, aspect_ratio,
 * resolution, ...) — both must be treated as "absent". Otherwise we forward the
 * empties to the xAI media API and it rejects them: an empty image url 400s
 * ("must have either 'url' or 'file_id' set"), and an empty aspect_ratio 422s
 * ("unknown variant ``, expected one of `1:1`, ...").
 */
const present = (s: string | null): s is string =>
  typeof s === "string" && s.trim().length > 0;

// ── Valid parameter sets (mirror the live xAI API enums) ──
// Forwarding a value outside these sets 422s the whole request
// ("unknown variant ..."), so we validate and drop unknowns instead. The image
// and video endpoints accept DIFFERENT aspect-ratio and resolution sets.

/** /v1/images/* aspect ratios. */
const IMAGE_ASPECT_RATIOS = new Set([
  "1:1",
  "3:4",
  "4:3",
  "9:16",
  "16:9",
  "2:3",
  "3:2",
  "9:19.5",
  "19.5:9",
  "9:20",
  "20:9",
  "1:2",
  "2:1",
  "auto",
]);
/** /v1/images/* resolutions. */
const IMAGE_RESOLUTIONS = new Set(["1k", "2k"]);
/** /v1/videos/* aspect ratios. */
const VIDEO_ASPECT_RATIOS = new Set(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]);
/** /v1/videos/* resolutions. */
const VIDEO_RESOLUTIONS = new Set(["480p", "720p", "1080p"]);
/** xAI caps video clips at 15s; multi-image edits at 3 source images. */
const MAX_VIDEO_DURATION = 15;
const MAX_EDIT_IMAGES = 3;

/** Return a trimmed value only if present AND in the allowed set; else undefined. */
const validParam = (
  value: string | null,
  allowed: ReadonlySet<string>,
): string | undefined =>
  present(value) && allowed.has(value.trim()) ? value.trim() : undefined;

/**
 * Resolve an image reference to a URL string the API accepts. Local paths
 * (starting with "/") are read and inlined as a base64 data URI; http(s)/data
 * URLs pass through unchanged. Returns null if a local file doesn't exist, is
 * outside the agent's media dir, or the form is unrecognized.
 */
const resolveImageUrl = (url: string): string | null => {
  if (url.startsWith("/")) {
    // Confine reads to the media staging dir — the source path always comes
    // from our own tools (generate_image / view_media). Refusing arbitrary
    // paths blocks exfiltrating files like /etc/passwd or /app/.env via the API.
    if (!isInMediaTmp(url)) return null;
    // biome-ignore format: TypeScript requires typeof import on one line
    const { readFileSync, existsSync } = require("node:fs") as typeof import("node:fs");
    const { basename } = require("node:path") as typeof import("node:path");
    if (!existsSync(url)) return null;
    const bytes = readFileSync(url);
    const ext = basename(url).split(".").pop()?.toLowerCase() ?? "png";
    const mime = mimeFromExt(ext) ?? "image/png";
    return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
  }
  // Only http(s) and data URIs are valid remote forms. Anything else — a bare
  // mediaKey, a hallucinated path — is not a usable source; reject it so the
  // handler can tell the model to call view_media first (instead of 400ing).
  if (
    url.startsWith("http://") ||
    url.startsWith("https://") ||
    url.startsWith("data:")
  ) {
    return url;
  }
  return null;
};

/** Like resolveImageUrl, but for video sources (local mp4 → data URI). */
const resolveVideoUrl = (url: string): string | null => {
  if (url.startsWith("/")) {
    // Same confinement as resolveImageUrl — block arbitrary-file reads.
    if (!isInMediaTmp(url)) return null;
    // biome-ignore format: TypeScript requires typeof import on one line
    const { readFileSync, existsSync } = require("node:fs") as typeof import("node:fs");
    if (!existsSync(url)) return null;
    const bytes = readFileSync(url);
    return `data:video/mp4;base64,${Buffer.from(bytes).toString("base64")}`;
  }
  if (
    url.startsWith("http://") ||
    url.startsWith("https://") ||
    url.startsWith("data:")
  ) {
    return url;
  }
  return null;
};

// ── Generate Image ──

export const GenerateImage = Tool.make("generate_image", {
  description:
    "Generate or edit images using the xAI Imagine API. Modes: (1) Text-to-image: provide just a prompt. (2) Image editing: prompt + source_image_url (a local file path or http/data URL). (3) Multi-image editing: prompt + source_image_url + additional_image_urls (combine subjects/styles/scenes — up to 3 source images total). Optional aspect_ratio (auto, 4:3, 3:4, 16:9, 9:16, 3:2, 2:3, 2:1, 1:2, 1:1) and resolution (1k or 2k); for text-to-image also n (1-10 images). When EDITING, leave aspect_ratio unset (or use auto) to keep the source image's proportions — only set a specific ratio if the user wants to change the shape/crop. Generated images are saved locally and shown to you automatically. Use the returned file path(s) with send_message's media_path to send them.",
  parameters: Schema.Struct({
    prompt: Schema.String,
    source_image_url: Schema.NullOr(Schema.String),
    additional_image_urls: Schema.NullOr(Schema.Array(Schema.String)),
    n: Schema.NullOr(LenientNumber),
    aspect_ratio: Schema.NullOr(Schema.String),
    resolution: Schema.NullOr(Schema.String),
  }),
  success: Schema.String,
});

export const generateImageHandler =
  (
    pendingMedia: Array<PendingMedia>,
    exec: typeof XaiMediaExecutor.Service,
  ): ToolHandler<{
    readonly prompt: string;
    readonly source_image_url: string | null;
    readonly additional_image_urls: readonly string[] | null;
    readonly n: number | null;
    readonly aspect_ratio: string | null;
    readonly resolution: string | null;
  }> =>
  (params) =>
    Effect.gen(function* () {
      // Collect every source image (primary + additional) for editing. Grok
      // passes "" for unused fields, so present() filters those out.
      const sources = [
        params.source_image_url,
        ...(params.additional_image_urls ?? []),
      ].filter(present);
      const isEdit = sources.length > 0;

      // Build request body (pure logic stays in handler; executor stamps model).
      const body: Record<string, unknown> = {
        prompt: params.prompt,
        response_format: "b64_json",
      };

      if (isEdit) {
        // Resolve each source (local path → data URI). The edits endpoint wants
        // an OBJECT for a single image but an ARRAY OF STRINGS for multiple.
        const resolved: string[] = [];
        for (const src of sources.slice(0, MAX_EDIT_IMAGES)) {
          const url = resolveImageUrl(src);
          if (url === null)
            return yield* Effect.fail(
              `Invalid source_image_url "${src}": must be a local file path or http(s)/data URL. If this is a user-sent image, call view_media with its mediaKey first to get a file path, then pass that path here.`,
            );
          resolved.push(url);
        }
        body.image =
          resolved.length === 1 ? { url: resolved[0], type: "image_url" } : resolved;
      } else if (params.n !== null && params.n >= 1 && params.n <= 10) {
        body.n = params.n;
      }

      const ar = validParam(params.aspect_ratio, IMAGE_ASPECT_RATIOS);
      if (ar) body.aspect_ratio = ar;
      // On edits, default to "auto" so the output keeps the SOURCE image's
      // proportions. Without this the model often forces "1:1" and squishes a
      // non-square photo into a square. An explicit ratio (incl. a deliberate
      // "1:1") still wins when the user actually wants to change the shape.
      else if (isEdit) body.aspect_ratio = "auto";
      const res = validParam(params.resolution, IMAGE_RESOLUTIONS);
      if (res) body.resolution = res;

      const endpoint = isEdit
        ? "https://api.x.ai/v1/images/edits"
        : "https://api.x.ai/v1/images/generations";

      // Delegate to executor for API call + save
      const images = yield* exec.generateImages(body, endpoint);

      for (const img of images) {
        pendingMedia.push({
          bytes: img.bytes,
          mimeType: img.mimeType,
          source: "generate",
        });
      }

      if (images.length === 1) {
        return `Done. Image generated and saved to: ${images[0]?.path}\nThe image is now visible to you. Send it using send_message with media_path set to the file path above.`;
      }

      const pathList = images.map((img, i) => `${i + 1}. ${img.path}`).join("\n");
      return `Done. Generated ${images.length} images:\n${pathList}\nThe images are now visible to you. Send them using send_message with media_path set to each file path.`;
    }).pipe(Effect.catch((e) => Effect.fail(`Failed to generate image: ${e}`)));

// ── Generate Video ──

export const GenerateVideo = Tool.make("generate_video", {
  description:
    "Generate, edit, or extend videos using the xAI Imagine API. Only set the parameters relevant to your mode — leave everything else null. Modes: (1) Text-to-video: set prompt only, everything else null. (2) Image-to-video: set prompt + source_image_url, everything else null. (3) Video editing: set prompt + source_video_url, everything else null. (4) Video extension: set prompt + source_video_url + extend=true, everything else null. (5) Reference images: set prompt + reference_image_urls, everything else null. Optional for text/image/reference modes: duration (1-15s), aspect_ratio (1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3), resolution (480p, 720p, or 1080p). Video editing/extension ignore custom duration/aspect/resolution. Generated videos are saved locally and a preview frame is shown to you. Use the returned file path with send_message's media_path to send.",
  parameters: Schema.Struct({
    prompt: Schema.String,
    source_image_url: Schema.NullOr(Schema.String),
    source_video_url: Schema.NullOr(Schema.String),
    extend: Schema.NullOr(Schema.Boolean),
    reference_image_urls: Schema.NullOr(Schema.Array(Schema.String)),
    duration: Schema.NullOr(LenientNumber),
    aspect_ratio: Schema.NullOr(Schema.String),
    resolution: Schema.NullOr(Schema.String),
  }),
  success: Schema.String,
});

export const generateVideoHandler =
  (
    pendingMedia: Array<PendingMedia>,
    exec: typeof XaiMediaExecutor.Service,
  ): ToolHandler<{
    readonly prompt: string;
    readonly source_image_url: string | null;
    readonly source_video_url: string | null;
    readonly extend: boolean | null;
    readonly reference_image_urls: readonly string[] | null;
    readonly duration: number | null;
    readonly aspect_ratio: string | null;
    readonly resolution: string | null;
  }> =>
  (params) =>
    Effect.gen(function* () {
      const isExtend = params.extend === true && present(params.source_video_url);
      const isVideoEdit = !isExtend && present(params.source_video_url);

      // Build request body (pure logic stays in handler; executor stamps model).
      let endpoint: string;
      const body: Record<string, unknown> = {
        prompt: params.prompt,
      };

      const hasDuration =
        params.duration !== null &&
        params.duration >= 1 &&
        params.duration <= MAX_VIDEO_DURATION;

      if (isExtend) {
        endpoint = "https://api.x.ai/v1/videos/extensions";
        const videoUrl = resolveVideoUrl(params.source_video_url as string);
        if (videoUrl === null)
          return yield* Effect.fail(`Source video not found: ${params.source_video_url}`);
        body.video = { url: videoUrl };
        if (hasDuration) body.duration = params.duration;
      } else if (isVideoEdit) {
        endpoint = "https://api.x.ai/v1/videos/edits";
        const videoUrl = resolveVideoUrl(params.source_video_url as string);
        if (videoUrl === null)
          return yield* Effect.fail(`Source video not found: ${params.source_video_url}`);
        body.video = { url: videoUrl };
      } else {
        endpoint = "https://api.x.ai/v1/videos/generations";
        if (present(params.source_image_url)) {
          const imageUrl = resolveImageUrl(params.source_image_url);
          if (imageUrl === null)
            return yield* Effect.fail(
              `Invalid source_image_url "${params.source_image_url}": must be a local file path or http(s)/data URL. If this is a user-sent image, call view_media with its mediaKey first to get a file path, then pass that path here.`,
            );
          body.image = { url: imageUrl, type: "image_url" };
        }

        if (
          params.reference_image_urls !== null &&
          params.reference_image_urls.length > 0
        ) {
          const refs: Array<{ url: string }> = [];
          for (const refUrl of params.reference_image_urls) {
            if (!present(refUrl)) continue;
            const url = resolveImageUrl(refUrl);
            if (url !== null) refs.push({ url });
          }
          if (refs.length > 0) body.reference_images = refs;
        }

        if (hasDuration) body.duration = params.duration;
        const ar = validParam(params.aspect_ratio, VIDEO_ASPECT_RATIOS);
        if (ar) body.aspect_ratio = ar;
        const res = validParam(params.resolution, VIDEO_RESOLUTIONS);
        if (res) body.resolution = res;
      }

      // Delegate to executor for API call + poll + download + save + frame extraction
      const video = yield* exec.generateVideo(body, endpoint);

      if (video.frameBytes) {
        pendingMedia.push({
          bytes: video.frameBytes,
          mimeType: "image/jpeg",
          source: "generate",
        });
      }

      const durationInfo = video.duration ? ` (${video.duration}s)` : "";
      const previewInfo = video.frameBytes
        ? " A preview frame is now visible to you."
        : " Could not extract preview frame.";

      return `Done. Video generated${durationInfo} and saved to: ${video.videoPath}\n${previewInfo}\nSend it using send_message with media_path set to the file path above.`;
    }).pipe(Effect.catch((e) => Effect.fail(`Failed to generate video: ${e}`)));
