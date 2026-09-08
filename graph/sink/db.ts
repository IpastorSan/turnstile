// SQLite handle + the shape of the rows the rest of the sink writes.
//
// SQLite rather than Postgres on purpose: the discovery store has to be
// runnable from a clean checkout with one command during a demo, and
// `node:sqlite` ships with Node, so there is no server, no container and no
// native build step between `git clone` and a query. The schema is plain SQL
// with no SQLite-only constructs beyond `PRAGMA`, so it ports to Postgres if
// this ever needs to serve more than one process.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = join(HERE, 'schema.sql');
export const DEFAULT_DB_PATH = join(HERE, 'data', 'discovery.db');

export type UriScheme =
  | 'DATA'
  | 'INLINE_JSON'
  | 'IPFS'
  | 'HTTPS'
  | 'HTTP'
  | 'EMPTY'
  | 'OTHER'
  | 'UNSPECIFIED';

/** A registration document, however we got hold of it. */
export interface AgentDocument {
  name?: string;
  description?: string;
  image?: string;
  x402Support?: boolean;
  active?: boolean;
  supportedTrust?: string[];
  endpoints?: AgentEndpoint[];
  price?: AgentPrice;
}

export interface AgentEndpoint {
  name?: string;
  uri?: string;
  version?: string;
  skills?: string[];
  domains?: string[];
}

export interface AgentPrice {
  amount?: string;
  currency?: string;
  asset?: string;
  network?: string;
  scheme?: string;
}

/** One `AgentRegistration` from the Substreams module, already normalized. */
export interface AgentRow extends AgentDocument {
  agentUid: string;
  namespace: string;
  chainId: number;
  network: string;
  registry: string;
  agentId: string;
  owner: string;
  operator: string;
  operatorSource: string;
  agentUri: string;
  uriScheme: UriScheme;
  inModuleResolved: boolean;
  lastEvent: string;
  blockNumber: number;
  blockTimestamp: number;
  transactionHash: string;
  logIndex: number;
}

export interface WalletUpdateRow {
  agentUid: string;
  wallet: string;
  blockNumber: number;
  blockTimestamp: number;
  transactionHash: string;
  logIndex: number;
}

/**
 * Open the store, creating it if it does not exist. `schema.sql` is idempotent
 * (`CREATE TABLE IF NOT EXISTS` throughout), so this doubles as the migration.
 */
export function openDb(path: string = DEFAULT_DB_PATH): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  return db;
}

