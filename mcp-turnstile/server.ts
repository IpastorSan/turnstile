#!/usr/bin/env node
// Turnstile MCP server (stdio).
//
//   npx mcp-turnstile
//   node mcp-turnstile/server.ts --db graph/sink/data/discovery.db
//
// Register it with a client:
//   claude mcp add turnstile -- npx -y mcp-turnstile
//
// ## What this is
//
// Four tools that let one agent find, price, pay and audit another, over
// ERC-8004 + ENSv2 + x402. It is infrastructure, not an app: none of the four
// knows what is being sold, and there is no code path here for any particular
// seller. `find_sellers` reads a directory built from registry events;
// `get_offer` resolves whatever identifier the caller holds into a quote;
// `purchase` pays any x402 endpoint inside a mandate; `receipts` reads the
// settlement trail off a public consensus topic with no key.
//
// ## The credential story, which is the point
//
// Discovery, pricing and receipts need no credential of any kind — not an API
// key, not an account, not a signup. The one secret involved in a purchase is
// the buyer agent's own wallet key, which is the hot tier from CLAUDE.md: it
// signs one transfer inside a mandate it cannot widen, and authorizes nothing
// else. `purchase` with `dryRun` signs nothing and moves nothing; it still wants
// a signer, because the mandate's cap is applied to the buyer's own valuation of
// the asset rather than the seller's.
//
// stdout is the transport. Anything written to it that is not a JSON-RPC frame
// corrupts the session, so every diagnostic below goes to stderr.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { registerFindSellers } from './tools/find-sellers.ts';
import { registerGetOffer } from './tools/get-offer.ts';
import { registerPurchase } from './tools/purchase.ts';
import { registerReceipts } from './tools/receipts.ts';
import { StoreNotFound, resolveStore } from './store.ts';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(
    'turnstile MCP server (stdio)\n\n' +
    '  --db <path>   discovery store. Defaults to graph/sink/data/discovery.db, then the\n' +
    '                web/data/discovery.db snapshot that ships with the repo.\n' +
    '  --help        this.\n\n' +
    'Tools: find_sellers, get_offer, purchase, receipts.\n' +
    'See SKILL.md next to this file.\n',
  );
  process.exit(0);
}

// Resolved before anything opens it. `openDb` creates a missing file, so a bad
// path would otherwise produce an empty store that answers every query with a
// confident "nothing found" — the one failure this server must not have.
let store;
try {
  store = resolveStore(flag('--db') ?? process.env['TURNSTILE_DB']);
} catch (cause) {
  process.stderr.write(`${cause instanceof StoreNotFound ? cause.message : String(cause)}\n`);
  process.exit(1);
}

const server = new McpServer({ name: 'turnstile', version: '0.2.0' });

registerFindSellers(server, { dbPath: store.path });
registerGetOffer(server, { dbPath: store.path });
registerPurchase(server, { dbPath: store.path });
registerReceipts(server);

await server.connect(new StdioServerTransport());
process.stderr.write(
  `turnstile MCP server ready — find_sellers, get_offer, purchase, receipts\n` +
  `  store  ${store.path} (${store.source === 'snapshot' ? 'the snapshot committed to the repo' : store.source})\n` +
  `  wallet ${process.env['HEDERA_BUYER_ID']
    ? `hedera ${process.env['HEDERA_BUYER_ID']}`
    : 'none — find_sellers, get_offer and receipts are unaffected; purchase will fetch the real quote and stop'}\n`,
);
