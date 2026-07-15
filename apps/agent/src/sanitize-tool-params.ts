/**
 * Recursively strips one layer of wrapping double-quote characters from all
 * string values in a parsed JSON object.
 *
 * The xAI model frequently sends tool call arguments where string values are
 * wrapped in an extra pair of literal quotes, e.g. after JSON.parse a param
 * like conversation_id ends up as `"\"abc123\""` instead of `"abc123"`.
 *
 * This function walks the object tree and removes exactly one layer of
 * surrounding `"` from every string that both starts and ends with `"`.
 */
export function sanitizeToolParams<T>(value: T): T {
  if (typeof value === "string") {
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      return value.slice(1, -1) as T;
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeToolParams) as T;
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = sanitizeToolParams(v);
    }
    return result as T;
  }

  return value;
}
