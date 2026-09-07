#!/usr/bin/env node
// Resolve the registration documents the Substreams module cannot.
//
//   node graph/sink/resolve-cards.ts --db graph/sink/data/discovery.db
//   node graph/sink/resolve-cards.ts --network base --limit 200 --concurrency 12
//
// A `data:` URI decodes in-module; `ipfs://` and `https://` do not, and they
// are the majority of the directory. This walks the agents the module left
// unresolved, fetches each document once, and writes the outcome — including
// the failures. Recording a 404 is the point: a directory that silently drops
// agents it could not reach reports a resolution rate it has not earned.

import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';

import { flag, has, main, numberFlag } from './cli.ts';
import { DEFAULT_DB_PATH, jsonOrNull, nullIfEmpty, openDb, replaceEndpoints } from './db.ts';
import { DEFAULT_TIMEOUT_MS, fetchAgentCard, parseAgentDocument } from './card.ts';
import type { FetchOutcome } from './card.ts';

/** Upper bound on the registration document kept for re-indexing. */
const MAX_RAW_BYTES = 262_144;

interface Pending {
  agent_uid: string;
  agent_uri: string;
  uri_scheme: string;
  network: string;
}

export interface ResolveStats {
  attempted: number;
  byStatus: Record<string, number>;
  medianMs: number;
  withEndpoints: number;
  withX402: number;
  withPrice: number;
}

/**
 * Agents worth a fetch: an unresolved document, a scheme we can actually
 * retrieve, and either no previous attempt or an attempt against a URI that
 * has since changed. Re-running is therefore cheap and idempotent — it does not
 * re-hammer endpoints that already answered.
 *
 * `--retry-failed` widens this to rows that failed, because a 502 from a public
 * IPFS gateway says nothing about the agent. `--force` widens it to everything.
 */
function selectPending(
  db: DatabaseSync,
  opts: { network?: string; limit: number; retryFailed: boolean; force?: boolean },
): Pending[] {
  const clauses = [
    'a.in_module_resolved = 0',
    "a.uri_scheme IN ('HTTPS', 'HTTP', 'IPFS')",
    "a.agent_uri <> ''",
  ];
  const params: (string | number)[] = [];
  if (opts.network) {
    clauses.push('a.network = ?');
    params.push(opts.network);
  }
  // `--force` refetches everything, including documents already resolved. It
  // exists for the case where the stored copy is unusable — a body truncated at
  // the raw cap will not re-parse, so `--reindex` cannot fix it and only the
  // network can.
  if (!opts.force) {
    clauses.push(
      opts.retryFailed
        ? "(c.agent_uid IS NULL OR c.agent_uri <> a.agent_uri OR c.status <> 'resolved')"
        : '(c.agent_uid IS NULL OR c.agent_uri <> a.agent_uri)',
    );
  }
  params.push(opts.limit);

  return db.prepare(`
    SELECT a.agent_uid, a.agent_uri, a.uri_scheme, a.network
    FROM agent a
    LEFT JOIN agent_card c ON c.agent_uid = a.agent_uid
    WHERE ${clauses.join(' AND ')}
    ORDER BY a.block_timestamp DESC
    LIMIT ?
  `).all(...params) as unknown as Pending[];
}

function writeOutcome(db: DatabaseSync, pending: Pending, outcome: FetchOutcome): void {
  const doc = outcome.document;
  const now = Math.floor(Date.now() / 1000);

  db.prepare(`
    INSERT INTO agent_card (
      agent_uid, agent_uri, source, fetched_url, status, http_status, error,
      duration_ms, attempts, attempted_at, resolved_at,
      name, description, image, x402_support, active, supported_trust,
      price_amount, price_currency, price_asset, price_network, price_scheme, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_uid) DO UPDATE SET
      agent_uri       = excluded.agent_uri,
      source          = excluded.source,
      fetched_url     = excluded.fetched_url,
      status          = excluded.status,
      http_status     = excluded.http_status,
      error           = excluded.error,
      duration_ms     = excluded.duration_ms,
      attempts        = agent_card.attempts + 1,
      attempted_at    = excluded.attempted_at,
      resolved_at     = excluded.resolved_at,
      name            = excluded.name,
      description     = excluded.description,
      image           = excluded.image,
      x402_support    = excluded.x402_support,
      active          = excluded.active,
      supported_trust = excluded.supported_trust,
      price_amount    = excluded.price_amount,
      price_currency  = excluded.price_currency,
      price_asset     = excluded.price_asset,
      price_network   = excluded.price_network,
      price_scheme    = excluded.price_scheme,
      raw_json        = excluded.raw_json
  `).run(
    pending.agent_uid, pending.agent_uri, outcome.source, outcome.fetchedUrl ?? null,
    outcome.status, outcome.httpStatus ?? null, outcome.error ?? null,
    outcome.durationMs, now, outcome.status === 'resolved' ? now : null,
    nullIfEmpty(doc?.name), nullIfEmpty(doc?.description), nullIfEmpty(doc?.image),
    doc?.x402Support === undefined ? null : (doc.x402Support ? 1 : 0),
    doc?.active === undefined ? null : (doc.active ? 1 : 0),
    jsonOrNull(doc?.supportedTrust),
    nullIfEmpty(doc?.price?.amount), nullIfEmpty(doc?.price?.currency), nullIfEmpty(doc?.price?.asset),
    nullIfEmpty(doc?.price?.network), nullIfEmpty(doc?.price?.scheme),
    // Kept so `--reindex` can re-derive endpoints and capabilities when the
    // parser improves, without refetching a hundred third-party endpoints.
    // Capped well under the 1 MiB fetch budget so one enormous card cannot
    // bloat the store, but high enough that a truncated body — which would not
    // re-parse — is the rare exception rather than the rule.
    outcome.raw ? outcome.raw.slice(0, MAX_RAW_BYTES) : null,
  );

  if (outcome.status !== 'resolved' || !doc) return;

  // Endpoints and the capability index come from whichever document won. The
  // in-module pass left nothing here by definition — we only fetch what it
  // could not read — so this is a replace, not a merge.
  replaceEndpoints(db, pending.agent_uid, 'fetched', doc.endpoints, doc.supportedTrust);
}

