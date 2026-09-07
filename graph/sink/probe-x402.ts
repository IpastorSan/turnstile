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

async function attempt(
  url: string,
  method: 'GET' | 'POST',
  timeoutMs: number,
): Promise<{ response?: Response; error?: { status: ProbeStatus; error: string } }> {
  try {
    const response = await fetch(url, {
      method,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: method === 'POST'
        ? { accept: 'application/json, text/event-stream', 'content-type': 'application/json' }
        : { accept: 'application/json' },
      // An MCP endpoint answers JSON-RPC, so a bare POST with no body is a
      // protocol error rather than a request. `tools/list` is the cheapest
      // legitimate call, and a paid MCP server should answer it with a 402.
      body: method === 'POST'
        ? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
        : undefined,
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
 * Tried as a GET first, then as an MCP `tools/list` POST. An x402-gated HTTP
 * resource answers the GET with a 402; an x402-gated MCP server has nothing to
 * say to a GET and only quotes on the JSON-RPC call. Most `agent-endpoint[mcp]`
 * URIs in the directory are the second kind, so a GET-only probe would report
 * "no price" for agents that do in fact have one.
 */
export async function probeEndpoint(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ProbeResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { status: 'network_error', error: 'malformed URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { status: 'network_error', error: `protocol ${parsed.protocol}` };
  }
  if (await isBlockedHost(parsed.hostname)) {
    return { status: 'blocked_host', error: `refusing private host ${parsed.hostname}` };
  }

  let last: ProbeResult | undefined;
  for (const method of ['GET', 'POST'] as const) {
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

    const text = (await response.text()).slice(0, 16_384);
    try {
      const fields = parseX402Body(JSON.parse(text));
      if (!fields.amount) {
        return { status: 'parse_error', httpStatus: 402, error: '402 body carried no amount', raw: text };
      }
      return { status: 'quoted', httpStatus: 402, raw: text, ...fields };
    } catch (err) {
      return { status: 'parse_error', httpStatus: 402, error: (err as Error).message.slice(0, 200), raw: text };
    }
  }

  return last ?? { status: 'network_error', error: 'no attempt produced a response' };
}

interface Candidate {
  agent_uid: string;
  uri: string;
}

/**
 * Agents worth asking: they advertise x402 support and publish an endpoint we
 * can GET. One endpoint per agent — the one it nominated for payment where it
 * named one, since an agent that lists both an `x402` service and a Twitter
 * profile is telling us which of the two takes money.
 */
export function selectProbeCandidates(db: DatabaseSync, limit: number, network?: string): Candidate[] {
  const params: (string | number)[] = [];
  const networkClause = network ? 'AND a.network = ?' : '';
  if (network) params.push(network);
  params.push(limit);
  return db.prepare(`
    SELECT agent_uid, uri FROM (
      SELECT
        a.agent_uid,
        e.uri,
        a.block_timestamp,
        ROW_NUMBER() OVER (
          PARTITION BY a.agent_uid
          ORDER BY
            CASE LOWER(COALESCE(e.name, ''))
              WHEN 'x402' THEN 0
              WHEN 'api'  THEN 1
              WHEN 'mcp'  THEN 2
              WHEN 'a2a'  THEN 3
              ELSE 4
            END,
            e.idx
        ) AS rn
      FROM agent_current a
      JOIN agent_endpoint e ON e.agent_uid = a.agent_uid
      WHERE a.x402_support = 1
        AND e.uri LIKE 'http%'
        ${networkClause}
        -- One probe per AGENT, not per endpoint. An agent that publishes an
        -- x402, API or MCP service has told us where it takes money; if that
        -- URL is dead, that is the finding. Falling through to whatever else it
        -- listed just probes its GitHub link.
        AND NOT EXISTS (SELECT 1 FROM x402_quote q WHERE q.agent_uid = a.agent_uid)
    )
    WHERE rn = 1
    ORDER BY block_timestamp DESC
    LIMIT ?
  `).all(...params) as unknown as Candidate[];
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
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const db = openDb(get('--db') ?? DEFAULT_DB_PATH);
  const url = get('--url');
  if (url) {
    console.log(JSON.stringify(await probeEndpoint(url, Number(get('--timeout-ms') ?? DEFAULT_TIMEOUT_MS)), null, 2));
    db.close();
  } else {
    const candidates = selectProbeCandidates(db, Number(get('--limit') ?? 25), get('--network'));
    process.stderr.write(`${candidates.length} x402 endpoints to probe\n`);
    const byStatus: Record<string, number> = {};
    for (const c of candidates) {
      const result = await probeEndpoint(c.uri, Number(get('--timeout-ms') ?? DEFAULT_TIMEOUT_MS));
      writeQuote(db, c.agent_uid, c.uri, result);
      byStatus[result.status] = (byStatus[result.status] ?? 0) + 1;
      process.stderr.write(`  ${result.status.padEnd(14)} ${result.amount ?? ''} ${result.currency ?? ''} ${c.uri}\n`);
    }
    process.stderr.write(`\n${JSON.stringify(byStatus)}\n`);
    db.close();
  }
}
