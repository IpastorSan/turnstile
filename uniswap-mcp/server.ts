#!/usr/bin/env node
// uniswap-mcp — an MCP server over the Uniswap stack.
//
//   node uniswap-mcp/server.ts
//   claude mcp add uniswap -- node /abs/path/uniswap-mcp/server.ts
//
// Standalone by construction: nothing in this directory imports anything
// outside it, so the folder can be copied out, `npm install`ed and run with no
// knowledge of the repository it was written in.
//
// Needs no API key. Every tool is either an `eth_call` against a public
// contract or a POST to a public subgraph endpoint.
//
// Flags (all optional):
//   --rpc <url>        RPC endpoint, overriding <CHAIN>_RPC_URL and the default
//   --subgraph <url>   default subgraph for uniswap_amm_query
//
// stdout is the JSON-RPC transport. Anything else written there corrupts the
// session, so every diagnostic goes to stderr.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { registerAll } from './tools/index.ts';
import { CHAINS } from './src/chains.ts';

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const argv = process.argv.slice(2);
const rpcUrl = flag(argv, '--rpc');
const subgraphUrl = flag(argv, '--subgraph');

const server = new McpServer({ name: 'uniswap-mcp', version: '0.1.0' });
registerAll(server, { rpcUrl, subgraphUrl });

await server.connect(new StdioServerTransport());
process.stderr.write(
  `uniswap-mcp ready — chains: ${Object.keys(CHAINS).join(', ')}`
  + `${rpcUrl ? `, rpc override ${new URL(rpcUrl).host}` : ''}\n`,
);
