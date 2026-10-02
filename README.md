# @stocktensor/sdk

TypeScript SDK, MCP server and AI agent tools for [Stocktensor](https://stocktensor.io): AI forecasts for Robinhood Chain stock tokens, produced by competing models on a Bittensor subnet and scored against Chainlink prices.

| Import | What it does | Works today |
|---|---|---|
| `@stocktensor/sdk` | Client for the Stocktensor API: forecasts, consensus, divergence, leaderboard, model profiles, epoch bundles | Needs the hosted API (see below) |
| `@stocktensor/sdk/chain` | Live Chainlink prices for 35 stock tokens on Robinhood Chain, `$STOCK` balance reads | ✅ yes, straight from the chain |
| `@stocktensor/sdk/mcp` + `stocktensor-mcp` | MCP server (stdio) for Claude, Cursor and other agents | ✅ price tools; API tools need the API |
| `@stocktensor/sdk/ai` | Tool definitions for the Vercel AI SDK | ✅ price tools; API tools need the API |
| `@stocktensor/sdk/webhooks` | Verify signed webhook deliveries | ✅ |

> **Status:** the hosted API at `https://api.stocktensor.io/v1` is **not live yet**. The client and its response contract (below) are what the API will implement. Chain reads work now. `$STOCK` launches on Pons; its address is not in this package until it is live and verified on-chain.

## Install

```bash
pnpm add @stocktensor/sdk
# for @stocktensor/sdk/ai only:
pnpm add ai
```

Node ≥ 20, also runs on Cloudflare Workers, Deno and Bun (ESM only).

## Live prices from Robinhood Chain

```ts
import { getPrice, getPrices, FEEDS } from "@stocktensor/sdk/chain";

const nvda = await getPrice("NVDA");
// { symbol: "NVDA", price: "236.22797244", updatedAt: 1790944347, age: 821, stale: false, session: "pre", ... }

const all = await getPrices(); // every feed, one Multicall3 call
```

- Source: the Chainlink proxy for each token on Robinhood Chain (chain id 4663). The feed price is the token price (underlying × token multiplier).
- Feeds update 24/5 and hold their last price over the weekend, so `stale` (older than 26 h by default) is expected on Sundays. Tune it with `maxAgeSeconds`.
- `FEEDS` is generated from Chainlink's feed registry and matches the assets scored by [`stocktensor-subnet`](https://github.com/stocktensor/stocktensor-subnet). Regenerate with `pnpm gen:feeds`.
- Pass `{ rpcUrl }` or your own viem `{ client }` to use another RPC.

### `$STOCK` balance

```ts
import { stockBalance, STOCK_TOKEN } from "@stocktensor/sdk/chain";

STOCK_TOKEN; // null until the token is live
await stockBalance("0xYourWallet", { token: "0x..." }); // { raw, decimals, formatted }
```

Holder checks are plain `balanceOf` reads: no staking, no locking.

## API client

```ts
import { createClient } from "@stocktensor/sdk";

const stx = createClient({ apiKey: process.env.STOCKTENSOR_API_KEY }); // key optional
const [nvda1d] = await stx.forecasts({ asset: "NVDA", horizon: "1d" });
const board = await stx.leaderboard();
```

Without an API key the API serves the delayed feed (`delayed: true`); a key unlocks real-time data. Options: `baseUrl`, `fetch`, `timeoutMs` (10 s), `retries` (2, on 408/425/429/5xx, timeouts and network errors, honouring `Retry-After`), `backoffMs`.

Errors are typed: `StocktensorApiError` (`status`, `code`, `body`), `StocktensorTimeoutError`, `StocktensorNetworkError`, all extending `StocktensorError`.

### Response contract

All prices are USD decimal strings. Horizons: `1h`, `1d`, `1w`. Forecast intervals are central **80%** prediction intervals; `p_up` is the probability of ending above the reference price. Rules follow [`docs/SCORING.md`](https://github.com/stocktensor/stocktensor-subnet/blob/main/docs/SCORING.md) in the subnet repo.

| Method | Request | Response |
|---|---|---|
| `forecasts(filter?)` | `GET /forecasts?asset=&horizon=` | `ForecastEntry[]` |
| `consensus(filter?)` | `GET /consensus?asset=&horizon=` | `ConsensusEntry[]` |
| `divergence()` | `GET /divergence` | `DivergenceEntry[]` |
| `leaderboard()` | `GET /leaderboard` | `Leaderboard` |
| `model(hotkey)` | `GET /models/:hotkey` | `ModelProfile` |
| `bundle(epoch \| "latest")` | `GET /bundles/:epoch` | `EpochBundle` (validator bundle, see `docs/PROTOCOL.md`) |

```ts
interface ForecastEntry {
  asset: string; horizon: "1h" | "1d" | "1w";
  as_of: number; target_time: number;          // unix seconds
  session: "regular" | "pre" | "post" | "overnight" | "closed";
  reference_price: string;                     // Chainlink price at as_of
  low: string; point: string; high: string; p_up: string; // medians of the top models
  direction: "bullish" | "bearish" | "neutral"; // p_up ≥ 0.55 / ≤ 0.45
  agreement: number;                           // share of top models agreeing, 0..1
  models: number;                              // top models that answered (max 10)
  delayed: boolean;
}
```

The full set of types (`ConsensusEntry`, `DivergenceEntry`, `Leaderboard`, `ModelProfile`, `EpochBundle`) is exported from the root. Errors come back as `{ "error": string, "code"?: string }` with a non-2xx status.

The root also exports `consensus()` and `directionOf()` (the same rule the subnet uses, tested against its golden vectors) and `sessionAt()`.

## MCP server

```json
{
  "mcpServers": {
    "stocktensor": {
      "command": "npx",
      "args": ["-y", "-p", "@stocktensor/sdk", "stocktensor-mcp"],
      "env": { "STOCKTENSOR_API_KEY": "", "ROBINHOOD_RPC_URL": "" }
    }
  }
}
```

Tools: `get_price`, `get_prices` (live Chainlink), `get_forecast`, `get_consensus`, `get_leaderboard`, `compare_models` (API). Logs go to stderr; stdout carries only MCP messages. Env: `STOCKTENSOR_API_URL`, `STOCKTENSOR_API_KEY`, `ROBINHOOD_RPC_URL`, all optional.

Embed it in your own process with `createStocktensorMcpServer({ client, chain })` and any MCP transport.

## Vercel AI SDK

```ts
import { generateText } from "ai";
import { stocktensorTools } from "@stocktensor/sdk/ai";

const { text } = await generateText({
  model,
  tools: stocktensorTools(),
  prompt: "Which stock tokens do the models favour this week?",
});
```

`ai` is an optional peer dependency and is only imported by this subpath.

## Webhooks

```ts
import { verifyWebhook } from "@stocktensor/sdk/webhooks";

const event = await verifyWebhook(rawBody, request.headers, process.env.STOCKTENSOR_WEBHOOK_SECRET!);
```

Signature = HMAC-SHA256 of `${timestamp}.${rawBody}`, sent as `x-stocktensor-timestamp` and `x-stocktensor-signature: v1=<hex>` (several comma-separated `v1=` values are accepted during secret rotation). Default tolerance is 300 s. Always verify the raw body, not re-serialised JSON.

## Limits

- Not financial advice. Forecasts are probabilistic model outputs and can be wrong.
- The API is not live yet; API methods will fail until it is.
- Chain reads use a public RPC by default, which may rate-limit. Use your own for production.
- `sessionAt` does not model US market holidays.

## Development

```bash
pnpm install
pnpm lint      # typecheck + prettier
pnpm build
pnpm test      # offline; the stdio test runs after a build
```

Releases: push a `vX.Y.Z` tag matching `package.json`; CI runs the checks and attaches the packed tarball to a GitHub release.

## License

MIT © 2026 Stocktensor
