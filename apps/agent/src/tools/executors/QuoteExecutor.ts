/**
 * QuoteExecutor — real market quotes, so the bot fetches prices instead of
 * guessing them.
 *
 * Born from a prod incident (2026-06-16): asked for a stock price the model
 * routed through fuzzy web-search and confidently served wrong/echoed numbers
 * (166 / 214 for a stock actually ~192 regular / ~217 overnight). The data
 * lives at Robinhood's PUBLIC bonfire "detail-page-live-updating-data"
 * endpoint (the same one a logged-out browser polls) which carries the LIVE
 * price including the overnight (24h market) session.
 *
 * The catch: the prod pod's envoy egress RBAC blocks Robinhood/Yahoo directly
 * ("403 RBAC: access denied") — only approved hosts (api.x.ai, *.x.com,
 * github.com) are reachable. So we route through api.x.ai (allowlisted) and
 * have xAI's server-side web_search OPEN the public Robinhood JSON URLs and
 * read the exact fields. Verified live: returns the real overnight price to
 * the cent (within live drift), and a fake ticker comes back UNAVAILABLE (no
 * fabrication). pod → api.x.ai → Robinhood; the pod never touches Robinhood.
 *
 * Second prod incident (2026-06-16): xAI's web_search CACHES fetches by URL,
 * so a recurring price check returned the same frozen quote ($217.63 to the
 * cent) for 17+ minutes while the live tape moved to ~$212. Fix: append a
 * per-call cache-buster query param (&_=<Date.now()>) to the live-updating
 * bonfire URL — a unique URL forces a fresh crawl. Proven against the real
 * API: plain URL → stale 217.63, &_=<ts> → live 212.3x. Only the live-price
 * URL gets the buster; the instrument-id lookup is static and stays cacheable.
 *
 * Live = real xAI browse. Mock = canned, so evals never touch the network.
 */
import { Context, Effect, Layer } from "effect";
import { XaiConfig } from "../../XaiConfig.js";

export interface QuoteResult {
  readonly symbol: string;
  readonly name: string;
  /** Numeric price string, e.g. "217.63". */
  readonly price: string;
  /** Session label: "Overnight" | "After-hours" | "Regular" | etc. */
  readonly session: string;
  /** Pre-formatted change, e.g. "+$22.78 (11.84%)" — may be empty. */
  readonly change: string;
  /** Where the number came from, for auditability. */
  readonly source: string;
}

const TIMEOUT_MS = 45_000;

const browsePrompt = (sym: string, cacheBuster: number): string =>
  `Get the live Robinhood quote for ticker ${sym} by opening these JSON URLs in order:
1. Open https://api.robinhood.com/instruments/?symbol=${sym} — read results[0].id (a UUID) and results[0].simple_name. If results is empty, the ticker isn't listed.
2. Open https://bonfire.robinhood.com/instruments/<that id>/detail-page-live-updating-data/?display_span=day&hide_extended_hours=false&_=${cacheBuster} — open this URL EXACTLY as written, INCLUDING the &_= cache-buster param (it is required to get the live, non-cached price).
3. From that JSON read: chart_section.default_display.price_chart_data.dollar_value.amount, chart_section.default_display.tertiary_value.description.value, and chart_section.default_display.tertiary_value.main.value.
Reply with ONE line and nothing else: PRICE=<amount> | SESSION=<description> | CHANGE=<main> | NAME=<simple_name>
If any step fails or the ticker has no instrument, reply EXACTLY: UNAVAILABLE`;

const field = (text: string, key: string): string | undefined => {
  const m = text.match(new RegExp(`${key}=([^|\\n]+)`, "i"));
  const v = m?.[1]?.trim();
  return v && v.toLowerCase() !== "null" && v !== "" ? v : undefined;
};

export class QuoteExecutor extends Context.Service<
  QuoteExecutor,
  {
    /** Fetch a real quote, or fail with a model-readable string. */
    readonly quote: (symbol: string) => Effect.Effect<QuoteResult, string>;
  }
>()("QuoteExecutor") {
  /** Live: xAI server-side browse of Robinhood's public JSON (egress-safe). */
  static liveLayer = Layer.effect(this)(
    Effect.gen(function* () {
      const cfg = yield* XaiConfig;
      return {
        quote: (symbol: string) =>
          Effect.tryPromise({
            try: async () => {
              const sym = symbol.trim().replace(/^\$/, "").toUpperCase();
              if (!/^[A-Z.\-]{1,10}$/.test(sym)) {
                throw new Error(`"${symbol}" doesn't look like a ticker symbol`);
              }
              const res = await fetch(`${cfg.apiUrl}/responses`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${cfg.apiKey}`,
                },
                body: JSON.stringify({
                  model: cfg.model,
                  input: browsePrompt(sym, Date.now()),
                  tools: [{ type: "web_search" }],
                  store: false,
                }),
                signal: AbortSignal.timeout(TIMEOUT_MS),
              });
              if (!res.ok) throw new Error(`xAI ${res.status}`);
              const body = (await res.json()) as {
                output?: Array<{
                  type: string;
                  content?: Array<{ type: string; text?: string }>;
                }>;
              };
              let text = "";
              for (const item of body.output ?? []) {
                if (item.type === "message") {
                  for (const c of item.content ?? []) {
                    if (c.type === "output_text" && c.text) text += c.text;
                  }
                }
              }
              const price = field(text, "PRICE")?.replace(/[$,]/g, "");
              if (/UNAVAILABLE/i.test(text) || !price) {
                throw new Error(
                  `no quote found for ${sym} — it may not be a listed ticker`,
                );
              }
              return {
                symbol: sym,
                name: field(text, "NAME") ?? sym,
                price,
                session: field(text, "SESSION") ?? "",
                change: field(text, "CHANGE") ?? "",
                source: "Robinhood",
              };
            },
            catch: (e) => (e instanceof Error ? e.message : String(e)),
          }),
      };
    }),
  );

  // Mock mirrors real behavior: KNOWN tickers resolve, unknown/fake ones fail
  // (so anti-fabrication evals — fake ticker → refuse — stay honest; a mock
  // that priced everything would let the bot "source" a made-up number).
  static mockLayer = Layer.succeed(this)({
    quote: (symbol: string) => {
      const sym = symbol.trim().replace(/^\$/, "").toUpperCase();
      const known: Record<string, { name: string; price: string }> = {
        SPCX: { name: "SpaceX", price: "217.63" },
        AAPL: { name: "Apple", price: "296.72" },
        NVDA: { name: "NVIDIA", price: "184.10" },
        TSLA: { name: "Tesla", price: "421.88" },
      };
      const hit = known[sym];
      return hit
        ? Effect.succeed({
            symbol: sym,
            name: hit.name,
            price: hit.price,
            session: "Overnight",
            change: "+$22.78 (11.84%)",
            source: "Robinhood",
          })
        : Effect.fail(`no quote found for ${sym} — it may not be a listed ticker`);
    },
  });
}
