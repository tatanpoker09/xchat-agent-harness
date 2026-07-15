/**
 * get_quote — the bot's deterministic price source.
 *
 * Use this for ANY stock quote instead of guessing or web-searching. Returns
 * the real current price (including overnight / after-hours sessions) with the
 * source named, so prices are exact, reproducible, and auditable.
 */
import { Effect, Schema } from "effect";
import { Tool } from "effect/unstable/ai";
import type { QuoteExecutor } from "./executors/QuoteExecutor.js";

export const GetQuote = Tool.make("get_quote", {
  description:
    'Get the real, current market price for a stock ticker — including the overnight (24-hour market) and after-hours sessions, with the session labeled and the source named. ALWAYS use this for a stock price instead of answering from memory, the conversation, or a web search; those drift and fabricate. Pass the ticker symbol (e.g. "AAPL", "SPCX"). If it can\'t be fetched, say so — never invent a number.',
  parameters: Schema.Struct({
    symbol: Schema.String,
  }),
  success: Schema.String,
});

export const getQuoteHandler =
  (exec: typeof QuoteExecutor.Service) =>
  (params: { readonly symbol: string }): Effect.Effect<string, string> =>
    exec.quote(params.symbol).pipe(
      Effect.map((q) => {
        const change = q.change ? `, ${q.change}` : "";
        return `${q.symbol} (${q.name}): $${q.price} — ${q.session}${change} [source: ${q.source}]`;
      }),
    );
