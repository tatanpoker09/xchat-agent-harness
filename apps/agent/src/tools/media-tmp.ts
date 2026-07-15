/**
 * Shared staging directory for agent media (generated images/videos and
 * downloaded user media). Centralized so the security confinement check
 * (isInMediaTmp) can never drift from where files are actually written.
 */
import { resolve } from "node:path";

export const MEDIA_TMP_DIR = "/tmp/xchat-agent";

/**
 * Whether an absolute path is confined to MEDIA_TMP_DIR (after normalizing any
 * ".." traversal). Used to reject arbitrary-file reads via the LLM-supplied
 * source_image_url / source_video_url params — without this, a path like
 * "/etc/passwd" or "/app/.env" would be read off disk and base64'd to the xAI
 * API. Every legitimate source path comes from our own tools (generate_image /
 * view_media), which only ever write under MEDIA_TMP_DIR.
 */
export const isInMediaTmp = (absPath: string): boolean => {
  const norm = resolve(absPath);
  return norm === MEDIA_TMP_DIR || norm.startsWith(`${MEDIA_TMP_DIR}/`);
};
