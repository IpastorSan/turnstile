// The MCP server's HTTP/SSE front door.
//
// Why this exists: `agent-endpoint[mcp]` on Sepolia publishes
//
//   https://turnstile.moveseventyeight.com/liquidity.turnstile.eth/sse
//
// and until now nothing served it — the repo's MCP server was stdio-only, so
// the record pointed at a 404 (docs/deploy.md, "Known gap"). This makes the
// record true as published: the SAME four tools from server.ts, over the
// legacy HTTP+SSE transport (`GET …/sse` opens the stream, the stream names
// `POST …/messages` for the return path).
//
// ## The custody story, which is the point of a different file
//
// This process starts WITHOUT the repo `.env`. compose.yaml gives it no
// `env_file`: the only credential it can see is what it is explicitly handed.
// With no buyer key present, `purchase` answers `no_signer` with the real
// quote attached — the same honest refusal the stdio server makes on a machine
// that was never funded. Discovery, pricing and receipts need no key at all,
// so an open endpoint loses nothing and gains the ENS story:
// a judge's agent can follow the on-chain record and transact with the same
// four tools from a browser-less terminal.
//
// ## Why the deprecated SSE transport and not Streamable HTTP
//
// Because that is the URL the chain committed to: `…/sse`. A path is a promise;
// serving streamable-HTTP under an `/sse` name would be a new kind of lie.
// The record can be repointed on a hot-key cadence if the ecosystem moves.

import express from 'express';
import type { Express, Request as ExpressRequest, Response as ExpressResponse } from 'express';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

import { registerFindSellers } from './tools/find-sellers.ts';
import { registerGetOffer } from './tools/get-offer.ts';
import { registerPurchase } from './tools/purchase.ts';
import { registerReceipts } from './tools/receipts.ts';
import type { ResolvedStore } from './store.ts';

/** Idle proxies drop quiet SSE streams; a comment frame every 15s keeps this one alive. */
const KEEP_ALIVE_MS = 15_000;

export interface HttpAppOptions {
  store: ResolvedStore;
  /** Hosts allowed in the Host/Origin header — DNS-rebinding protection. Empty disables it (local dev). */
  allowedHosts?: string[];
  /** Passed to the tools as the default store; per-session servers open it read-only per call. */
  version?: string;
}

// ---------------------------------------------------------------------------
// The SSRF guard
//
// `get_offer` and `purchase` fetch URLs the CALLER chooses (resource overrides,
// bare-URL agents, custom rpcUrl/mirrorNodeUrl). Locally that is a feature —
// the tool description invites pointing at localhost. On a public host the
// same feature is a proxy into the provider's network: 169.254.169.254 is the
// GCP metadata service, and 10.x/127.x are the containers behind it.
//
// So outbound fetch is allowed only to public addresses, resolved before the
// request is made. Two honest limits: (1) DNS rebinding between the lookup here
// and the socket connect is not prevented — Node's fetch does not take a
// resolved-IP pin without an agent rewrite, and that was not worth the
// complexity for a hackathon endpoint whose only "asset" is public data; (2) it
// wraps global fetch, so anything bypassing fetch bypasses the guard. Both
// caveats die with this process if it is ever retired.
// ---------------------------------------------------------------------------

const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal']);

/** True when this IP literal must never be fetched by a public-facing process. */
export function ipRangeBlocked(address: string): boolean {
  const ip = address.includes('.') ? address : address.split('%')[0] ?? address;
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127) return true; // this-network, RFC1918-ish, loopback
    if (a === 169 && b === 254) return true; // link-local — GCP/AWS metadata lives here
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmark
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (/^f[cd]/.test(lower)) return true; // ULA
    if (/^fe[89ab]/.test(lower)) return true; // link-local
    // IPv4-mapped (::ffff:0:0/96) — check the embedded v4 rather than assume.
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return ipRangeBlocked(mapped[1]!);
    if (lower.startsWith('ff')) return true;
    return false;
  }
  // Not an IP we parsed — refuse rather than guess.
  return true;
}

