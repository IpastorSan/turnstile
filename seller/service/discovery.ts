// Discovery: find and rank sellers.
//
// Discovery is a three-way join, because no single source can answer the whole
// question:
//
//   1. The ERC-8004 registry, via Substreams, says WHO EXISTS — across chains,
//      in one result set. It cannot say what anything costs: EIP-8004
//      registration-v1 has no price field, and a survey of 1,200 live
//      registrations across mainnet, Sepolia and Base Sepolia found zero
//      carrying one. What it does carry is `x402Support` (206 of the 1,200) —
//      the real "this agent can be paid" signal, which means "ask the endpoint".
//   2. Our ENSv2 `turnstile:price` record says what TURNSTILE sellers cost,
//      read off a resolver whose write permissions are split cold/hot.
//   3. A live HTTP 402 response says what anyone ELSE costs, at the moment you
//      ask, because under x402 that is the only place the quote exists.
//
// So: the registry tells you who exists; Turnstile tells you what they cost.
// Every result says which of the three its price came from, or that there is
// none — `priceSource` is never absent and never guessed.

import type { DatabaseSync } from 'node:sqlite';

import { DEFAULT_DB_PATH, normalizeCapability, openDb } from '../../graph/sink/db.ts';

export type PriceSource = 'turnstile' | 'x402' | 'document' | 'ask_x402' | 'none';
export type RankBasis = 'settled_volume' | 'registration_recency';

export interface FindSellersQuery {
  /** Capability tokens. An agent matching ANY of them qualifies. */
  capabilities?: string[];
  /** Ceiling in USD. Agents whose price is not knowable are excluded unless `includeUnknownPrice`. */
  maxPriceUsd?: number;
  /** Network names ("base") or numeric chain ids (8453). Empty means every chain. */
  chains?: (string | number)[];
  /** Only agents that advertise x402 support. */
  requireX402?: boolean;
  /** Only Turnstile sellers — the ones with an exact, on-chain price. */
  turnstileOnly?: boolean;
  /** Keep agents whose price cannot be established, flagged. Default false when `maxPriceUsd` is set. */
  includeUnknownPrice?: boolean;
  /** Also match capability text against name and description. Default true. */
  matchText?: boolean;
  limit?: number;
  offset?: number;
}

export interface SellerPrice {
  /** As published, in the unit the source uses. */
  raw: string;
  /** Normalized to USD, or null when the unit is not one we can convert. */
  usd: number | null;
  currency: string | null;
  source: PriceSource;
  /** True when `usd` is set and can therefore be compared to a ceiling. */
  comparable: boolean;
  /** Turnstile sellers only: the cold-key ceiling their hot key cannot exceed. */
  ceilingUsd?: number | null;
  note?: string;
}

export interface SellerEndpoint {
  name: string | null;
  uri: string | null;
  version: string | null;
  skills: string[];
  domains: string[];
}

export interface SellerResult {
  agentUid: string;
  chainId: number;
  network: string;
  agentId: string;
  registry: string;
  name: string | null;
  description: string | null;
  owner: string;
  /** agentWallet — the address this agent is paid at. */
  payTo: string;
  x402Support: boolean;
  active: boolean;
  capabilities: string[];
  matchedOn: string[];
  endpoints: SellerEndpoint[];
  price: SellerPrice | null;
  /**
   * Why `price` is what it is. `price` is null for BOTH 'ask_x402' and 'none',
   * and those are different situations for a buyer: one agent takes money and
   * will quote you if its endpoint ever answers, the other publishes nothing
   * anywhere. Only the aggregate `priceSources` used to carry the difference,
   * which meant a caller rendering one row could not tell them apart.
   */
  priceSource: PriceSource;
  /** Set when this agent is one of ours, with the offer read from its ENS name. */
  turnstile: {
    ensName: string;
    mcpEndpoint: string | null;
    rails: string[];
    priceCeiling: string | null;
    payoutAddr: string | null;
    resolverVerified: boolean;
  } | null;
  /** Where this agent's document came from: in_module, off_module, failed, no_uri, pending. */
  documentState: string;
  fetchStatus: string | null;
  rank: {
    basis: RankBasis;
    score: number;
    settledCount: number;
    settledVolume: number;
  };
  /** Always 'unknown' — MOV-223 is blocked on World Sandbox approval. */
  worldVerification: string;
  registeredAt: number;
  blockNumber: number;
  transactionHash: string;
}

