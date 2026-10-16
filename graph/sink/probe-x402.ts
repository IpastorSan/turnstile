#!/usr/bin/env node
// Ask an agent what it charges, by getting a 402 out of it.
//
//   node graph/sink/probe-x402.ts --db graph/sink/data/discovery.db --limit 50
//
// This is the third leg of the discovery join, and the only one that works for
// agents that are not ours. Under x402 the quote does not exist anywhere until
// the buyer asks: the registry has no price field, the registration document
// has no price (zero of 1,200 surveyed carried one), and the seller has no
// reason to publish one in advance. `x402Support` in the registration means
// exactly "ask the endpoint" — so this asks.
//
// It is a separate command from `resolve-cards` on purpose. Resolving a
// document is reading something already published; probing is an unsolicited
// request to a third party's paid endpoint. That should be something an
// operator runs deliberately, against a bounded set, not a side effect of
// sinking a block range.

import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';

import { decodePaymentRequiredHeader } from '@x402/core/http';

import { flag, main, numberFlag } from './cli.ts';
import { DEFAULT_DB_PATH, openDb } from './db.ts';
import { DEFAULT_TIMEOUT_MS, isBlockedHost } from './card.ts';

export type ProbeStatus = 'quoted' | 'no_402' | 'http_error' | 'timeout' | 'network_error' | 'parse_error' | 'blocked_host';

export interface ProbeResult {
  status: ProbeStatus;
  httpStatus?: number;
  error?: string;
  amount?: string;
  currency?: string;
  asset?: string;
  network?: string;
  scheme?: string;
  payTo?: string;
  raw?: string;
}

interface X402Requirement {
  scheme?: string;
  network?: string;
  maxAmountRequired?: string;
  amount?: string;
  asset?: string;
  payTo?: string;
  extra?: { name?: string; version?: string };
}

/**
 * Read the first payment requirement out of an x402 body.
 *
 * The response carries an `accepts` array — a seller may quote the same service
 * on several rails. The first entry is taken as the headline price; the raw
 * body is stored so a caller that cares which rail it is paying on can look.
 */
export function parseX402Body(body: unknown): Partial<ProbeResult> {
  if (typeof body !== 'object' || body === null) return {};
  const o = body as Record<string, unknown>;
  const accepts = Array.isArray(o.accepts) ? (o.accepts as X402Requirement[]) : [];
  const req = accepts[0] ?? (o as X402Requirement);
  if (!req) return {};
  return {
    amount: req.maxAmountRequired ?? req.amount,
    currency: req.extra?.name,
    asset: req.asset,
    network: req.network,
    scheme: req.scheme,
    payTo: req.payTo,
  };
}

/**
 * Read the quote out of an x402 v2 `PAYMENT-REQUIRED` header.
 *
 * v2 moved the challenge out of the body: the header carries the whole
 * `PaymentRequired` object base64-encoded, and the body may be `{}`. Reading only
 * the body reported a perfectly good v2 quote as "402 body carried no amount" —
 * that is how Capminal's 0.50 USDC quote on Base was missed (TUR-1, verified
 * 2026-10-16). Decoding is `@x402/core`'s, the same helper `purchase.ts` pays
 * through, so the probe and the buyer cannot disagree on what a header says.
 */
export function parseX402Header(value: string): Partial<ProbeResult> {
  const decoded = decodePaymentRequiredHeader(value) as unknown;
  return parseX402Body(decoded);
}

/**
 * Read a 402 the way a v2 client does: the header first, then the body.
 *
 * Returns the fields plus where they came from, or `null` fields when neither
 * carries an amount. A malformed header falls through to the body rather than
 * hiding a body that does quote.
 */
export function parseX402Response(
  headerValue: string | null,
  bodyText: string,
): { fields: Partial<ProbeResult>; from: 'header' | 'body' | null; error?: string } {
  let headerError: string | undefined;
  if (headerValue) {
    try {
      const fields = parseX402Header(headerValue);
      if (fields.amount) return { fields, from: 'header' };
    } catch (err) {
      headerError = `PAYMENT-REQUIRED header: ${(err as Error).message.slice(0, 160)}`;
    }
  }
  try {
    const fields = parseX402Body(JSON.parse(bodyText));
    if (fields.amount) return { fields, from: 'body' };
  } catch (err) {
    return { fields: {}, from: null, error: headerError ?? (err as Error).message.slice(0, 200) };
  }
  return {
    fields: {},
    from: null,
    error: headerError ?? (headerValue ? '402 header and body carried no amount' : '402 body carried no amount'),
  };
}

/**
 * The requests a probe makes, in order, stopping at the first 402.
 *
 *   GET            an x402-gated HTTP resource answers this with a 402.
 *   POST {}        a gated JSON API that only routes POST answers GET with 405
 *                  and this with 402 — Capminal's `/api/x402/deploy` does exactly
 *                  that (verified 2026-10-16, TUR-1).
 *   POST tools/list an MCP endpoint answers JSON-RPC, so a body-less POST is a
 *                  protocol error rather than a request. `tools/list` is the
 *                  cheapest legitimate call, and a paid MCP server should answer
 *                  it with a 402.
 */
