// Where pool history comes from, and how it becomes `PoolFacts`.
//
// Two sources implement one interface:
//
//   `mcpSource()`   — the Subgraph MCP server. Addresses the decentralized
//                     network by subgraph id. This is what makes the analyst
//                     work against a subgraph nobody on this team deployed.
//   `httpSource()`  — a plain POST at a query URL. This is what makes it work
//                     against *our* subgraph.
//
// Both are needed, and the reason is a real constraint rather than
// belt-and-braces. **The Subgraph MCP server cannot see a Subgraph Studio
// deployment.** Every one of its tools addresses the decentralized network —
// subgraph id, deployment id, IPFS hash — and Turnstile's own
// `turnstile-uniswap-v-3-messari` is published to Studio, so it is invisible
// there. Asking for it by its exact IPFS hash returns
// `GraphQL error: subgraph not found` (verified 2026-09-07). Until the
// subgraph is published to the network, the analyst reads it over HTTP and
// reads everyone else's over MCP.
//
// The document below is the same GraphQL text either way. That is not an
// accident of implementation, it is the Messari schema paying off: the same
// field names answer on our subgraph, on Messari's Uniswap v3 Arbitrum
// deployment, and on Sushiswap V3's, so the analyst is written once and
// pointed anywhere.

import type { HourlyBucket, PoolFacts, TokenFacts } from './types.ts';
import { SubgraphMcpClient } from './subgraph-mcp.ts';

/** Our own deployment. Studio, not the network — see the note above. */
export const TURNSTILE_SUBGRAPH_URL =
  process.env.TURNSTILE_SUBGRAPH_URL
  ?? 'https://api.studio.thegraph.com/query/1758854/turnstile-uniswap-v-3-messari/v0.1.0';

/**
 * Messari-conformant deployments on the decentralized network, addressable by
 * the MCP client. Same schema, so the same document runs against them. These
 * are the ids already exercised by `graph/subgraph/queries/targets.txt`.
 */
export const NETWORK_SUBGRAPHS: Record<string, string> = {
  'uniswap-v3-arbitrum': 'FQ6JYszEKApsBpAmiHesRsd9Ygc6mzmpNRANeVQFYoVX',
  'sushiswap-v3-ethereum': '2tGWMrDha4164KkFAfkU3rDCtuxGb4q1emXmFdLLzJ8x',
};

/** One document, whichever transport carries it. */
export const POOL_FACTS_QUERY = `
query PoolFacts($pool: ID!, $poolRef: String!, $hours: Int!) {
  dexAmmProtocols(first: 1) { name network }
  liquidityPool(id: $pool) {
    id
    name
    createdTimestamp
    totalValueLockedUSD
    cumulativeVolumeUSD
    cumulativeSupplySideRevenueUSD
    tick
    positionCount
    openPositionCount
    inputTokens { id symbol decimals lastPriceUSD }
    inputTokenBalances
    inputTokenBalancesUSD
    fees { feeType feePercentage }
  }
  liquidityPoolHourlySnapshots(
    first: $hours
    orderBy: timestamp
    orderDirection: desc
    where: { pool: $poolRef }
  ) {
    hour
    timestamp
    hourlyVolumeUSD
    totalValueLockedUSD
    hourlySupplySideRevenueUSD
  }
  _meta { block { number timestamp } }
}
`;

/** Ranks pools by TVL. Deliberately naive — the analyst exists to second-guess it. */
export const TOP_POOLS_QUERY = `
query TopPools($first: Int!) {
  liquidityPools(first: $first, orderBy: totalValueLockedUSD, orderDirection: desc) {
    id
    name
    createdTimestamp
    totalValueLockedUSD
    cumulativeVolumeUSD
    inputTokens { symbol }
  }
  _meta { block { number timestamp } }
}
`;