/** True when this URL must never be fetched by a public-facing process. */
export function blockedUrl(raw: URL, blocked: (host: string) => boolean): boolean {
  if (raw.protocol !== 'http:' && raw.protocol !== 'https:') return true;
  const host = raw.hostname.replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTNAMES.has(host.toLowerCase())) return true;
  if (isIP(host) !== 0) return blocked(host);
  return false; // hostnames get checked after DNS resolution, below
}

async function hostResolvesToPrivate(host: string): Promise<boolean> {
  try {
    const records = await lookup(host, { all: true, verbatim: true });
    return records.length === 0 || records.some(record => ipRangeBlocked(record.address));
  } catch {
    return true; // unresolvable is refused too: a failed lookup must not fall open
  }
}

/**
 * Wrap global fetch with the guard. Returns the number of refusals so /health
 * can report it — a blocked request is a probe worth seeing in the open.
 */
export function installFetchGuard(): { blockedCount: () => number } {
  const realFetch = globalThis.fetch;
  let blocked = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let url: URL | null = null;
    try {
      url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url);
    } catch {
      url = null;
    }
    if (url && (blockedUrl(url, ipRangeBlocked) || (isIP(url.hostname.replace(/^\[|\]$/g, '')) === 0 && await hostResolvesToPrivate(url.hostname)))) {
      blocked += 1;
      throw new Error(`fetch to ${url.origin} refused: this MCP host serves private-network addresses`);
    }
    return realFetch(input as RequestInfo, init);
  }) as unknown as typeof globalThis.fetch;
  return { blockedCount: () => blocked };
}

// ---------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------

export function createMcpApp(options: HttpAppOptions): Express {
  const app = express();
  app.disable('x-powered-by');

  /** One transport (one live SSE connection) per session id. */
  const sessions = new Map<string, { transport: SSEServerTransport; server: McpServer }>();

  function buildServer(): McpServer {
    const server = new McpServer({ name: 'turnstile', version: options.version ?? '0.2.0' });
    registerFindSellers(server, { dbPath: options.store.path });
    registerGetOffer(server, { dbPath: options.store.path });
    registerPurchase(server, { dbPath: options.store.path });
    registerReceipts(server);
    return server;
  }

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      transport: 'sse-legacy',
      tools: ['find_sellers', 'get_offer', 'purchase', 'receipts'],
      store: options.store.source,
      sessions: sessions.size,
    });
  });

  // …/<name>/sse — open the stream. The stream's first frame names the return
  // path (…/<name>/messages?sessionId=…), mirroring the on-chain URL exactly.
  app.get(/^.+\/sse$/, async (req: ExpressRequest, res: ExpressResponse) => {
    const messagesPath = (req.path as string).replace(/\/sse$/, '/messages');
    const transport = new SSEServerTransport(messagesPath, res, {
      enableDnsRebindingProtection: (options.allowedHosts?.length ?? 0) > 0,
      allowedHosts: options.allowedHosts,
    });
    const server = buildServer();
    sessions.set(transport.sessionId, { transport, server });

    const keepAlive = setInterval(() => {
      if (!res.writableEnded) res.write(': keep-alive\n\n');
    }, KEEP_ALIVE_MS);

    res.on('close', () => {
      clearInterval(keepAlive);
      sessions.delete(transport.sessionId);
      void server.close().catch(() => undefined);
    });

    try {
      await server.connect(transport);
    } catch (error) {
      sessions.delete(transport.sessionId);
      clearInterval(keepAlive);
      if (!res.headersSent) res.status(500).json({ ok: false, reason: (error as Error).message });
      else res.end();
    }
  });

  // …/<name>/messages?sessionId=… — the return path. The transport reads the
  // raw body itself (content-type and size limits included), so no json parser
  // is mounted; it must see the bytes the client sent.
  app.post(/^.+\/messages$/, async (req: ExpressRequest, res: ExpressResponse) => {
    const sessionId = String(req.query.sessionId ?? '');
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
      res.status(400).json({ ok: false, reason: 'unknown or expired sessionId — reconnect with GET …/sse' });
      return;
    }
    try {
      await session.transport.handlePostMessage(req, res);
    } catch {
      // handlePostMessage already writes an honest status for the common
      // failures (bad JSON, closed stream); this only stops a throw escaping
      // into an unhandled rejection that would take the process with it.
    }
  });

  return app;
}