export const PROBE_ATTEMPTS = ['GET', 'POST', 'POST tools/list'] as const;
type ProbeAttempt = typeof PROBE_ATTEMPTS[number];

async function attempt(
  url: string,
  kind: ProbeAttempt,
  timeoutMs: number,
): Promise<{ response?: Response; error?: { status: ProbeStatus; error: string } }> {
  const method = kind === 'GET' ? 'GET' : 'POST';
  try {
    const response = await fetch(url, {
      method,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: method === 'POST'
        ? { accept: 'application/json, text/event-stream', 'content-type': 'application/json' }
        : { accept: 'application/json' },
      body: kind === 'POST tools/list'
        ? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
        : kind === 'POST' ? '{}' : undefined,
    });
    return { response };
  } catch (err) {
    const name = (err as Error).name;
    return {
      error: {
        status: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network_error',
        error: (err as Error).message.slice(0, 300),
      },
    };
  }
}

/**
 * Ask an endpoint for its price.
 *
 * Tried as each of `PROBE_ATTEMPTS` in turn. An x402-gated HTTP resource
 * answers the GET with a 402; a POST-only API answers GET with 405; an
 * x402-gated MCP server has nothing to say to a GET and only quotes on the
 * JSON-RPC call. A probe that asked one way would report "no price" for agents
 * that do in fact have one.
 */
export interface ProbeOptions {
  /**
   * Probe a private or loopback address anyway.
   *
   * Off by default, and the default is the important half: this function's usual
   * input is a URL a stranger put in an on-chain registration, and following one
   * of those to `http://169.254.169.254/` is a server-side request forgery with
   * extra steps.
   *
   * A URL an operator typed is not that input. `mcp-turnstile` sets this when —
   * and only when — the caller named the URL itself rather than reading it out
   * of the directory, because a seller running on `127.0.0.1` during a demo is
   * an ordinary thing to want to quote and the guard would otherwise make the
   * tool useless for it. The distinction is provenance, not the address.
   */
  allowPrivateHosts?: boolean;
}

export async function probeEndpoint(
  url: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { status: 'network_error', error: 'malformed URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { status: 'network_error', error: `protocol ${parsed.protocol}` };
  }
  if (!options.allowPrivateHosts && await isBlockedHost(parsed.hostname)) {
    return { status: 'blocked_host', error: `refusing private host ${parsed.hostname}` };
  }

  let last: ProbeResult | undefined;
  for (const method of PROBE_ATTEMPTS) {
    const { response, error } = await attempt(url, method, timeoutMs);
    if (!response) {
      last = { status: error!.status, error: `${method}: ${error!.error}` };
      continue;
    }

    if (response.status !== 402) {
      // Not an error on our side: plenty of agents advertise x402Support and
      // serve their endpoint free, or gate it some other way, or have simply
      // let the URL rot. Recorded as such.
      last = {
        status: response.status >= 400 ? 'http_error' : 'no_402',
        httpStatus: response.status,
        error: `${method} expected 402, got ${response.status}`,
      };
      continue;
    }

    const header = response.headers.get('payment-required');
    const text = (await response.text()).slice(0, 16_384);
    const { fields, from, error: parseError } = parseX402Response(header, text);
    // Store what the quote was read from. For a v2 header that is the header —
    // the body is often `{}` and would make the stored evidence look empty.
    const raw = from === 'header' ? JSON.stringify(decodePaymentRequiredHeader(header!)) : text;
    if (!fields.amount) {
      return { status: 'parse_error', httpStatus: 402, error: `${method}: ${parseError}`, raw: header ?? text };
    }
    return { status: 'quoted', httpStatus: 402, raw, ...fields };
  }

  return last ?? { status: 'network_error', error: 'no attempt produced a response' };
}

/**
 * Endpoint roles in the order worth asking first. Order only — every http(s)
 * endpoint is asked (see `probeAgent`).
 */
export const ENDPOINT_PRIORITY = ['x402', 'api', 'mcp', 'a2a'];

export interface ProbeEndpointRef {
  name: string | null;
  uri: string | null;
}

