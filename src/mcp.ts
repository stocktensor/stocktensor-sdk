import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getPrice, getPrices, FEEDS, type ChainOptions } from "./chain.js";
import { createClient, type ClientOptions, type StocktensorClient } from "./client.js";
import { HORIZONS, type Horizon } from "./types.js";

export interface McpOptions {
  /** API client. Built from `clientOptions` when omitted. */
  client?: StocktensorClient;
  clientOptions?: ClientOptions;
  /** Options for live Chainlink reads on Robinhood Chain. */
  chain?: ChainOptions;
  /** Logger; must not write to stdout (stdio transport). Default: stderr. */
  log?: (message: string) => void;
}

const horizon = z.enum(Object.keys(HORIZONS) as [Horizon, ...Horizon[]]);
const symbol = z
  .string()
  .regex(/^[A-Za-z0-9.]{1,12}$/)
  .describe(`Stock token symbol, e.g. NVDA. Supported: ${FEEDS.map((f) => f.symbol).join(", ")}`);
const hotkey = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{46,48}$/, "ss58 hotkey");

function json(value: unknown) {
  const text = JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  return { content: [{ type: "text" as const, text }] };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

/** Build the Stocktensor MCP server. Connect it to any transport (`stocktensor-mcp` uses stdio). */
export function createStocktensorMcpServer(options: McpOptions = {}): McpServer {
  const client = options.client ?? createClient(options.clientOptions);
  const chain = options.chain ?? {};
  const log = options.log ?? ((message: string) => process.stderr.write(`[stocktensor-mcp] ${message}\n`));

  const server = new McpServer({ name: "stocktensor", version: "0.1.0" });

  const run = (name: string, fn: () => Promise<unknown>) =>
    fn().then(json, (error) => {
      log(`${name} failed: ${error instanceof Error ? error.message : String(error)}`);
      return failure(error);
    });

  server.registerTool(
    "get_price",
    {
      title: "Stock token price",
      description:
        "Live Chainlink price of one Robinhood Chain stock token (USD). Feeds update 24/5 and hold their price at weekends.",
      inputSchema: { symbol },
    },
    ({ symbol }) => run("get_price", () => getPrice(symbol, chain)),
  );

  server.registerTool(
    "get_prices",
    {
      title: "Stock token prices",
      description: "Live Chainlink prices for several Robinhood Chain stock tokens in one call. Omit symbols for all.",
      inputSchema: { symbols: z.array(symbol).max(50).optional() },
    },
    ({ symbols }) => run("get_prices", () => getPrices(symbols, chain)),
  );

  server.registerTool(
    "get_forecast",
    {
      title: "Forecast",
      description:
        "Network forecast for a stock token: 80% price interval, point estimate, probability of ending higher and direction, from the top-ranked Bittensor models.",
      inputSchema: { asset: symbol, horizon: horizon.optional() },
    },
    ({ asset, horizon }) => run("get_forecast", () => client.forecasts({ asset, horizon })),
  );

  server.registerTool(
    "get_consensus",
    {
      title: "Consensus",
      description: "Direction consensus (bullish / bearish / neutral) and agreement of the top 10 models.",
      inputSchema: { asset: symbol.optional(), horizon: horizon.optional() },
    },
    ({ asset, horizon }) => run("get_consensus", () => client.consensus({ asset, horizon })),
  );

  server.registerTool(
    "get_leaderboard",
    {
      title: "Model leaderboard",
      description: "Forecasting models ranked by rolling accuracy score.",
      inputSchema: { limit: z.number().int().min(1).max(256).optional() },
    },
    ({ limit }) =>
      run("get_leaderboard", async () => {
        const board = await client.leaderboard();
        return limit ? { ...board, models: board.models.slice(0, limit) } : board;
      }),
  );

  server.registerTool(
    "compare_models",
    {
      title: "Compare models",
      description: "Side-by-side scores of 2 to 5 models by hotkey, overall and per horizon and session.",
      inputSchema: { hotkeys: z.array(hotkey).min(2).max(5) },
    },
    ({ hotkeys }) =>
      run("compare_models", async () => {
        const models = await Promise.all(hotkeys.map((h) => client.model(h)));
        return models.map(({ recent: _recent, ...rest }) => rest);
      }),
  );

  return server;
}
