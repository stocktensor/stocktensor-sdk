import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    chain: "src/chain.ts",
    mcp: "src/mcp.ts",
    "mcp-bin": "src/mcp-bin.ts",
    ai: "src/ai.ts",
    webhooks: "src/webhooks.ts",
  },
  format: ["esm"],
  dts: { entry: { index: "src/index.ts", chain: "src/chain.ts", mcp: "src/mcp.ts", ai: "src/ai.ts", webhooks: "src/webhooks.ts" } },
  sourcemap: true,
  clean: true,
  target: "es2022",
  splitting: true,
  external: ["viem", "ai", "zod", /^@modelcontextprotocol\/sdk/],
});
