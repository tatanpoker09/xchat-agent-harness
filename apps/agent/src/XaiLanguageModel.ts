import { Effect, Layer, Schedule, Schema, Stream } from "effect";
import * as Context from "effect/Context";
/**
 * XaiLanguageModel.ts — Custom xAI LanguageModel provider for Effect AI.
 *
 * Replaces @effect/ai-openai to support:
 * - xAI native tools (web_search, x_search)
 * - previous_response_id for stateful conversations
 * - Clean Responses API integration without format hacks
 */
import { dual } from "effect/Function";
import {
  AiError,
  LanguageModel,
  type Prompt,
  type Response,
  Tool,
} from "effect/unstable/ai";
import { HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { XaiConfig } from "./XaiConfig.js";
import { log } from "./logger.js";
import { sanitizeToolParams } from "./sanitize-tool-params.js";

// ── xAI Responses API types ──

interface XaiAnnotation {
  readonly type: string;
  readonly url?: string;
  readonly title?: string;
}

interface XaiOutputText {
  readonly type: "output_text";
  readonly text: string;
  readonly annotations: ReadonlyArray<XaiAnnotation>;
}

interface XaiMessageItem {
  readonly type: "message";
  readonly content: ReadonlyArray<XaiOutputText | { readonly type: string }>;
}

interface XaiFunctionCallItem {
  readonly type: "function_call";
  readonly call_id: string;
  readonly name: string;
  readonly arguments: string;
}

type XaiOutputItem =
  | XaiMessageItem
  | XaiFunctionCallItem
  | { readonly type: "web_search_call" }
  | { readonly type: "custom_tool_call" }
  | { readonly type: "reasoning" };

interface XaiUsage {
  readonly input_tokens?: number;
  readonly input_tokens_details?: { readonly cached_tokens?: number };
  readonly output_tokens?: number;
  readonly output_tokens_details?: { readonly reasoning_tokens?: number };
}

interface XaiResponseBody {
  readonly id: string;
  readonly model: string;
  readonly completed_at?: number;
  readonly output: ReadonlyArray<XaiOutputItem>;
  readonly usage?: XaiUsage;
}

const XaiResponseBody_ = Schema.Struct({
  id: Schema.String,
  model: Schema.String,
  completed_at: Schema.optional(Schema.Number),
  output: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  usage: Schema.optional(
    Schema.Struct({
      input_tokens: Schema.optional(Schema.Number),
      input_tokens_details: Schema.optional(
        Schema.Struct({ cached_tokens: Schema.optional(Schema.Number) }),
      ),
      output_tokens: Schema.optional(Schema.Number),
      output_tokens_details: Schema.optional(
        Schema.Struct({ reasoning_tokens: Schema.optional(Schema.Number) }),
      ),
    }),
  ),
});

// ── Server-side tools ──

/**
 * Build an xAI server-side tool entry for the Responses API `tools` array.
 *
 * x_search gets the image/video understanding flags turned on so Grok actually
 * reads the pictures and clips in X posts (e.g. a shared post + its whole
 * thread), not just the text. Without enable_image_understanding the tool fetches
 * threads but ignores their images — verified live against a 8-image thread.
 */
export const buildServerTool = (
  name: "web_search" | "x_search",
  opts: {
    readonly imageUnderstanding: boolean;
    readonly videoUnderstanding: boolean;
  },
): Record<string, unknown> =>
  name === "x_search"
    ? {
        type: "x_search",
        enable_image_understanding: opts.imageUnderstanding,
        enable_video_understanding: opts.videoUnderstanding,
      }
    : { type: name };

// ── Retry + error handling ──

/**
 * A non-2xx response from the xAI API. Carries the raw response body so the
 * actual provider error (e.g. "Service temporarily unavailable") shows up in
 * logs instead of being swallowed by `HttpClient.filterStatusOk`.
 */
class XaiHttpError {
  readonly _tag = "XaiHttpError";
  constructor(
    readonly status: number,
    readonly body: string,
  ) {}
}

/**
 * Retry only transient failures: xAI 5xx responses, 429 capacity/rate-limit
 * responses, and transport-level network errors. The /responses endpoint
 * intermittently 500s ("Service temporarily unavailable") on tool-call-laden
 * payloads, and 429s ("model is currently at capacity") during demand spikes —
 * observed live 2026-06-11 when a single unretried 429 silently dropped a
 * turn and the bot ignored the user. Other 4xx and decode errors are not
 * retried (they're deterministic).
 */
const isTransientXaiError = (e: unknown): boolean => {
  if (e instanceof XaiHttpError) return e.status >= 500 || e.status === 429;
  if (typeof e === "object" && e !== null && "_tag" in e) {
    const tag = (e as { readonly _tag: unknown })._tag;
    return tag === "TransportError" || tag === "HttpClientError";
  }
  return false;
};

/** Bounded jittered exponential backoff for transient xAI failures. */
const xaiRetrySchedule = Schedule.exponential("300 millis", 2).pipe(Schedule.jittered);

// ── Config service for per-request overrides ──

export class Config extends Context.Service<
  Config,
  {
    readonly previous_response_id?: string | undefined;
    readonly store?: boolean | undefined;
    /**
     * Per-request system prompt. Wins over the layer's `instructions` option.
     * The persona varies per turn (participants' memory, wake prompts), so
     * turn assembly sets this via `withConfigOverride` — the same path
     * previous_response_id already uses.
     */
    readonly instructions?: string | undefined;
  }
>()("xchat-agent/XaiLanguageModel/Config") {}

/** Set per-request config overrides (e.g. previous_response_id). */
export const withConfigOverride: {
  (
    overrides: typeof Config.Service,
  ): <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, Exclude<R, Config>>;
  <A, E, R>(
    self: Effect.Effect<A, E, R>,
    overrides: typeof Config.Service,
  ): Effect.Effect<A, E, Exclude<R, Config>>;
} = dual(
  2,
  <A, E, R>(
    self: Effect.Effect<A, E, R>,
    overrides: typeof Config.Service,
  ): Effect.Effect<A, E, Exclude<R, Config>> =>
    Effect.flatMap(Effect.serviceOption(Config), (config) =>
      Effect.provideService(self, Config, {
        ...(config._tag === "Some" ? config.value : {}),
        ...overrides,
      }),
    ) as Effect.Effect<A, E, Exclude<R, Config>>,
);

// ── Layer options ──

interface XaiLayerOptions {
  readonly instructions?: string;
  readonly store?: boolean;
  /** xAI server-side tools to include in every request */
  readonly serverTools?: ReadonlyArray<"web_search" | "x_search">;
}

// ── Layer constructor ──

export const layer = (options: XaiLayerOptions) =>
  Layer.effect(LanguageModel.LanguageModel, make(options));

// ── Internal implementation ──

const make = (options: XaiLayerOptions) =>
  Effect.gen(function* () {
    const config = yield* XaiConfig;
    const client = yield* HttpClient.HttpClient;
    const xai = client.pipe(
      HttpClient.mapRequest((r) =>
        r.pipe(
          HttpClientRequest.prependUrl(config.apiUrl),
          HttpClientRequest.bearerToken(config.apiKey),
        ),
      ),
    );

    /** Convert Effect AI tools to xAI Responses API tool definitions. */
    const serializeTools = (tools: ReadonlyArray<Tool.Any>): Array<unknown> => {
      const out: Array<unknown> = [];
      for (const t of tools) {
        if (Tool.isUserDefined(t)) {
          out.push({
            type: "function",
            name: t.name,
            description: Tool.getDescription(t) ?? "",
            parameters: Tool.getJsonSchemaFromSchema(t.parametersSchema),
            strict: true,
          });
        }
      }
      for (const st of options.serverTools ?? ["web_search", "x_search"]) {
        out.push(
          buildServerTool(st, {
            imageUnderstanding: config.xSearchImageUnderstanding,
            videoUnderstanding: config.xSearchVideoUnderstanding,
          }),
        );
      }
      return out;
    };

    /** Parse an xAI Responses API body into Effect AI PartEncoded array. */
    const parseResponse = (body: XaiResponseBody): Array<Response.PartEncoded> => {
      const parts: Array<Response.PartEncoded> = [];

      // Server-side searches (web_search/x_search) run INSIDE the response and
      // are otherwise invisible — you could only infer them from input-token
      // jumps. Surface them so "did it actually check before answering?" is
      // auditable (it matters: the model will confidently answer real-world
      // questions whether or not it searched).
      const searchCalls = body.output.filter(
        (item) => item.type === "web_search_call" || item.type === "custom_tool_call",
      ).length;
      if (searchCalls > 0) {
        log({ type: "model_search", calls: searchCalls });
      }

      parts.push({
        type: "response-metadata",
        id: body.id,
        modelId: body.model,
        timestamp: body.completed_at
          ? new Date(body.completed_at * 1000).toISOString()
          : new Date().toISOString(),
        request: undefined,
        metadata: {},
      } as Response.ResponseMetadataPartEncoded);

      for (const item of body.output) {
        if (item.type === "message") {
          const msg = item as XaiMessageItem;
          for (const c of msg.content) {
            if (c.type === "output_text") {
              const textContent = c as XaiOutputText;
              parts.push({
                type: "text",
                text: textContent.text,
                metadata: {},
              } as Response.TextPartEncoded);
              for (const a of textContent.annotations) {
                if (a.type === "url_citation" && a.url) {
                  parts.push({
                    type: "source",
                    sourceType: "url",
                    id: a.url,
                    url: a.url,
                    title: a.title ?? "",
                    metadata: {},
                  } as Response.UrlSourcePartEncoded);
                }
              }
            }
          }
        } else if (item.type === "function_call") {
          const fc = item as XaiFunctionCallItem;
          parts.push({
            type: "tool-call",
            id: fc.call_id,
            name: fc.name,
            params: sanitizeToolParams(JSON.parse(fc.arguments)) as unknown,
            metadata: {},
          } as Response.ToolCallPartEncoded);
        }
        // web_search_call / custom_tool_call (x_search) are server-side executed.
        // Their results appear as text/citations in the message output.
      }

      const u = body.usage;
      const hasUserToolCalls = parts.some((p) => p.type === "tool-call");
      parts.push({
        type: "finish",
        reason: hasUserToolCalls ? "tool-calls" : "stop",
        response: undefined,
        usage: {
          inputTokens: {
            uncached: undefined,
            total: u?.input_tokens ?? undefined,
            cacheRead: u?.input_tokens_details?.cached_tokens ?? undefined,
            cacheWrite: undefined,
          },
          outputTokens: {
            total: u?.output_tokens ?? undefined,
            text: undefined,
            reasoning: u?.output_tokens_details?.reasoning_tokens ?? undefined,
          },
        },
        metadata: {},
      } as Response.FinishPartEncoded);

      return parts;
    };

    /** Convert Effect AI Prompt to xAI Responses API input messages. */
    const promptToInput = (prompt: Prompt.Prompt): Array<unknown> => {
      const msgs: Array<unknown> = [];
      for (const msg of prompt.content) {
        for (const part of msg.content) {
          if (typeof part === "string") {
            msgs.push({ role: msg.role, content: part });
            continue;
          }
          switch (part.type) {
            case "text":
              if (part.text) {
                msgs.push({ role: msg.role, content: part.text });
              }
              break;
            case "tool-call":
              if (!part.providerExecuted) {
                msgs.push({
                  type: "function_call",
                  call_id: part.id,
                  name: part.name,
                  arguments: JSON.stringify(part.params),
                });
              }
              break;
            case "tool-result": {
              const output =
                typeof part.result === "string"
                  ? part.result
                  : JSON.stringify(part.result);
              msgs.push({
                type: "function_call_output",
                call_id: part.id,
                output,
              });
              break;
            }
            case "file":
              if (part.data instanceof Uint8Array) {
                msgs.push({
                  role: msg.role,
                  content: [
                    {
                      type: "input_image",
                      image_url: `data:${part.mediaType};base64,${Buffer.from(part.data).toString("base64")}`,
                    },
                  ],
                });
              }
              break;
          }
        }
      }
      return msgs;
    };

    return yield* LanguageModel.make({
      generateText: (providerOptions) =>
        Effect.gen(function* () {
          const configOverride = yield* Effect.serviceOption(Config);
          const overrides = configOverride._tag === "Some" ? configOverride.value : {};

          const input = promptToInput(providerOptions.prompt);
          const tools = serializeTools(providerOptions.tools);

          const requestBody: Record<string, unknown> = {
            model: config.model,
            input,
            store: overrides.store ?? options.store ?? false,
          };

          if (tools.length > 0) requestBody.tools = tools;
          const instructions = overrides.instructions ?? options.instructions;
          if (instructions) requestBody.instructions = instructions;
          // Only send previous_response_id when store is enabled (ZDR keys reject it)
          if (overrides.previous_response_id && requestBody.store !== false)
            requestBody.previous_response_id = overrides.previous_response_id;

          // One request attempt. Non-2xx surfaces as XaiHttpError carrying the
          // raw body so the real provider error is visible (not swallowed).
          const attempt = Effect.gen(function* () {
            const response = yield* xai.execute(
              HttpClientRequest.post("/responses", {
                body: HttpBody.jsonUnsafe(requestBody),
              }),
            );
            if (response.status >= 400) {
              const errBody = yield* response.text.pipe(
                Effect.orElseSucceed(() => "(no response body)"),
              );
              return yield* Effect.fail(new XaiHttpError(response.status, errBody));
            }
            const json: unknown = yield* response.json;
            const body = yield* Schema.decodeUnknownEffect(XaiResponseBody_)(json);
            return parseResponse(body as unknown as XaiResponseBody);
          });

          // Retry transient failures (5xx/429 + network) with bounded jittered
          // backoff, so a single flaky 500 or capacity 429 no longer silently
          // drops the turn. Every transient failure is logged (xai_retry) so
          // retry churn — and the terminal failure — is visible in the JSONL
          // stream instead of indistinguishable from a clean turn.
          const RETRY_TIMES = 6;
          let failedAttempts = 0;
          return yield* attempt.pipe(
            Effect.tapError((e) =>
              Effect.sync(() => {
                if (!isTransientXaiError(e)) return;
                failedAttempts += 1;
                log({
                  type: "xai_retry",
                  attempt: failedAttempts,
                  status: e instanceof XaiHttpError ? e.status : undefined,
                  error:
                    e instanceof XaiHttpError
                      ? e.body.slice(0, 200)
                      : String(e).slice(0, 200),
                  final: failedAttempts > RETRY_TIMES,
                });
              }),
            ),
            Effect.retry({
              schedule: xaiRetrySchedule,
              // ~19s of jittered exponential backoff (300ms doubling). Sized
              // to outlast capacity blips (429s), not just single flaky 500s.
              times: RETRY_TIMES,
              while: isTransientXaiError,
            }),
          );
        }).pipe(
          Effect.mapError((e) =>
            e instanceof XaiHttpError
              ? new AiError.AiError({
                  module: "XaiLanguageModel",
                  method: "generateText",
                  reason: new AiError.InternalProviderError({
                    description: `xAI ${e.status}: ${e.body}`,
                  }),
                })
              : new AiError.AiError({
                  module: "XaiLanguageModel",
                  method: "generateText",
                  reason: new AiError.InternalProviderError({
                    description: String(e),
                  }),
                }),
          ),
        ),

      streamText: () =>
        Stream.fail(
          new AiError.AiError({
            module: "XaiLanguageModel",
            method: "streamText",
            reason: new AiError.InternalProviderError({
              description: "XaiLanguageModel.streamText not yet implemented",
            }),
          }),
        ),
    });
  });
