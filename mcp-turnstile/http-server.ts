#!/usr/bin/env node
// Turnstile MCP server over HTTP/SSE — the thing behind the on-chain record.
//
//   node mcp-turnstile/http-server.ts
//
// Serves the same four tools as server.ts (which stays the stdio entry, and
// the npm package) at whatever path Caddy forwards, so the URL
// `agent-endpoint[mcp]` publishes — `…/liquidity.turnstile.eth/sse` — answers.
//
// The process deliberately gets NO copy of the repo .env (see compose.yaml):
// no buyer key means `purchase` refuses with the real quote attached, which is
// the same no_signer answer the stdio server gives on an unfunded laptop. The
// endpoint can be public because it holds nothing worth stealing — discovery,
// pricing and receipts need no credential, and this host reaches the
// metadata service of its own VM exactly as little as you can.

import { installFetchGuard, createMcpApp } from './http-app.ts';
import { resolveStore, StoreNotFound } from './store.ts';

const port = Number(process.env['PORT'] ?? 4030);

// Before the store, before routes: a caller choosing URLs is the threat model
// here, and the guard has to be on the same globalFetch the tools reach.
const guard = installFetchGuard();


let store;
try {
  store = resolveStore(process.env['TURNSTILE_DB']);
} catch (cause) {
  process.stderr.write(`${cause instanceof StoreNotFound ? cause.message : String(cause)}\n`);
  process.exit(1);
}

// DNS-rebinding protection: accept requests only for the hostname the record
// publishes. Unset means no restriction, which is right locally and wrong
// anywhere else, so compose passes TURNSTILE_SITE_ADDRESS through.
const allowedHosts = (process.env['MCP_ALLOWED_HOSTS'] ?? '')
  .split(',')
  .map(host => host.trim())
  .filter(Boolean);

const app = createMcpApp({ store, allowedHosts });

app.listen(port, () => {
  process.stderr.write(
    `turnstile MCP (http/sse) on :${port} — GET <name>/sse, POST <name>/messages\n` +
      `  store  ${store.path} (${store.source})\n` +
      `  hosts  ${allowedHosts.length ? allowedHosts.join(', ') : 'any (no rebinding protection)'}\n` +
      `  key    ${process.env['HEDERA_BUYER_ID'] ? 'present — purchase can settle' : 'none — purchase returns no_signer with the real quote'}\n`,
  );
});

// Exposed for a future /metrics; the count is the interesting one on a public
// host because every increment was somebody probing for the metadata service.
process.on('SIGTERM', () => {
  process.stderr.write(`fetch guard blocked ${guard.blockedCount()} private-network targets this run\n`);
  process.exit(0);
});
