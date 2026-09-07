// Server-side access to the discovery store.
//
// This deliberately calls the real `findSellers` from seller/service rather
// than reimplementing filtering over an exported JSON blob. The price
// reconciliation in `normalizePriceUsd` and the placeholder-ranking switch in
// `rankingBasis` are the load-bearing parts of MOV-222, and a second
// implementation in the web app would drift from the tested one. So the web app
// runs the same query engine against the same SQLite schema; only the file it
// opens differs between local development and a deployment.

import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DatabaseSync } from 'node:sqlite';

import { findSellers } from '../../seller/service/discovery.ts';
import type { FindSellersQuery, FindSellersResult } from '../../seller/service/discovery.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

/** The working store, rebuilt from chain by graph/sink/. Gitignored, so present only locally. */
const WORKING_STORE = join(REPO, 'graph', 'sink', 'data', 'discovery.db');
/** A dated copy of that store, committed so a deployment has real data to serve. */
const SNAPSHOT_STORE = join(HERE, '..', 'data', 'discovery.db');
const SNAPSHOT_PROVENANCE = join(HERE, '..', 'data', 'provenance.json');

export interface Provenance {
  /** 'working' — the live local store. 'snapshot' — the committed dated copy. */
  kind: 'working' | 'snapshot';
  /** ISO timestamp the data was streamed from chain, for a snapshot. */
  capturedAt: string | null;
  label: string;
  detail: string;
}

export interface StoreUnavailable {
  ok: false;
  reason: string;
}

export type DiscoveryResponse =
  | { ok: true; provenance: Provenance; result: FindSellersResult }
  | StoreUnavailable;

function readProvenanceFile(): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(SNAPSHOT_PROVENANCE, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Pick a store, preferring the live local one. Never invents data when neither exists. */
export function resolveStore(): { path: string; provenance: Provenance } | null {
  if (existsSync(WORKING_STORE)) {
    return {
      path: WORKING_STORE,
      provenance: {
        kind: 'working',
        capturedAt: null,
        label: 'live local store',
        detail:
          'Read from graph/sink/data/discovery.db, the store graph/sink/ rebuilds directly from the ERC-8004 registries.',
      },
    };
  }
  if (existsSync(SNAPSHOT_STORE)) {
    const p = readProvenanceFile();
    const capturedAt = typeof p?.capturedAt === 'string' ? p.capturedAt : null;
    return {
      path: SNAPSHOT_STORE,
      provenance: {
        kind: 'snapshot',
        capturedAt,
        label: 'dated snapshot',
        detail:
          'A committed copy of the store, streamed from the ERC-8004 registries on Base, Ethereum mainnet and Sepolia. Same schema, same query engine — only the capture date is fixed.',
      },
    };
  }
  return null;
}

/**
 * Re-materialise the result as plain objects.
 *
 * `node:sqlite` returns rows with a null prototype, and `findSellers` passes
 * some of them through untouched (coverage.chains, documentStates). React
 * refuses to serialise a null-prototype object across the server/client
 * boundary, so the market page renders blank without this — an error that only
 * appears in the server log, never in the browser. The payload is pure JSON
 * already, so a round trip is lossless here.
 */
function toPlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function querySellers(query: FindSellersQuery): DiscoveryResponse {
  const store = resolveStore();
  if (!store) {
    return {
      ok: false,
      reason:
        'No discovery store is present. Run graph/sink/ to build one, or npm run snapshot to commit a dated copy. No data is served rather than placeholder data.',
    };
  }
  // Opened read-only, rather than through openDb(). openDb executes schema.sql
  // on every connect — idempotent DDL, but still a write, which mutates the
  // file and fails outright on the read-only filesystem most deployments give
  // a server bundle. The web app only ever reads, and the snapshot already has
  // the schema, so there is nothing to migrate.
  const db = new DatabaseSync(store.path, { readOnly: true });
  try {
    const result = toPlain(findSellers(db, query));
    return { ok: true, provenance: store.provenance, result };
  } finally {
    db.close();
  }
}

export type { FindSellersQuery, FindSellersResult };
export type { SellerResult, SellerPrice, PriceSource } from '../../seller/service/discovery.ts';