/**
 * Re-derive endpoints and capabilities from documents already stored, without
 * touching the network.
 *
 * The parser changes as the directory teaches us how agents actually spell
 * things — an OASF taxonomy path that should be searchable by segment, an MCP
 * `tools` array that is a capability list. Refetching 100 third-party endpoints
 * to pick up a parser fix would be rude and slow, and `raw_json` is kept
 * precisely so it is unnecessary.
 */
export function reindex(db: DatabaseSync): { rows: number; capabilities: number } {
  const rows = db.prepare(
    "SELECT agent_uid, raw_json FROM agent_card WHERE status = 'resolved' AND raw_json IS NOT NULL",
  ).all() as unknown as { agent_uid: string; raw_json: string }[];

  let done = 0;
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.raw_json);
    } catch {
      // A raw body truncated at the 16 KiB cap will not re-parse. The stored
      // columns from the original full parse stay as they are.
      continue;
    }
    const doc = parseAgentDocument(parsed);
    replaceEndpoints(db, row.agent_uid, 'fetched', doc.endpoints, doc.supportedTrust);
    done += 1;
  }
  const capabilities = (db.prepare('SELECT COUNT(*) AS n FROM agent_capability').get() as { n: number }).n;
  return { rows: done, capabilities };
}

/**
 * Fetch `pending` with a fixed number of workers.
 *
 * Bounded concurrency rather than `Promise.all` over the whole list: these are
 * arbitrary third-party endpoints, many of them slow, and the failure mode of
 * an unbounded fan-out is a thousand simultaneous sockets and a run that looks
 * hung. Workers pull from a shared cursor, so one slow host does not stall the
 * others behind it.
 */
export async function resolvePending(
  db: DatabaseSync,
  pending: Pending[],
  opts: { concurrency: number; timeoutMs: number; quiet?: boolean },
): Promise<ResolveStats> {
  const stats: ResolveStats = {
    attempted: 0, byStatus: {}, medianMs: 0, withEndpoints: 0, withX402: 0, withPrice: 0,
  };
  const durations: number[] = [];
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= pending.length) return;
      const item = pending[index];

      const outcome = await fetchAgentCard(item.agent_uri, item.uri_scheme, {
        timeoutMs: opts.timeoutMs,
      });
      writeOutcome(db, item, outcome);

      stats.attempted += 1;
      stats.byStatus[outcome.status] = (stats.byStatus[outcome.status] ?? 0) + 1;
      durations.push(outcome.durationMs);
      if (outcome.document?.endpoints?.length) stats.withEndpoints += 1;
      if (outcome.document?.x402Support) stats.withX402 += 1;
      if (outcome.document?.price?.amount) stats.withPrice += 1;

      if (!opts.quiet && stats.attempted % 25 === 0) {
        process.stderr.write(`  resolved ${stats.attempted}/${pending.length}\n`);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(opts.concurrency, pending.length) }, worker));

  durations.sort((a, b) => a - b);
  stats.medianMs = durations.length > 0 ? durations[Math.floor(durations.length / 2)] : 0;
  return stats;
}

// --- entry point ------------------------------------------------------------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main(async () => {
    const argv = process.argv.slice(2);
    const db = openDb(flag(argv, '--db') ?? DEFAULT_DB_PATH);
    try {
      if (has(argv, '--reindex')) {
        const { rows, capabilities } = reindex(db);
        process.stderr.write(`reindexed ${rows} stored documents; ${capabilities} capability tokens\n`);
        return;
      }

      const pending = selectPending(db, {
        network: flag(argv, '--network'),
        limit: numberFlag(argv, '--limit', 5000),
        retryFailed: has(argv, '--retry-failed'),
        force: has(argv, '--force'),
      });

      process.stderr.write(`${pending.length} agents to resolve off-module\n`);
      const stats = await resolvePending(db, pending, {
        concurrency: numberFlag(argv, '--concurrency', 8),
        timeoutMs: numberFlag(argv, '--timeout-ms', DEFAULT_TIMEOUT_MS),
        quiet: has(argv, '--quiet'),
      });

      const resolved = stats.byStatus.resolved ?? 0;
      const pct = stats.attempted > 0 ? ((resolved / stats.attempted) * 100).toFixed(1) : '0.0';
      process.stderr.write(
        `\nattempted ${stats.attempted}, resolved ${resolved} (${pct}%), median ${stats.medianMs}ms\n` +
        `${JSON.stringify(stats.byStatus)}\n` +
        `endpoints ${stats.withEndpoints}, x402Support ${stats.withX402}, price ${stats.withPrice}\n`,
      );
    } finally {
      db.close();
    }
  });
}
