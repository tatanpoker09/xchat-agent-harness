/**
 * truncate.ts — Tool result size cap utility.
 *
 * Prevents oversized tool results from entering the conversation history.
 * Default cap is 30,000 characters.
 */

const DEFAULT_MAX_CHARS = 30_000;

/**
 * Truncate a tool result string if it exceeds the max character limit.
 * Appends a note indicating the original size when truncated.
 */
export const truncateResult = (result: string, maxChars = DEFAULT_MAX_CHARS): string => {
  if (result.length <= maxChars) return result;
  return `${result.slice(0, maxChars)}\n...[truncated, full output was ${result.length} chars]`;
};
