import { existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPublicClient, custom, encodeFunctionResult, type PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import { aggregatorV3Abi, robinhoodChain } from "../src/chain.js";
import { createClient, type StocktensorClient } from "../src/index.js";
import { createStocktensorMcpServer } from "../src/mcp.js";

const chainClient = createPublicClient({
  chain: robinhoodChain,
  transport: custom({
    async request({ method }) {
      if (method === "eth_chainId") return "0x1237";
      return encodeFunctionResult({
        abi: aggregatorV3Abi,
        functionName: "latestRoundData",
        result: [7n, 33218813869n, 0n, 1_790_000_000n, 7n],
      });
    },
  }),
}) as PublicClient;

const api = {
  forecasts: async (filter?: { asset?: string; horizon?: string }) => [
    { asset: filter?.asset, horizon: filter?.horizon ?? "1h", direction: "bullish" },
  ],
  consensus: async () => [],
  divergence: async () => [],
  leaderboard: async () => ({
    epoch: 3,
    updated_at: 1,
    models: [1, 2, 3].map((rank) => ({
      rank,
      hotkey: `h${rank}`,
      uid: rank,
      rolling: "0.5",
      weight: "0.3",
      tasks: 1,
      valid_rate: 1,
    })),
  }),
  model: async (hotkey: string) => ({
    hotkey,
    uid: 1,
    rank: 1,
    rolling: "0.5",
    weight: "0.5",
    by_horizon: {},
    by_session: {},
    recent: [{}],
  }),
  bundle: async () => {
    throw new Error("unused");
  },
} as unknown as StocktensorClient;

async function connect(client: StocktensorClient = api) {
  const logs: string[] = [];
  const server = createStocktensorMcpServer({ client, chain: { client: chainClient }, log: (m) => logs.push(m) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), mcp.connect(b)]);
  return { mcp, logs };
}

const text = (result: unknown) => JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text);

describe("MCP server", () => {
  it("lists the six tools", async () => {
    const { mcp } = await connect();
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["compare_models", "get_consensus", "get_forecast", "get_leaderboard", "get_price", "get_prices"].sort(),
    );
  });

  it("reads live chain prices and API data", async () => {
    const { mcp } = await connect();
    const price = text(await mcp.callTool({ name: "get_price", arguments: { symbol: "AAPL" } }));
    expect(price).toMatchObject({ symbol: "AAPL", price: "332.18813869", roundId: "7" });
    const forecast = text(await mcp.callTool({ name: "get_forecast", arguments: { asset: "NVDA", horizon: "1d" } }));
    expect(forecast).toEqual([{ asset: "NVDA", horizon: "1d", direction: "bullish" }]);
    const board = text(await mcp.callTool({ name: "get_leaderboard", arguments: { limit: 2 } }));
    expect(board.models).toHaveLength(2);
    const compared = text(
      await mcp.callTool({
        name: "compare_models",
        arguments: {
          hotkeys: [
            "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
            "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty",
          ],
        },
      }),
    );
    expect(compared).toHaveLength(2);
    expect(compared[0].recent).toBeUndefined();
  });

  it("returns tool errors instead of crashing, and rejects bad input", async () => {
    const offline = createClient({
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
      retries: 0,
    });
    const { mcp, logs } = await connect(offline);
    const result = await mcp.callTool({ name: "get_consensus", arguments: {} });
    expect(result.isError).toBe(true);
    expect(logs.some((l) => l.includes("get_consensus failed"))).toBe(true);
    const bad = await mcp.callTool({ name: "get_forecast", arguments: { asset: "NVDA", horizon: "5m" } });
    expect(bad.isError).toBe(true);
  });

  it.skipIf(!existsSync(new URL("../dist/mcp-bin.js", import.meta.url)))(
    "built stocktensor-mcp speaks MCP over stdio with a clean stdout",
    async () => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [new URL("../dist/mcp-bin.js", import.meta.url).pathname],
        stderr: "pipe",
      });
      const mcp = new Client({ name: "test", version: "0" });
      await mcp.connect(transport);
      const { tools } = await mcp.listTools();
      expect(tools).toHaveLength(6);
      await mcp.close();
    },
  );
});