/** `URI_SCHEME_HTTPS` -> `HTTPS`. Proto3 JSON spells enums out in full. */
export function stripEnumPrefix(value: string | undefined, prefix: string): string {
  if (!value) return 'UNSPECIFIED';
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

export function jsonOrNull(value: unknown[] | undefined): string | null {
  return value && value.length > 0 ? JSON.stringify(value) : null;
}

export function nullIfEmpty(value: string | undefined | null): string | null {
  return value === undefined || value === null || value === '' ? null : value;
}

/**
 * Upsert an agent, keeping the row with the highest (block_number, log_index).
 *
 * The stream is append-only and can be replayed out of order across runs — a
 * backfill of an older range must not overwrite newer state — so the guard is
 * in the SQL rather than in the caller.
 */
export function upsertAgent(db: DatabaseSync, r: AgentRow): void {
  db.prepare(`
    INSERT INTO agent (
      agent_uid, namespace, chain_id, network, registry, agent_id,
      owner, operator, operator_source,
      agent_uri, uri_scheme, in_module_resolved,
      name, description, image, x402_support, active, supported_trust,
      price_amount, price_currency, price_asset, price_network, price_scheme,
      last_event, block_number, block_timestamp, transaction_hash, log_index,
      first_seen_block, first_seen_timestamp
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?
    )
    ON CONFLICT(agent_uid) DO UPDATE SET
      owner              = excluded.owner,
      operator           = excluded.operator,
      operator_source    = excluded.operator_source,
      agent_uri          = excluded.agent_uri,
      uri_scheme         = excluded.uri_scheme,
      in_module_resolved = excluded.in_module_resolved,
      name               = excluded.name,
      description        = excluded.description,
      image              = excluded.image,
      x402_support       = excluded.x402_support,
      active             = excluded.active,
      supported_trust    = excluded.supported_trust,
      price_amount       = excluded.price_amount,
      price_currency     = excluded.price_currency,
      price_asset        = excluded.price_asset,
      price_network      = excluded.price_network,
      price_scheme       = excluded.price_scheme,
      last_event         = excluded.last_event,
      block_number       = excluded.block_number,
      block_timestamp    = excluded.block_timestamp,
      transaction_hash   = excluded.transaction_hash,
      log_index          = excluded.log_index
    -- Only a strictly later event replaces current state. The stream is
    -- append-only but a run can replay an older range, and a backfill must not
    -- overwrite newer state with staler state.
    WHERE (excluded.block_number, excluded.log_index) > (agent.block_number, agent.log_index)
  `).run(
    r.agentUid, r.namespace, r.chainId, r.network, r.registry, r.agentId,
    r.owner, r.operator, r.operatorSource,
    r.agentUri, r.uriScheme, r.inModuleResolved ? 1 : 0,
    nullIfEmpty(r.name), nullIfEmpty(r.description), nullIfEmpty(r.image),
    r.x402Support ? 1 : 0, r.active ? 1 : 0, jsonOrNull(r.supportedTrust),
    nullIfEmpty(r.price?.amount), nullIfEmpty(r.price?.currency), nullIfEmpty(r.price?.asset),
    nullIfEmpty(r.price?.network), nullIfEmpty(r.price?.scheme),
    r.lastEvent, r.blockNumber, r.blockTimestamp, r.transactionHash, r.logIndex,
    r.blockNumber, r.blockTimestamp,
  );

  // `first_seen` moves backwards only, and has to be maintained separately:
  // the upsert above is guarded on the row being NEWER, so backfilling an older
  // range — the one case where an earlier first_seen is discovered — takes the
  // no-op branch and would never reach a first_seen assignment inside it.
  db.prepare(`
    UPDATE agent SET first_seen_block = ?, first_seen_timestamp = ?
    WHERE agent_uid = ? AND first_seen_block > ?
  `).run(r.blockNumber, r.blockTimestamp, r.agentUid, r.blockNumber);
}

/**
 * Replace an agent's endpoints and the capability tokens derived from them.
 *
 * Endpoints are a whole-document property: a URI_UPDATED that drops an endpoint
 * must drop it here too, so this deletes before inserting rather than merging.
 */
export function replaceEndpoints(
  db: DatabaseSync,
  agentUid: string,
  source: 'in_module' | 'fetched',
  endpoints: AgentEndpoint[] | undefined,
  supportedTrust: string[] | undefined,
): void {
  db.prepare('DELETE FROM agent_endpoint WHERE agent_uid = ?').run(agentUid);
  db.prepare('DELETE FROM agent_capability WHERE agent_uid = ?').run(agentUid);

  const insertEndpoint = db.prepare(`
    INSERT OR REPLACE INTO agent_endpoint (agent_uid, idx, source, name, uri, version, skills, domains)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertCapability = db.prepare(`
    INSERT OR IGNORE INTO agent_capability (agent_uid, capability, source) VALUES (?, ?, ?)
  `);

  (endpoints ?? []).forEach((e, idx) => {
    insertEndpoint.run(
      agentUid, idx, source,
      nullIfEmpty(e.name), nullIfEmpty(e.uri), nullIfEmpty(e.version),
      jsonOrNull(e.skills), jsonOrNull(e.domains),
    );
    for (const skill of e.skills ?? []) {
      for (const token of capabilityTokens(skill)) insertCapability.run(agentUid, token, 'skill');
    }
    for (const domain of e.domains ?? []) {
      for (const token of capabilityTokens(domain)) insertCapability.run(agentUid, token, 'domain');
    }
    if (e.name) insertCapability.run(agentUid, normalizeCapability(e.name), 'endpoint');
  });

  for (const trust of supportedTrust ?? []) {
    insertCapability.run(agentUid, normalizeCapability(trust), 'trust');
  }
}

/**
 * Capability tokens are compared, not displayed, so they are lowercased and
 * their separators unified. `Uniswap_V4` and `uniswap-v4` are the same
 * capability; agents spell them both ways.
 */
export function normalizeCapability(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, '-');
}

/**
 * Every token a capability string should be findable under.
 *
 * OASF skills are slash-delimited taxonomy paths —
 * `tool_interaction/blockchain_interaction`. Indexing only the full path would
 * mean a search for `blockchain-interaction` misses every agent that declared
 * it, so each segment is indexed alongside the whole path. Single-character
 * segments are dropped as noise.
 */
export function capabilityTokens(value: string): string[] {
  const full = normalizeCapability(value);
  if (full === '') return [];
  const tokens = new Set<string>([full]);
  for (const segment of full.split('/')) {
    const token = segment.trim();
    if (token.length > 1) tokens.add(token);
  }
  return [...tokens];
}

export function recordWalletUpdate(db: DatabaseSync, u: WalletUpdateRow): void {
  db.prepare(`
    INSERT OR IGNORE INTO agent_wallet_update
      (agent_uid, wallet, block_number, block_timestamp, transaction_hash, log_index)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(u.agentUid, u.wallet, u.blockNumber, u.blockTimestamp, u.transactionHash, u.logIndex);
}

/**
 * Point every agent at its latest `agentWallet`.
 *
 * The Substreams map module is a pure function of one block, so it can only see
 * a wallet change that lands in the same block as the registration. Folding the
 * wallet history back in is the sink's job — it is the same join
 * `map_agent_directory` does with `store_agent_wallets`, done here so the sink
 * does not have to pay for a full store backfill on every run.
 */
export function foldWallets(db: DatabaseSync): number {
  const result = db.prepare(`
    UPDATE agent SET
      operator = (
        SELECT w.wallet FROM agent_wallet_update w
        WHERE w.agent_uid = agent.agent_uid
        ORDER BY w.block_number DESC, w.log_index DESC LIMIT 1
      ),
      operator_source = 'AGENT_WALLET'
    WHERE EXISTS (SELECT 1 FROM agent_wallet_update w WHERE w.agent_uid = agent.agent_uid)
      AND operator <> (
        SELECT w.wallet FROM agent_wallet_update w
        WHERE w.agent_uid = agent.agent_uid
        ORDER BY w.block_number DESC, w.log_index DESC LIMIT 1
      )
  `).run();
  return Number(result.changes);
}

export function updateCursor(
  db: DatabaseSync,
  network: string,
  chainId: number,
  registry: string,
  startBlock: number,
  lastBlock: number,
  blocksSeen: number,
  rowsWritten: number,
): void {
  db.prepare(`
    INSERT INTO sink_cursor (network, chain_id, registry, start_block, last_block, blocks_seen, rows_written, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(network) DO UPDATE SET
      chain_id     = excluded.chain_id,
      registry     = excluded.registry,
      start_block  = MIN(sink_cursor.start_block, excluded.start_block),
      last_block   = MAX(sink_cursor.last_block, excluded.last_block),
      blocks_seen  = sink_cursor.blocks_seen + excluded.blocks_seen,
      rows_written = sink_cursor.rows_written + excluded.rows_written,
      updated_at   = unixepoch()
  `).run(network, chainId, registry, startBlock, lastBlock, blocksSeen, rowsWritten);
}
