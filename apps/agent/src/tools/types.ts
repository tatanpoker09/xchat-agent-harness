/**
 * types.ts — Shared tool handler type.
 *
 * Every tool handler must conform to this contract:
 *   (params: P) => Effect<string, E, R>
 *
 * Dependencies (API keys, pending media, etc.) are pre-bound via a factory
 * function so that the returned handler always has this uniform shape.
 */
import type { Effect } from "effect";

/**
 * A tool handler takes validated params and returns an Effect that produces
 * a string result. Handlers may fail with a string error which is caught
 * and surfaced by the `logged()` wrapper in xchat-tools.
 *
 * @typeParam P - The validated parameter object for this tool.
 * @typeParam E - Error type. Defaults to string.
 * @typeParam R - Effect requirements (e.g. ChatContext). Defaults to never.
 */
export type ToolHandler<P, E = string, R = never> = (
  params: P,
) => Effect.Effect<string, E, R>;