export interface FindSellersResult {
  sellers: SellerResult[];
  ranking: {
    basis: RankBasis;
    placeholder: boolean;
    note: string;
  };
  coverage: {
    chains: { network: string; chainId: number; agents: number }[];
    totalAgents: number;
    matchedBeforePriceFilter: number;
    droppedForUnknownPrice: number;
    droppedForPriceCeiling: number;
    documentStates: Record<string, number>;
  };
  priceSources: Record<PriceSource, number>;
  seams: Record<string, string>;
}

// --- price normalization ----------------------------------------------------

/** Stablecoins whose smallest unit is 1e-6 of a dollar. */
const USD_STABLES = new Set(['usdc', 'usdt', 'pyusd', 'usd', 'usdbc']);
const SIX_DECIMALS = 1_000_000;

/**
 * Put a price on a comparable scale, or refuse to.
 *
 * The three price sources do not share a unit. `turnstile:price` is a decimal
 * string of dollars, written by a human-authorised hot key ("0.07"). An x402
 * quote's `maxAmountRequired` is an integer in the asset's smallest unit
 * ("70000" USDC). A document price is whatever the agent felt like publishing.
 * Comparing them without saying so would produce a filter that silently ranks a
 * seven-cent seller against a seventy-thousand-dollar one, so anything we
 * cannot convert comes back with `usd: null` and `comparable: false` rather
 * than a number.
 */
export function normalizePriceUsd(
  raw: string | null | undefined,
  currency: string | null | undefined,
  source: PriceSource,
): { usd: number | null; note?: string } {
  if (raw === null || raw === undefined || raw === '') return { usd: null };
  const value = Number(raw);
  if (!Number.isFinite(value)) return { usd: null, note: `unparseable amount ${raw}` };

  if (source === 'turnstile') {
    // turnstile:price is a decimal price in USD by construction — the record is
    // written by us, and docs/ens-offer-records.md defines the unit.
    return { usd: value };
  }

  const unit = (currency ?? '').toLowerCase();
  if (USD_STABLES.has(unit)) {
    // An x402 requirement carries an integer in the asset's smallest unit. A
    // value with a decimal point is already dollars; a bare integer is not.
    return raw.includes('.') ? { usd: value } : { usd: value / SIX_DECIMALS };
  }
  if (unit === '') {
    return { usd: null, note: 'amount published without a currency — not comparable' };
  }
  return { usd: null, note: `unknown currency ${currency} — not comparable` };
}

// --- the query --------------------------------------------------------------

interface Row {
  agent_uid: string;
  chain_id: number;
  network: string;
  registry: string;
  agent_id: string;
  owner: string;
  operator: string;
  name: string | null;
  description: string | null;
  x402_support: number;
  active: number;
  document_state: string;
  fetch_status: string | null;
  turnstile_name: string | null;
  turnstile_mcp_endpoint: string | null;
  turnstile_rails: string | null;
  turnstile_price: string | null;
  turnstile_price_ceiling: string | null;
  turnstile_payout_addr: string | null;
  turnstile_resolver_verified: number | null;
  x402_amount: string | null;
  x402_currency: string | null;
  doc_price_amount: string | null;
  doc_price_currency: string | null;
  price_source: PriceSource;
  settled_count: number;
  settled_volume: number;
  world_verification: string;
  block_timestamp: number;
  block_number: number;
  transaction_hash: string;
  first_seen_block: number;
  first_seen_timestamp: number;
}

