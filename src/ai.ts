import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { getPrice, getPrices, FEEDS, type ChainOptions } from "./chain.js";
import { createClient, type ClientOptions, type StocktensorClient } from "./client.js";
import { HORIZONS, type Horizon } from "./types.js";

export interface AiToolOptions {
  client?: StocktensorClient;
  clientOptions?: ClientOptions;
  chain?: ChainOptions;
}

const horizon = z.enum(Object.keys(HORIZONS) as [Horizon, ...Horizon[]]);
const symbol = z
  .string()
  .regex(/^[A-Za-z0-9.]{1,12}$/)
  .describe(`Stock token symbol. Supported: ${FEEDS.map((f) => f.symbol).join(", ")}`);

const plain = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v))) as T;

/**
 * Stocktensor tools for the Vercel AI SDK (`ai` ≥ 5):
 *
 * ```ts
 * import { generateText } from "ai";
 * import { stocktensorTools } from "@stocktensor/sdk/ai";
 * await generateText({ model, tools: stocktensorTools(), prompt: "Is NVDA bullish this week?" });
 * ```
 */
export function stocktensorTools(options: AiToolOptions = {}): ToolSet {
  const client = options.client ?? createClient(options.clientOptions);
  const chain = options.chain ?? {};
  return {
    getPrice: tool({
      description: "Live Chainlink price of a Robinhood Chain stock token in USD.",
      inputSchema: z.object({ symbol }),
      execute: async ({ symbol }) => plain(await getPrice(symbol, chain)),
    }),
    getPrices: tool({
      description: "Live Chainlink prices for several Robinhood Chain stock tokens.",
      inputSchema: z.object({ symbols: z.array(symbol).max(50) }),
      execute: async ({ symbols }) => plain(await getPrices(symbols, chain)),
    }),
    getForecast: tool({
      description:
        "Stocktensor network forecast for a stock token: 80% interval, point estimate, probability of ending higher, direction and model agreement.",
      inputSchema: z.object({ asset: symbol, horizon: horizon.optional() }),
      execute: ({ asset, horizon }) => client.forecasts({ asset, horizon }),
    }),
    getConsensus: tool({
      description: "Direction consensus of the top 10 forecasting models.",
      inputSchema: z.object({ asset: symbol.optional(), horizon: horizon.optional() }),
      execute: ({ asset, horizon }) => client.consensus({ asset, horizon }),
    }),
    getLeaderboard: tool({
      description: "Forecasting models ranked by rolling accuracy.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(256).optional() }),
      execute: async ({ limit }) => {
        const board = await client.leaderboard();
        return limit ? { ...board, models: board.models.slice(0, limit) } : board;
      },
    }),
  };
}
