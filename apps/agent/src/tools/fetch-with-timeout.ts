/**
 * fetch-with-timeout.ts — Shared fetch wrapper with AbortController timeout.
 *
 * Replaces the duplicated AbortController + setTimeout + fetch + clearTimeout
 * pattern used across tool files.
 */

/**
 * Fetch with an automatic abort timeout.
 *
 * Creates an AbortController, arms a timeout that fires `controller.abort()`,
 * issues the fetch, and cleans up the timer in a `finally` block so it never
 * leaks — regardless of whether the request succeeds, fails, or throws.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  // If the caller already supplied a signal, compose it with ours so that
  // either the caller's abort *or* our timeout will cancel the request.
  const signal =
    init.signal != null
      ? AbortSignal.any([init.signal, controller.signal])
      : controller.signal;

  try {
    return await fetch(url, { ...init, signal });
  } finally {
    clearTimeout(timeout);
  }
}
