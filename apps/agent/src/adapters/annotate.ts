/**
 * Pure helpers for annotating an inbound message's attachment in the text we
 * hand the model. Kept dependency-free so it's trivially unit-testable.
 */

/** Minimal structural shape of a domain message attachment. */
export interface AttachmentLike {
  readonly kind: string;
  readonly mediaInfo?: { readonly mediaHashKey?: string | null } | null;
  readonly postInfo?: {
    readonly postId?: string | null;
    readonly postUrl?: string | null;
  } | null;
}

/**
 * Describe an attachment for the model. Shapes:
 *  - media (image/video/audio/gif): "IMAGE attached, mediaKey: K, conversationId: C"
 *    → the model calls view_media with the mediaKey.
 *  - shared X post: "post attached: https://x.com/..." → the model can read the
 *    post + its whole thread (text AND images/videos) via its X search ability.
 *  - anything else: "<kind> attached".
 */
export const attachmentDescriptor = (
  attachment: AttachmentLike,
  conversationId: string,
): string => {
  const mediaKey = attachment.mediaInfo?.mediaHashKey;
  if (mediaKey) {
    return `${attachment.kind} attached, mediaKey: ${mediaKey}, conversationId: ${conversationId}`;
  }
  const postUrl = attachment.postInfo?.postUrl;
  if (postUrl) {
    return `${attachment.kind} attached: ${postUrl}`;
  }
  const postId = attachment.postInfo?.postId;
  if (postId) {
    return `${attachment.kind} attached, postId: ${postId}`;
  }
  return `${attachment.kind} attached`;
};

/**
 * Build the bracketed attachment annotation block for a message that may carry
 * SEVERAL attachments (e.g. 2–4 photos in one DM). Emits one `[... attached …]`
 * line per attachment so the model sees EVERY mediaKey (and can `view_media`
 * each one) instead of only the first. Returns "" when there are none.
 *
 * When more than one attachment is present, each line is prefixed with its
 * 1-based index (e.g. `[image 2/3 attached, mediaKey: …]`) so the model can
 * tell them apart.
 */
export const attachmentAnnotations = (
  attachments: ReadonlyArray<AttachmentLike>,
  conversationId: string,
): string => {
  if (attachments.length === 0) return "";
  const multiple = attachments.length > 1;
  return attachments
    .map((a, i) => {
      const desc = attachmentDescriptor(a, conversationId);
      return multiple ? `[${i + 1}/${attachments.length} ${desc}]` : `[${desc}]`;
    })
    .join("\n");
};
