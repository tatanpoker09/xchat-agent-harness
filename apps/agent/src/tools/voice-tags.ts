/**
 * Canonical xAI TTS expressive tags — the SINGLE source of truth, verified live
 * against POST /v1/tts via a TTS->STT round-trip (a performed tag is absent from
 * the transcription; a spoken one shows up).
 *
 * Both model-facing copies — the system prompt's "Speaking" section and the
 * send_voice_note tool description — derive their tag lists from here so they
 * can't drift. This matters: an undocumented or wrong-form tag isn't ignored;
 * TTS reads it out loud. The AGENTS.md voice section points back to this file.
 */

/** Inline tags — written `[tag]` at the point the expression happens. */
export const TTS_INLINE_TAGS = [
  "[laugh]",
  "[chuckle]",
  "[giggle]",
  "[cry]",
  "[sigh]",
  "[pause]",
  "[long-pause]",
  "[breath]",
  "[inhale]",
  "[exhale]",
  "[tsk]",
  "[lip-smack]",
  "[tongue-click]",
  "[hum-tune]",
] as const;

/** Wrapping tags (bare names) — written `<tag>…</tag>` around the affected words. */
export const TTS_WRAPPING_TAGS = [
  "whisper",
  "soft",
  "loud",
  "slow",
  "fast",
  "emphasis",
  "higher-pitch",
  "lower-pitch",
  "singing",
  "sing-song",
  "laugh-speak",
  "build-intensity",
  "decrease-intensity",
] as const;

/** Space-separated inline tags, e.g. `[laugh] [chuckle] …`. */
export const TTS_INLINE_LIST = TTS_INLINE_TAGS.join(" ");

/** Space-separated wrapping tags as `<tag>`, e.g. `<whisper> <soft> …`. */
export const TTS_WRAPPING_LIST = TTS_WRAPPING_TAGS.map((t) => `<${t}>`).join(" ");