function buildFilters(q: FindSellersQuery): { sql: string; params: (string | number)[] } {
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (q.chains && q.chains.length > 0) {
    const networks = q.chains.filter((c) => typeof c === 'string') as string[];
    const ids = q.chains.filter((c) => typeof c === 'number') as number[];
    const parts: string[] = [];
    if (networks.length > 0) {
      parts.push(`network IN (${networks.map(() => '?').join(', ')})`);
      params.push(...networks);
    }
    if (ids.length > 0) {
      parts.push(`chain_id IN (${ids.map(() => '?').join(', ')})`);
      params.push(...ids);
    }
    clauses.push(`(${parts.join(' OR ')})`);
  }

  if (q.requireX402) clauses.push('x402_support = 1');
  if (q.turnstileOnly) clauses.push('turnstile_name IS NOT NULL');

  if (q.capabilities && q.capabilities.length > 0) {
    const tokens = q.capabilities.map(normalizeCapability);
    const parts: string[] = [];

    // A declared skill or domain is the strong signal: it is an index lookup
    // against tokens the agent published, not a guess about its prose.
    parts.push(`agent_uid IN (
      SELECT agent_uid FROM agent_capability
      WHERE ${tokens.map(() => '(capability = ? OR capability LIKE ?)').join(' OR ')}
    )`);
    for (const t of tokens) params.push(t, `%${t}%`);

    // Most of the directory publishes no skills at all, so a capability filter
    // that only looked at `agent_capability` would return almost nothing. The
    // text fallback is opt-out rather than opt-in, and every result records
    // which of the two matched it in `matchedOn`, so a caller can tell a
    // declared capability from a word in a description.
    if (q.matchText !== false) {
      parts.push(`(${tokens.map(() => "(LOWER(COALESCE(name, '')) LIKE ? OR LOWER(COALESCE(description, '')) LIKE ?)").join(' OR ')})`);
      for (const t of tokens) params.push(`%${t}%`, `%${t}%`);
    }
    clauses.push(`(${parts.join(' OR ')})`);
  }

  return { sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/**
 * Rank by settled volume when receipts exist, and say so; otherwise fall back
 * to registration recency and label the result a placeholder.
 *
 * Settled volume is the signal we actually want — it is the one number an agent
 * cannot fake, because it is the sum of payments other buyers really made. It
 * arrives with the HCS receipts in MOV-220. Until then `settlement_receipt` is
 * empty, and ranking a directory by recency and calling it "reputation" would
 * be a lie a demo can tell and a user cannot check. So the basis travels with
 * the result and `placeholder` is true.
 */
export function rankingBasis(db: DatabaseSync): { basis: RankBasis; placeholder: boolean; note: string } {
  const row = db.prepare('SELECT COUNT(*) AS n FROM settlement_receipt').get() as { n: number };
  if (row.n > 0) {
    return {
      basis: 'settled_volume',
      placeholder: false,
      note: `ranked by settled volume over ${row.n} HCS receipts`,
    };
  }
  return {
    basis: 'registration_recency',
    placeholder: true,
    note:
      'PLACEHOLDER: ranked by registration recency. Settled volume is the intended ranking signal ' +
      'and comes from HCS settlement receipts (MOV-220), which do not exist yet — settlement_receipt ' +
      'is empty. This ordering carries no information about how much business an agent has done.',
  };
}

function toEndpoints(db: DatabaseSync, agentUid: string): SellerEndpoint[] {
  const rows = db.prepare(
    'SELECT name, uri, version, skills, domains FROM agent_endpoint WHERE agent_uid = ? ORDER BY idx',
  ).all(agentUid) as unknown as {
    name: string | null; uri: string | null; version: string | null;
    skills: string | null; domains: string | null;
  }[];
  return rows.map((r) => ({
    name: r.name,
    uri: r.uri,
    version: r.version,
    skills: r.skills ? (JSON.parse(r.skills) as string[]) : [],
    domains: r.domains ? (JSON.parse(r.domains) as string[]) : [],
  }));
}

function toPrice(row: Row): SellerPrice | null {
  if (row.price_source === 'turnstile' && row.turnstile_price) {
    const { usd, note } = normalizePriceUsd(row.turnstile_price, 'usd', 'turnstile');
    const ceiling = row.turnstile_price_ceiling ? Number(row.turnstile_price_ceiling) : null;
    return {
      raw: row.turnstile_price,
      usd,
      currency: 'USD',
      source: 'turnstile',
      comparable: usd !== null,
      ceilingUsd: ceiling !== null && Number.isFinite(ceiling) ? ceiling : null,
      note,
    };
  }
  if (row.price_source === 'x402' && row.x402_amount) {
    const { usd, note } = normalizePriceUsd(row.x402_amount, row.x402_currency, 'x402');
    return {
      raw: row.x402_amount, usd, currency: row.x402_currency,
      source: 'x402', comparable: usd !== null, note,
    };
  }
  if (row.price_source === 'document' && row.doc_price_amount) {
    const { usd, note } = normalizePriceUsd(row.doc_price_amount, row.doc_price_currency, 'document');
    return {
      raw: row.doc_price_amount, usd, currency: row.doc_price_currency,
      source: 'document', comparable: usd !== null, note,
    };
  }
  return null;
}

function matchedOn(db: DatabaseSync, agentUid: string, tokens: string[]): string[] {
  if (tokens.length === 0) return [];
  const out = new Set<string>();
  const caps = db.prepare('SELECT capability, source FROM agent_capability WHERE agent_uid = ?')
    .all(agentUid) as unknown as { capability: string; source: string }[];
  for (const t of tokens) {
    for (const c of caps) {
      if (c.capability === t || c.capability.includes(t)) out.add(`${c.source}:${c.capability}`);
    }
  }
  if (out.size === 0) out.add('text:name-or-description');
  return [...out];
}

export function findSellers(db: DatabaseSync, query: FindSellersQuery = {}): FindSellersResult {
  const ranking = rankingBasis(db);
  const { sql: where, params } = buildFilters(query);
  const tokens = (query.capabilities ?? []).map(normalizeCapability);

  const orderBy = ranking.basis === 'settled_volume'
    ? 'settled_volume DESC, settled_count DESC, block_timestamp DESC'
    // Recency of REGISTRATION, not of the last document edit: an agent that
    // repointed its URI yesterday is not a newer agent than one registered
    // yesterday, and ordering by the edit would reward churn.
    : 'first_seen_timestamp DESC, first_seen_block DESC';

  const rows = db.prepare(`
    SELECT * FROM agent_current
    ${where}
    ORDER BY ${orderBy}
  `).all(...params) as unknown as Row[];

  const includeUnknown = query.includeUnknownPrice ?? query.maxPriceUsd === undefined;
  const matchedBeforePriceFilter = rows.length;
  let droppedForUnknownPrice = 0;
  let droppedForPriceCeiling = 0;

  const priceSources: Record<PriceSource, number> = {
    turnstile: 0, x402: 0, document: 0, ask_x402: 0, none: 0,
  };

  const kept: SellerResult[] = [];
  for (const row of rows) {
    priceSources[row.price_source] = (priceSources[row.price_source] ?? 0) + 1;
    const price = toPrice(row);

    if (query.maxPriceUsd !== undefined) {
      if (price?.comparable && price.usd !== null) {
        if (price.usd > query.maxPriceUsd) {
          droppedForPriceCeiling += 1;
          continue;
        }
      } else if (!includeUnknown) {
        // Not a rejection of the agent — a refusal to pretend we know its price.
        // `price_source: 'ask_x402'` is the interesting case: the price IS
        // knowable, we just have not made the 402 call yet.
        droppedForUnknownPrice += 1;
        continue;
      }
    }

    kept.push({
      agentUid: row.agent_uid,
      chainId: row.chain_id,
      network: row.network,
      agentId: row.agent_id,
      registry: row.registry,
      name: row.name,
      description: row.description,
      owner: row.owner,
      payTo: row.operator,
      x402Support: row.x402_support === 1,
      active: row.active === 1,
      capabilities: (db.prepare('SELECT capability FROM agent_capability WHERE agent_uid = ? ORDER BY capability')
        .all(row.agent_uid) as unknown as { capability: string }[]).map((c) => c.capability),
      matchedOn: matchedOn(db, row.agent_uid, tokens),
      endpoints: toEndpoints(db, row.agent_uid),
      price,
      priceSource: row.price_source,
      turnstile: row.turnstile_name
        ? {
            ensName: row.turnstile_name,
            mcpEndpoint: row.turnstile_mcp_endpoint,
            rails: row.turnstile_rails ? row.turnstile_rails.split(',').map((r) => r.trim()) : [],
            priceCeiling: row.turnstile_price_ceiling,
            payoutAddr: row.turnstile_payout_addr,
            resolverVerified: row.turnstile_resolver_verified === 1,
          }
        : null,
      documentState: row.document_state,
      fetchStatus: row.fetch_status,
      rank: {
        basis: ranking.basis,
        score: ranking.basis === 'settled_volume' ? row.settled_volume : row.first_seen_timestamp,
        settledCount: row.settled_count,
        settledVolume: row.settled_volume,
      },
      worldVerification: row.world_verification,
      registeredAt: row.first_seen_timestamp,
      blockNumber: row.first_seen_block,
      transactionHash: row.transaction_hash,
    });
  }

  const offset = query.offset ?? 0;
  const limit = query.limit ?? 20;
  const page = kept.slice(offset, offset + limit);

  const chains = db.prepare(
    'SELECT network, chain_id AS chainId, COUNT(*) AS agents FROM agent GROUP BY network, chain_id ORDER BY agents DESC',
  ).all() as unknown as { network: string; chainId: number; agents: number }[];

  const documentStates: Record<string, number> = {};
  for (const r of db.prepare('SELECT document_state, COUNT(*) AS n FROM agent_current GROUP BY document_state')
    .all() as unknown as { document_state: string; n: number }[]) {
    documentStates[r.document_state] = r.n;
  }

  return {
    sellers: page,
    ranking,
    coverage: {
      chains,
      totalAgents: (db.prepare('SELECT COUNT(*) AS n FROM agent').get() as { n: number }).n,
      matchedBeforePriceFilter,
      droppedForUnknownPrice,
      droppedForPriceCeiling,
      documentStates,
    },
    priceSources,
    seams: {
      settledVolume:
        'MOV-220 — settled volume comes from HCS receipts. settlement_receipt is empty, so ranking ' +
        'falls back to registration recency and says so.',
      worldVerification:
        'MOV-223 — live since 2026-09-09. identity/ writes world_verification after World\'s ' +
        'Developer Portal verifies a proof. An agent with no row reports ' +
        "worldVerification: 'unknown', never 'unverified': absence of a proof is not evidence " +
        'of a failed one, and most of these 197 agents are not ours to verify.',
      livePricing:
        'A price for a non-Turnstile agent only exists in its HTTP 402 response. probe-x402.ts ' +
        'fetches one on demand; agents with x402Support and no quote report priceSource: ask_x402.',
    },
  };
}

/** Convenience for callers that do not manage the handle themselves. */
export function findSellersAt(dbPath: string = DEFAULT_DB_PATH, query: FindSellersQuery = {}): FindSellersResult {
  const db = openDb(dbPath);
  try {
    return findSellers(db, query);
  } finally {
    db.close();
  }
}
