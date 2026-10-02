#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createStocktensorMcpServer } from "./mcp.js";

// stdout is the MCP channel: everything human-readable goes to stderr.
const server = createStocktensorMcpServer({
  clientOptions: {
    baseUrl: process.env.STOCKTENSOR_API_URL || undefined,
    apiKey: process.env.STOCKTENSOR_API_KEY || undefined,
  },
  chain: { rpcUrl: process.env.ROBINHOOD_RPC_URL || undefined },
});

await server.connect(new StdioServerTransport());
process.stderr.write("[stocktensor-mcp] ready on stdio\n");
