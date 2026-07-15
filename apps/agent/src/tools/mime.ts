/**
 * Shared MIME type mapping used across tool handlers.
 *
 * Union of all extensions previously hard-coded in xai-tools.ts and xchat-tools.ts.
 */
export const MIME_MAP: Record<string, string> = {
  // Images
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  // Video
  mp4: "video/mp4",
  mov: "video/quicktime",
  // Audio
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  // Documents
  pdf: "application/pdf",
};

/**
 * Look up the MIME type for a file extension (without the leading dot).
 *
 * @example mimeFromExt("jpg") // "image/jpeg"
 */
export function mimeFromExt(ext: string): string | undefined {
  const key = ext.startsWith(".") ? ext.slice(1) : ext;
  return MIME_MAP[key.toLowerCase()];
}

/**
 * Look up a file extension (without the leading dot) for a MIME type. The
 * inverse of mimeFromExt; a content-type suffix like ";charset" is ignored.
 *
 * @example extFromMime("image/png") // "png"
 */
export function extFromMime(mime: string): string | undefined {
  const key = mime.toLowerCase().split(";")[0]?.trim();
  if (!key) return undefined;
  for (const [ext, value] of Object.entries(MIME_MAP)) {
    if (value === key) return ext;
  }
  return undefined;
}
