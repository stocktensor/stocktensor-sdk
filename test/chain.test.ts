import { readFileSync } from "node:fs";
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  getAddress,
  multicall3Abi,
  type Hex,
  type PublicClient,
} from "viem";
import { describe, expect, it } from "vitest";
import {
  aggregatorV3Abi,
  erc20Abi,
  FEEDS,
  feedFor,
  getPrice,
  getPrices,
  robinhoodChain,
  STENSOR_TOKEN,
  STOCK_TOKEN,
  stensorBalance,
  stockBalance,
} from "../src/chain.js";
import { StocktensorError } from "../src/errors.js";

const assets = JSON.parse(readFileSync(new URL("../scripts/assets.json", import.meta.url), "utf8"));
const NOW = 1_790_000_000;

// A fake Robinhood Chain: answers eth_call by decoding the real ABIs.
function fakeChain(rounds: Record<string, [bigint, bigint, bigint, bigint, bigint] | "revert">, balances = {}) {
  const calls: string[] = [];
  const answer = (to: string, data: Hex): Hex => {
    const address = getAddress(to);
    if (address === getAddress(robinhoodChain.contracts.multicall3.address)) {
      const { args } = decodeFunctionData({ abi: multicall3Abi, data });
      const results = (args[0] as readonly { target: string; callData: Hex }[]).map(({ target, callData }) => {
        try {
          return { success: true, returnData: answer(target, callData) };
        } catch {
          return { success: false, returnData: "0x" as Hex };
        }
      });
      return encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: results });
    }
    calls.push(address);
    const round = rounds[address];
    if (round === "revert") throw new Error("execution reverted");
    if (round) return encodeFunctionResult({ abi: aggregatorV3Abi, functionName: "latestRoundData", result: round });
    const { functionName } = decodeFunctionData({ abi: erc20Abi, data });
    if (functionName === "decimals") return encodeFunctionResult({ abi: erc20Abi, functionName, result: 18 });
    return encodeFunctionResult({
      abi: erc20Abi,
      functionName: "balanceOf",
      result: (balances as Record<string, bigint>)[address] ?? 0n,
    });
  };
  const client = createPublicClient({
    chain: robinhoodChain,
    transport: custom({
      async request({ method, params }) {
        if (method === "eth_chainId") return "0x1237";
        if (method !== "eth_call") throw new Error(`unexpected ${method}`);
        const [{ to, data }] = params as [{ to: string; data: Hex }];
        try {
          return answer(to, data);
        } catch (error) {
          throw Object.assign(new Error("execution reverted"), { code: 3, data: "0x", cause: error });
        }
      },
    }),
  }) as PublicClient;
  return { client, calls };
}

const nvda = feedFor("NVDA").feed;
const spy = feedFor("SPY").feed;

describe("feeds", () => {
  it("covers every asset scored by the subnet, checksummed and unique", () => {
    expect(FEEDS).toHaveLength(assets.assets.length);
    expect(FEEDS).toHaveLength(35);
    for (const feed of FEEDS) {
      expect(getAddress(feed.feed)).toBe(feed.feed);
      expect(feed.decimals).toBe(8);
    }
    expect(new Set(FEEDS.map((f) => f.symbol)).size).toBe(FEEDS.length);
    const fromAssets = new Map(
      assets.assets.map((a: { symbol: string; feed: string }) => [a.symbol, getAddress(a.feed)]),
    );
    for (const feed of FEEDS) expect(fromAssets.get(feed.symbol)).toBe(feed.feed);
  });

  it("rejects unknown symbols", () => {
    expect(() => feedFor("DOGE")).toThrow(StocktensorError);
  });

  it("describes Robinhood Chain", () => {
    expect(robinhoodChain.id).toBe(4663);
    expect(STENSOR_TOKEN).toBeNull();
    expect(STOCK_TOKEN).toBe(STENSOR_TOKEN);
    expect(stockBalance).toBe(stensorBalance);
  });
});

describe("getPrice / getPrices", () => {
  it("decodes latestRoundData into an exact USD price with staleness", async () => {
    const { client } = fakeChain({ [nvda]: [5n, 23622797244n, 0n, BigInt(NOW - 60), 5n] });
    const price = await getPrice("nvda", { client, now: NOW });
    expect(price).toMatchObject({
      symbol: "NVDA",
      price: "236.22797244",
      answer: 23622797244n,
      roundId: 5n,
      age: 60,
      stale: false,
      decimals: 8,
    });
    const old = await getPrice("NVDA", { client, now: NOW + 30 * 3600 });
    expect(old.stale).toBe(true);
    expect((await getPrice("NVDA", { client, now: NOW + 30 * 3600, maxAgeSeconds: 7 * 86400 })).stale).toBe(false);
  });

  it("batches through Multicall3 and reports per-feed failures", async () => {
    const { client } = fakeChain({ [nvda]: [1n, 100000000n, 0n, BigInt(NOW), 1n], [spy]: "revert" });
    const prices = await getPrices(["NVDA", "SPY"], { client, now: NOW });
    expect(prices[0]).toMatchObject({ symbol: "NVDA", price: "1" });
    expect(prices[1]).toMatchObject({ symbol: "SPY" });
    expect("error" in prices[1]!).toBe(true);
  });
});

describe("stensorBalance", () => {
  const holder = "0x4db8587bb156fa02501b23800cc302d0ba3e656e";
  const token = "0x00000000000000000000000000000000000000aa";

  it("requires a token until $STENSOR is published", async () => {
    await expect(stensorBalance(holder)).rejects.toThrow(/not launched yet/);
  });

  it("reads balanceOf and decimals", async () => {
    const { client } = fakeChain({}, { [getAddress(token)]: 1_500_000_000_000_000_000_000n });
    const balance = await stensorBalance(holder, { client, token });
    expect(balance).toMatchObject({ raw: 1_500_000_000_000_000_000_000n, decimals: 18, formatted: "1500" });
    expect(balance.owner).toBe(getAddress(holder));
  });

  it("validates addresses", async () => {
    await expect(stensorBalance("0x123", { token })).rejects.toThrow(StocktensorError);
    await expect(stensorBalance(holder, { token: "nope" })).rejects.toThrow(StocktensorError);
  });
});
