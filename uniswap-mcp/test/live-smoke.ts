// Live smoke test. Not part of `npm test`: it needs the network and real
// mainnet state, so it is a thing you run, not a thing CI gates on.
//
//   node uniswap-mcp/test/live-smoke.ts
//
// It drives the server the way a real client does — spawning it over stdio and
// calling tools through the MCP SDK — rather than importing the handlers, so it
// exercises the transport, the schemas and the registration as well as the
// logic.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, '..', 'server.ts');

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

function firstText(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content ?? [];
  return content[0]?.text ?? '';
}

const client = new Client({ name: 'uniswap-mcp-smoke', version: '0.1.0' });
await client.connect(new StdioClientTransport({ command: 'node', args: [serverPath] }));

const tools = await client.listTools();
console.log(`tools: ${tools.tools.map((t) => t.name).join(', ')}\n`);

for (const [label, call] of [
  ['uniswap_token', { name: 'uniswap_token', arguments: { address: USDC } }],
  ['uniswap_find_pools', { name: 'uniswap_find_pools', arguments: { tokenA: WETH, tokenB: USDC } }],
  ['uniswap_quote', {
    name: 'uniswap_quote',
    arguments: { tokenIn: WETH, tokenOut: USDC, amountIn: 1, feeTier: 500 },
  }],
  ['uniswap_pool_depth', {
    name: 'uniswap_pool_depth',
    arguments: { tokenIn: WETH, tokenOut: USDC, feeTier: 500, baseAmountIn: 1 },
  }],
  ['uniswap_amm_query', {
    name: 'uniswap_amm_query',
    arguments: { canned: 'protocol_vitals' },
  }],
] as const) {
  console.log(`=== ${label} ===`);
  const result = await client.callTool(call as never);
  console.log(firstText(result));
  console.log();
}

await client.close();