export interface SubgraphSource {
  /** Human-readable name, printed in the verdict's provenance. */
  label: string;
  endpoint: string;
  transport: 'mcp' | 'http';
  query<T>(document: string, variables: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

export function httpSource(options: { url?: string; label?: string } = {}): SubgraphSource {
  const url = options.url ?? TURNSTILE_SUBGRAPH_URL;
  return {
    label: options.label ?? 'turnstile-uniswap-v3-messari (Studio)',
    endpoint: url,
    transport: 'http',
    async query<T>(document: string, variables: Record<string, unknown>): Promise<T> {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: document, variables }),
      });
      if (!response.ok) {
        throw new Error(`subgraph HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
      }
      const body = (await response.json()) as { data?: T; errors?: { message: string }[] };
      if (body.errors?.length) throw new Error(`subgraph: ${body.errors[0]!.message}`);
      if (body.data === undefined) throw new Error('subgraph: response carried no data');
      return body.data;
    },
    async close() {},
  };
}

export function mcpSource(options: {
  subgraphId: string;
  label?: string;
  client?: SubgraphMcpClient;
}): SubgraphSource {
  const client = options.client ?? new SubgraphMcpClient();
  const owned = options.client === undefined;
  return {
    label: options.label ?? `subgraph ${options.subgraphId} (via Subgraph MCP)`,
    endpoint: client.describe,
    transport: 'mcp',
    query<T>(document: string, variables: Record<string, unknown>): Promise<T> {
      return client.query<T>(options.subgraphId, document, variables);
    },
    async close() {
      if (owned) await client.close();
    },
  };
}

// --- Decoding --------------------------------------------------------------
//
// The subgraph answers in decimal strings with thirty significant digits and in
// raw integer token amounts. Everything below turns that into the plain
// `number`s the scorer reasons over, in one place, at the edge — the scorer
// never sees a string that has to be parsed, which is what lets it be a pure
// function of typed data.

interface RawPool {
  id: string;
  name: string | null;
  createdTimestamp: string;
  totalValueLockedUSD: string;
  cumulativeVolumeUSD: string;
  cumulativeSupplySideRevenueUSD: string;
  tick: string | null;
  positionCount: number;
  openPositionCount: number;
  inputTokens: { id: string; symbol: string; decimals: number; lastPriceUSD: string | null }[];
  inputTokenBalances: string[];
  inputTokenBalancesUSD: string[];
  fees: { feeType: string; feePercentage: string }[];
}

interface RawPoolFactsResponse {
  dexAmmProtocols: { name: string; network: string }[];
  liquidityPool: RawPool | null;
  liquidityPoolHourlySnapshots: {
    hour: number;
    timestamp: string;
    hourlyVolumeUSD: string;
    totalValueLockedUSD: string;
    hourlySupplySideRevenueUSD: string;
  }[];
  _meta: { block: { number: number; timestamp: number } };
}

export interface TopPool {
  address: string;
  name: string;
  totalValueLockedUSD: number;
  cumulativeVolumeUSD: number;
  symbols: string[];
}

function num(value: string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * `lastPriceUSD` is `0` for a token the subgraph could never anchor to a
 * stablecoin or to WETH. Zero and "unknown" are different claims and the scorer
 * treats them differently, so the distinction is made here rather than being
 * flattened into a plausible-looking zero.
 */
function priceOf(raw: string | null): number | null {
  if (raw === null) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed === 0) return null;
  return parsed;
}

function scaleTokenAmount(raw: string | undefined, decimals: number): number {
  if (!raw) return 0;
  // Reserves routinely exceed 2^53 in raw units, so divide as BigInt down to a
  // magnitude Number can hold before converting. A straight Number(raw) loses
  // precision silently on an 18-decimal balance.
  try {
    const value = BigInt(raw);
    const scale = 10n ** BigInt(Math.max(0, decimals));
    const whole = value / scale;
    const remainder = value % scale;
    return Number(whole) + Number(remainder) / Number(scale);
  } catch {
    return num(raw) / 10 ** decimals;
  }
}

function tradingFeePct(fees: { feeType: string; feePercentage: string }[]): number | null {
  const trading = fees.find((f) => f.feeType === 'FIXED_TRADING_FEE')
    ?? fees.find((f) => f.feeType === 'FIXED_LP_FEE');
  return trading ? num(trading.feePercentage) : null;
}

/**
 * The fee tier as Uniswap's uint24, which is what QuoterV2 wants.
 *
 * **Correction (2026-09-09, MOV-269):** this used to end
 * `[100, 500, 3_000, 10_000].includes(raw) ? raw : raw` — both arms the same
 * value, so the whitelist did nothing while reading as a filter. Found by
 * MOV-263's coverage pass.
 *
 * It is removed rather than made to reject, because rejecting would be wrong:
 * those four are v3's *initial* tiers, and governance can enable more. A pool
 * on an enabled tier is a real pool, and a quoter that refused to price it
 * would be the bug. Any tier passes through, which is what the code already
 * did — it just no longer pretends otherwise.
 */
export function feeTierToUint24(feePct: number | null): number | null {
  if (feePct === null) return null;
  return Math.round(feePct * 10_000);
}

export async function fetchPoolFacts(
  source: SubgraphSource,
  poolAddress: string,
  hours = 48,
): Promise<PoolFacts> {
  const address = poolAddress.toLowerCase();
  const data = await source.query<RawPoolFactsResponse>(POOL_FACTS_QUERY, {
    pool: address,
    poolRef: address,
    hours,
  });

  const raw = data.liquidityPool;
  if (!raw) throw new Error(`no LiquidityPool ${address} in ${source.label}`);

  const tokens: TokenFacts[] = raw.inputTokens.map((token, index) => {
    const balance = scaleTokenAmount(raw.inputTokenBalances[index], token.decimals);
    const priceUSD = priceOf(token.lastPriceUSD);
    const reportedUSD = raw.inputTokenBalancesUSD[index];
    return {
      address: token.id,
      symbol: token.symbol,
      decimals: token.decimals,
      priceUSD,
      balance,
      // Prefer the subgraph's own USD figure, which was computed at the block
      // the balance was written; fall back to balance x price only when it is
      // missing. Both are `null` when the token was never priced.
      balanceUSD: priceUSD === null
        ? null
        : reportedUSD !== undefined ? num(reportedUSD) : balance * priceUSD,
    };
  });

  const hourly: HourlyBucket[] = data.liquidityPoolHourlySnapshots.map((snapshot) => ({
    hour: snapshot.hour,
    timestamp: Number(snapshot.timestamp),
    volumeUSD: num(snapshot.hourlyVolumeUSD),
    totalValueLockedUSD: num(snapshot.totalValueLockedUSD),
    supplySideRevenueUSD: num(snapshot.hourlySupplySideRevenueUSD),
  }));

  const protocol = data.dexAmmProtocols[0];

  // A source that answers without `_meta` used to throw a bare TypeError
  // naming neither the pool nor the subgraph — the least useful possible
  // failure for the one field that says how stale this answer is. The type
  // declares `_meta` as present, so this cannot be expressed as a nullable
  // return without lying to every consumer; a named throw is the honest shape.
  // Found by MOV-263's coverage pass, fixed in MOV-269.
  if (!data._meta?.block) {
    throw new Error(
      `${source.label} answered for ${address} without _meta.block, so there is no way to say which block this reflects. ` +
        `A pool fact with no block is not usable as evidence.`,
    );
  }

  return {
    address: raw.id,
    name: raw.name ?? address,
    createdTimestamp: Number(raw.createdTimestamp),
    protocol: protocol?.name ?? 'unknown',
    network: protocol?.network ?? 'unknown',
    tokens,
    totalValueLockedUSD: num(raw.totalValueLockedUSD),
    cumulativeVolumeUSD: num(raw.cumulativeVolumeUSD),
    cumulativeSupplySideRevenueUSD: num(raw.cumulativeSupplySideRevenueUSD),
    feeTierPct: tradingFeePct(raw.fees),
    positionCount: raw.positionCount,
    openPositionCount: raw.openPositionCount,
    tick: raw.tick === null ? null : Number(raw.tick),
    hourly,
    source: {
      label: source.label,
      endpoint: source.endpoint,
      transport: source.transport,
      blockNumber: data._meta.block.number,
      blockTimestamp: data._meta.block.timestamp,
    },
  };
}

export async function fetchTopPoolsByTvl(
  source: SubgraphSource,
  first = 10,
): Promise<TopPool[]> {
  const data = await source.query<{
    liquidityPools: {
      id: string;
      name: string | null;
      totalValueLockedUSD: string;
      cumulativeVolumeUSD: string;
      inputTokens: { symbol: string }[];
    }[];
  }>(TOP_POOLS_QUERY, { first });

  return data.liquidityPools.map((pool) => ({
    address: pool.id,
    name: pool.name ?? pool.id,
    totalValueLockedUSD: num(pool.totalValueLockedUSD),
    cumulativeVolumeUSD: num(pool.cumulativeVolumeUSD),
    symbols: pool.inputTokens.map((t) => t.symbol),
  }));
}
