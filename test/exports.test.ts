import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { stocktensorTools } from "../src/ai.js";
import type { StocktensorClient } from "../src/index.js";

// Walk the static import graph from an entry and collect bare (package) imports.
function packageImports(entry: string, seen = new Set<string>(), found = new Set<string>()): Set<string> {
  if (seen.has(entry)) return found;
  seen.add(entry);
  const source = readFileSync(entry, "utf8");
  for (const match of source.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"/gms)) {
    const spec = match[1]!;
    if (spec.startsWith(".")) packageImports(resolve(dirname(entry), spec.replace(/\.js$/, ".ts")), seen, found);
    else found.add(spec);
  }
  return found;
}

const src = (file: string) => new URL(`../src/${file}`, import.meta.url).pathname;

describe("entry points", () => {
  it("the root import needs no optional dependencies", () => {
    expect([...packageImports(src("index.ts"))]).toEqual([]);
  });

  it("only the ai subpath imports `ai`; chain and webhooks stay light", () => {
    expect([...packageImports(src("chain.ts"))]).toEqual(["viem"]);
    expect([...packageImports(src("webhooks.ts"))]).toEqual([]);
    expect(packageImports(src("ai.ts")).has("ai")).toBe(true);
    for (const entry of ["index.ts", "chain.ts", "mcp.ts", "webhooks.ts"])
      expect(packageImports(src(entry)).has("ai")).toBe(false);
  });

  it("package.json exports every built entry", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(Object.keys(pkg.exports)).toEqual([".", "./chain", "./mcp", "./ai", "./webhooks", "./package.json"]);
    expect(pkg.bin["stocktensor-mcp"]).toBe("./dist/mcp-bin.js");
    expect(pkg.peerDependenciesMeta.ai.optional).toBe(true);
  });
});

describe("ai tools", () => {
  it("exposes Vercel AI SDK tools wired to the client", async () => {
    const client = {
      consensus: async (filter: unknown) => [{ filter }],
      forecasts: async () => [],
      leaderboard: async () => ({ epoch: 1, updated_at: 0, models: [{ rank: 1 }, { rank: 2 }] }),
    } as unknown as StocktensorClient;
    const tools = stocktensorTools({ client });
    expect(Object.keys(tools).sort()).toEqual([
      "getConsensus",
      "getForecast",
      "getLeaderboard",
      "getPrice",
      "getPrices",
    ]);
    const opts = { toolCallId: "1", messages: [] } as never;
    expect(await tools.getConsensus!.execute!({ asset: "SPY" }, opts)).toEqual([
      { filter: { asset: "SPY", horizon: undefined } },
    ]);
    expect(((await tools.getLeaderboard!.execute!({ limit: 1 }, opts)) as { models: unknown[] }).models).toHaveLength(
      1,
    );
  });
});