/** The http(s) endpoints of an agent, deduplicated, in `ENDPOINT_PRIORITY` order. */
export function probeableEndpoints<T extends ProbeEndpointRef>(endpoints: readonly T[]): T[] {
  const rank = (e: T): number => {
    const i = ENDPOINT_PRIORITY.indexOf((e.name ?? '').toLowerCase());
    return i === -1 ? ENDPOINT_PRIORITY.length : i;
  };
  const http = endpoints.filter((e) => e.uri && /^https?:\/\//i.test(e.uri));
  // Array.prototype.sort is stable, so equal ranks keep document order.
  const ordered = [...http].sort((a, b) => rank(a) - rank(b));
  const seen = new Set<string>();
  const out: T[] = [];
  for (const e of ordered) {
    if (seen.has(e.uri!)) continue;
    seen.add(e.uri!);
    out.push(e);
  }
  return out;
}

/**
 * Ask every http(s) endpoint of one agent, in priority order.
 *
 * **Correction (2026-10-16, TUR-1):** this used to probe ONE endpoint per agent,
 * ranked x402 > api > mcp > a2a > other, on the theory that an agent naming an
 * MCP service had told us where it takes money. Capminal disproves it: its MCP
 * URL is an HTML page that answers 200, and the quote lives on its `custom`
 * service (`/api/x402/deploy`), which the ranking never reached. The name an
 * agent gives a service says nothing reliable about which one is paid. The
 * ranking survives as an ordering only.
 *
 * Every endpoint is asked even after one quotes, so the store records each
 * endpoint's answer rather than stopping at the first.
 */
export async function probeAgent<T extends ProbeEndpointRef>(
  endpoints: readonly T[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
  options: ProbeOptions & { probeFn?: typeof probeEndpoint } = {},
): Promise<{ endpoint: T; result: ProbeResult }[]> {
  const probe = options.probeFn ?? probeEndpoint;
  const out: { endpoint: T; result: ProbeResult }[] = [];
  for (const endpoint of probeableEndpoints(endpoints)) {
    out.push({ endpoint, result: await probe(endpoint.uri!, timeoutMs, options) });
  }
  return out;
}

export interface Candidate {
  agent_uid: string;
  endpoints: ProbeEndpointRef[];
}

/**
 * Agents worth asking: they advertise x402 support and publish at least one
 * http(s) endpoint we have not asked yet. Every unasked endpoint is returned,
 * not the one that ranks first — see the correction on `probeAgent`.
 *
 * An (agent, endpoint) pair already in `x402_quote` is skipped, whatever its
 * status, so a re-run picks up new endpoints without re-asking old ones. Delete
 * an agent's rows to ask again.
 */
export function selectProbeCandidates(db: DatabaseSync, limit: number, network?: string): Candidate[] {
  const params: (string | number)[] = [];
  const networkClause = network ? 'AND a.network = ?' : '';
  if (network) params.push(network);
  const rows = db.prepare(`
    SELECT a.agent_uid, e.name, e.uri
    FROM agent_current a
    JOIN agent_endpoint e ON e.agent_uid = a.agent_uid
    WHERE a.x402_support = 1
      AND e.uri LIKE 'http%'
      ${networkClause}
      AND NOT EXISTS (
        SELECT 1 FROM x402_quote q WHERE q.agent_uid = a.agent_uid AND q.endpoint = e.uri
      )
    ORDER BY a.block_timestamp DESC, a.agent_uid, e.idx
  `).all(...params) as unknown as { agent_uid: string; name: string | null; uri: string }[];

  const byAgent = new Map<string, ProbeEndpointRef[]>();
  for (const r of rows) {
    if (!byAgent.has(r.agent_uid)) {
      if (byAgent.size >= limit) continue;
      byAgent.set(r.agent_uid, []);
    }
    byAgent.get(r.agent_uid)!.push({ name: r.name, uri: r.uri });
  }
  return [...byAgent].map(([agent_uid, endpoints]) => ({ agent_uid, endpoints: probeableEndpoints(endpoints) }));
}

export function writeQuote(db: DatabaseSync, agentUid: string, endpoint: string, result: ProbeResult): void {
  db.prepare(`
    INSERT OR REPLACE INTO x402_quote
      (agent_uid, endpoint, status, http_status, error, amount, currency, asset, network, scheme, pay_to, raw_json, probed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
  `).run(
    agentUid, endpoint, result.status, result.httpStatus ?? null, result.error ?? null,
    result.amount ?? null, result.currency ?? null, result.asset ?? null,
    result.network ?? null, result.scheme ?? null, result.payTo ?? null,
    result.raw ?? null,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main(async () => {
    const argv = process.argv.slice(2);
    const timeoutMs = numberFlag(argv, '--timeout-ms', DEFAULT_TIMEOUT_MS);
    const url = flag(argv, '--url');
    const db = openDb(flag(argv, '--db') ?? DEFAULT_DB_PATH);
    try {
      if (url) {
        console.log(JSON.stringify(await probeEndpoint(url, timeoutMs), null, 2));
        return;
      }
      const candidates = selectProbeCandidates(db, numberFlag(argv, '--limit', 25), flag(argv, '--network'));
      const total = candidates.reduce((n, c) => n + c.endpoints.length, 0);
      process.stderr.write(`${candidates.length} x402 agents, ${total} endpoints to probe\n`);
      const byStatus: Record<string, number> = {};
      const quotedAgents = new Set<string>();
      for (const c of candidates) {
        for (const { endpoint, result } of await probeAgent(c.endpoints, timeoutMs)) {
          writeQuote(db, c.agent_uid, endpoint.uri!, result);
          byStatus[result.status] = (byStatus[result.status] ?? 0) + 1;
          if (result.status === 'quoted') quotedAgents.add(c.agent_uid);
          process.stderr.write(`  ${result.status.padEnd(14)} ${result.amount ?? ''} ${result.currency ?? ''} ${endpoint.uri}\n`);
        }
      }
      process.stderr.write(`\nendpoints ${JSON.stringify(byStatus)}; agents quoted: ${quotedAgents.size}\n`);
    } finally {
      db.close();
    }
  });
}
