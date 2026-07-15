import { Config, Context, Effect, Layer, Redacted } from "effect";

export class XaiConfig extends Context.Service<
  XaiConfig,
  {
    readonly apiKey: string;
    readonly apiUrl: string;
    readonly model: string;
    readonly imageModel: string;
    readonly videoModel: string;
    readonly sttApiKey: string;
    /** Have the x_search server-side tool analyze images in X posts (read shared posts' pictures). */
    readonly xSearchImageUnderstanding: boolean;
    /** Have the x_search server-side tool analyze videos in X posts. */
    readonly xSearchVideoUnderstanding: boolean;
  }
>()("XaiConfig") {
  static layer = Layer.effect(this)(
    Effect.gen(function* () {
      // Optional: empty key boots the agent in DM-watch / tool-debug mode without
      // Grok. Model turns fail until XAI_API_KEY is set (prod always sets it).
      const apiKey = yield* Config.redacted("XAI_API_KEY").pipe(
        Config.orElse(() => Config.succeed(Redacted.make(""))),
      );
      const apiUrl = yield* Config.string("XAI_API_URL").pipe(
        Config.withDefault("https://api.x.ai/v1"),
      );
      const model = yield* Config.string("XAI_MODEL").pipe(
        Config.withDefault("grok-4.3"),
      );
      // Imagine model ids. Defaults track the current flagship models
      // (verified live via GET /v1/image-generation-models). Override per
      // deployment via XAI_IMAGE_MODEL / XAI_VIDEO_MODEL — e.g. set
      // XAI_IMAGE_MODEL=grok-imagine-image for the cheaper/faster image tier.
      const imageModel = yield* Config.string("XAI_IMAGE_MODEL").pipe(
        Config.withDefault("grok-imagine-image-quality"),
      );
      const videoModel = yield* Config.string("XAI_VIDEO_MODEL").pipe(
        Config.withDefault("grok-imagine-video"),
      );
      const sttApiKey = yield* Config.redacted("XAI_STT_API_KEY").pipe(
        Config.orElse(() => Config.succeed(apiKey)),
      );
      // x_search media understanding. On by default so the bot can read the
      // images/videos in X posts a user shares (and any post it searches up).
      // Set XAI_X_SEARCH_{IMAGE,VIDEO}_UNDERSTANDING=false to disable.
      const xSearchImageUnderstanding = yield* Config.string(
        "XAI_X_SEARCH_IMAGE_UNDERSTANDING",
      ).pipe(Config.withDefault("true"));
      const xSearchVideoUnderstanding = yield* Config.string(
        "XAI_X_SEARCH_VIDEO_UNDERSTANDING",
      ).pipe(Config.withDefault("true"));
      return {
        apiKey: Redacted.value(apiKey),
        apiUrl,
        model,
        imageModel,
        videoModel,
        sttApiKey: Redacted.value(sttApiKey),
        xSearchImageUnderstanding: xSearchImageUnderstanding !== "false",
        xSearchVideoUnderstanding: xSearchVideoUnderstanding !== "false",
      };
    }),
  );
}
