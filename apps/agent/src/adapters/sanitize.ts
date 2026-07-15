/**
 * sanitize.ts — outbound text sanitizer for the xchat channel.
 *
 * DMs render plain text; markdown never renders. The soul and mechanics both
 * say "no markdown" but the model's web-search habit pastes footnote
 * citations anyway (observed live 2026-06-11: a creatine answer with
 * [[1]](pubmed url) straight through two layers of instructions). Same lesson
 * as the capture pass: mechanism beats diligence — the channel's mouth
 * guarantees the property instead of hoping the model honors it.
 *
 * Deliberately conservative: only constructs that are unambiguously markdown
 * go. Single *asterisks* and _underscores_ stay (humans tease with *IT*,
 * snake_case is everywhere), bullets stay (people text with dashes).
 */

/** Strip markdown that DMs can't render from an outbound message. */
export const sanitizeOutboundText = (text: string): string => {
  let out = text;

  // Leaked metadata annotations. Inbound messages are prefixed with
  // bracket metadata ([conversation: ..., message: ..., sender: ..., time:
  // ...]) and the model occasionally mirrors the shape back into outbound
  // text (observed live 2026-06-12: "[msg:2065238330000000000] exactly" —
  // an invented reply-to annotation). Strip leading bracket tags that are
  // clearly OUR metadata vocabulary; never touch brackets mid-sentence
  // (humans write [sic], [insert joke] etc).
  out = out.replace(
    /^\s*\[(?:msg|message|conversation|sender|reply|replying|time)\b[^\]]*\]\s*/i,
    "",
  );

  // Footnote citations: [[1]](url) / [1](url) — pure web-search artifacts,
  // meaningless in a DM. Drop entirely.
  out = out.replace(/\[\[\d+\]\]\([^)]*\)/g, "");
  out = out.replace(/\[\d+\]\(https?:\/\/[^)]*\)/g, "");

  // Inline links: [text](url) → "text (url)" — keep both parts, lose the syntax.
  out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)]+)\)/g, "$1 ($2)");

  // Bold/bold-italic: **text** / ***text*** → text.
  out = out.replace(/\*{2,3}([^*\n]+)\*{2,3}/g, "$1");

  // ATX headers at line start: "## heading" → "heading".
  out = out.replace(/^#{1,6}\s+/gm, "");

  // Code fences: drop the fence lines, keep the code.
  out = out.replace(/^```[^\n]*$/gm, "");

  // Citation removal can leave dangling/doubled spaces.
  out = out.replace(/ +([.,;:!?])/g, "$1");
  out = out.replace(/ {2,}/g, " ");
  out = out.replace(/[ \t]+$/gm, "");

  return out.trim();
};
