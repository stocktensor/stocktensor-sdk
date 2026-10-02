import {
  createPublicClient,
  defineChain,
  formatUnits,
  getAddress,
  http,
  isAddress,
  type Address,
  type PublicClient,
} from "viem";
import { StocktensorError } from "./errors.js";
import { FEEDS, type StockFeed } from "./feeds.js";
import { sessionAt } from "./sessions.js";
import type { Session } from "./types.js";

export { FEEDS, type StockFeed } from "./feeds.js";

export const ROBINHOOD_CHAIN_ID = 4663;
export const DEFAULT_RPC_URL = "https://robinhood-rpc.publicnode.com";

/** Robinhood Chain mainnet. Multicall3 is deployed at the canonical address. */
export const robinhoodChain = defineChain({
  id: ROBINHOOD_CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [DEFAULT_RPC_URL] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

/**
 * $STOCK token address. `null` until the token launches on Pons; pass `token`
 * to {@link stockBalance} until then. Never filled in before it is verified on-chain.
 */
export const STOCK_TOKEN: Address | null = null;

/** Feeds hold their price outside trading hours, so this is a soft signal. Default 26 h. */
export const DEFAULT_MAX_AGE_SECONDS = 26 * 3600;

export const aggregatorV3Abi = [
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "description", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

export const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

export interface ChainOptions {
  /** A viem public client for Robinhood Chain. Created from `rpcUrl` when omitted. */
  client?: PublicClient;
  /** RPC URL used when no client is given. Default: publicnode. */
  rpcUrl?: string;
}

export interface PriceOptions extends ChainOptions {
  /** Seconds after which a price is flagged `stale`. Default 26 h. */
  maxAgeSeconds?: number;
  /** Override "now" (unix seconds), mainly for tests. */
  now?: number;
}

export interface StockPrice {
  symbol: string;
  feed: Address;
  /** Exact decimal string of the Chainlink answer, in USD. */
  price: string;
  answer: bigint;
  decimals: number;
  roundId: bigint;
  updatedAt: number;
  /** Seconds since `updatedAt`. */
  age: number;
  /** True when older than `maxAgeSeconds`. Normal over weekends: feeds update 24/5. */
  stale: boolean;
  /** Current US equity session, for context on staleness. */
  session: Session;
}

const clients = new Map<string, PublicClient>();

function clientFor(options: ChainOptions): PublicClient {
  if (options.client) return options.client;
  const url = options.rpcUrl ?? DEFAULT_RPC_URL;
  let client = clients.get(url);
  if (!client) {
    client = createPublicClient({ chain: robinhoodChain, transport: http(url) }) as PublicClient;
    clients.set(url, client);
  }
  return client;
}

/** Look up a stock token feed by symbol (case-insensitive). */
export function feedFor(symbol: string): StockFeed {
  const feed = FEEDS.find((f) => f.symbol === symbol.toUpperCase());
  if (!feed) throw new StocktensorError(`no Chainlink feed for ${symbol} on Robinhood Chain`);
  return feed;
}

type RoundData = readonly [bigint, bigint, bigint, bigint, bigint];

function toPrice(feed: StockFeed, round: RoundData, options: PriceOptions): StockPrice {
  const [roundId, answer, , updatedAtRaw] = round;
  const updatedAt = Number(updatedAtRaw);
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const age = Math.max(0, now - updatedAt);
  return {
    symbol: feed.symbol,
    feed: feed.feed,
    price: formatUnits(answer, feed.decimals),
    answer,
    decimals: feed.decimals,
    roundId,
    updatedAt,
    age,
    stale: age > (options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS),
    session: sessionAt(now),
  };
}

/** Latest Chainlink price for one stock token on Robinhood Chain. */
export async function getPrice(symbol: string, options: PriceOptions = {}): Promise<StockPrice> {
  const feed = feedFor(symbol);
  const round = await clientFor(options).readContract({
    address: feed.feed,
    abi: aggregatorV3Abi,
    functionName: "latestRoundData",
  });
  return toPrice(feed, round, options);
}

/** Latest prices for several stock tokens in one multicall. Failed reads are returned as errors. */
export async function getPrices(
  symbols: readonly string[] = FEEDS.map((f) => f.symbol),
  options: PriceOptions = {},
): Promise<Array<StockPrice | { symbol: string; error: string }>> {
  const feeds = symbols.map(feedFor);
  const results = await clientFor(options).multicall({
    contracts: feeds.map((feed) => ({
      address: feed.feed,
      abi: aggregatorV3Abi,
      functionName: "latestRoundData" as const,
    })),
    allowFailure: true,
  });
  return results.map((result, i) => {
    const feed = feeds[i]!;
    if (result.status === "success") return toPrice(feed, result.result as RoundData, options);
    return { symbol: feed.symbol, error: result.error?.message ?? "call failed" };
  });
}

export interface TokenBalance {
  token: Address;
  owner: Address;
  raw: bigint;
  decimals: number;
  /** Human-readable balance. */
  formatted: string;
}

/**
 * $STOCK balance of `owner` (holder checks are plain `balanceOf` reads: no staking, no locking).
 * Until the token is live, pass `token` explicitly; it is required while `STOCK_TOKEN` is `null`.
 */
export async function stockBalance(
  owner: string,
  options: ChainOptions & { token?: string } = {},
): Promise<TokenBalance> {
  const tokenInput = options.token ?? STOCK_TOKEN;
  if (!tokenInput)
    throw new StocktensorError("$STOCK is not launched yet: pass { token } until STOCK_TOKEN is published");
  if (!isAddress(owner)) throw new StocktensorError(`invalid address ${owner}`);
  if (!isAddress(tokenInput)) throw new StocktensorError(`invalid token address ${tokenInput}`);
  const token = getAddress(tokenInput);
  const holder = getAddress(owner);
  const client = clientFor(options);
  const [raw, decimals] = await Promise.all([
    client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [holder] }),
    client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
  ]);
  return { token, owner: holder, raw, decimals, formatted: formatUnits(raw, decimals) };
}
