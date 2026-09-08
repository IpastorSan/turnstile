// Messari DEX AMM (Extended) queries.
//
// The point of this file is that it contains no Uniswap-specific field names.
// It speaks the Messari DEX AMM Extended schema, which several teams implement
// across several AMMs on several chains, so the same document answers against
// Uniswap v3, Sushiswap v2 and v3, and Curve without an adapter per protocol.
// That is what makes it worth putting in a *Uniswap* MCP server: the value is
// being able to ask a Uniswap question and the same question of everything
// Uniswap competes with, and get answers that are comparable rather than merely
// similar.
//
// Two hazards are handled here rather than left to the caller, because both
// produce confident wrong answers:
//
//   1. **Staleness.** A subgraph is behind the chain by an amount that varies
//      from seconds to weeks. Every response therefore carries `_meta` and this
//      module converts it into an explicit lag, because "TVL is $103M" and "TVL
//      was $103M twelve days ago" are different claims.
//   2. **Sparse snapshots.** A `*HourlySnapshot` row exists only for an hour in
//      which something happened. `first: 24` returns the last 24 rows, which is
//      not the last 24 hours, and any rate computed by dividing by the row
//      count is wrong for a quiet pool. Flagged in `describeStaleness`.

export const DEFAULT_SUBGRAPH_URL =
  'https://api.studio.thegraph.com/query/1758854/turnstile-uniswap-v-3-messari/v0.1.0';

export interface SubgraphResponse {
  url: string;
  data: unknown;
  errors?: Array<{ message: string }>;
  meta: { block: number; timestamp: number } | null;
  hasIndexingErrors: boolean | null;
  lagSeconds: number | null;
  notes: string[];
}

export class SubgraphRequestFailed extends Error {
  constructor(url: string, status: number, body: string) {
    super(`subgraph ${new URL(url).host} answered HTTP ${status}: ${body.slice(0, 300)}`);
    this.name = 'SubgraphRequestFailed';
  }
}

/**
 * `_meta` is appended to the caller's document rather than fetched separately,
 * so the freshness reported is the freshness *of that response* rather than of
 * a second request that may have landed on a different block.
 *
 * Skipped when the document already selects `_meta` (duplicate top-level fields
 * are legal in GraphQL but merge, and re-declaring the sub-selection differently
 * is a validation error), and when the document is a mutation or subscription,
 * which have no `_meta`.
 */
export function withMeta(document: string): { document: string; injected: boolean } {
  const trimmed = document.trim();
  if (/\b_meta\b/.test(trimmed)) return { document: trimmed, injected: false };
  if (/^\s*(mutation|subscription)\b/.test(trimmed)) return { document: trimmed, injected: false };

  const open = trimmed.indexOf('{');
  const close = trimmed.lastIndexOf('}');
  if (open < 0 || close <= open) return { document: trimmed, injected: false };
  const injected =
    `${trimmed.slice(0, close)}\n  _meta { block { number timestamp } hasIndexingErrors }\n}`;
  return { document: injected, injected: true };
}

export interface QuerySubgraphOptions {
  url?: string;
  variables?: Record<string, unknown>;
  apiKey?: string;
  timeoutMs?: number;
  /** Unix seconds; injected by tests so lag is deterministic. */
  now?: number;
}

export async function querySubgraph(
  document: string,
  options: QuerySubgraphOptions = {},
): Promise<SubgraphResponse> {
  const url = options.url ?? process.env.AMM_SUBGRAPH_URL ?? DEFAULT_SUBGRAPH_URL;
  const { document: sent, injected } = withMeta(document);

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const apiKey = options.apiKey ?? process.env.GRAPH_GATEWAY_API_KEY;
  // A Studio endpoint carries its key in the path and needs no header; a
  // decentralized-gateway URL does. Sending it either way is harmless.
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query: sent, variables: options.variables ?? {} }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  if (!response.ok) throw new SubgraphRequestFailed(url, response.status, text);

  let body: { data?: Record<string, unknown>; errors?: Array<{ message: string }> };
  try {
    body = JSON.parse(text);
  } catch {
    throw new SubgraphRequestFailed(url, response.status, `response was not JSON: ${text}`);
  }

  const meta = extractMeta(body.data);
  const data = body.data ? stripInjectedMeta(body.data, injected) : null;
  const lagSeconds = meta ? (options.now ?? Math.floor(Date.now() / 1000)) - meta.timestamp : null;

  return {
    url,
    data,
    errors: body.errors,
    meta: meta ? { block: meta.block, timestamp: meta.timestamp } : null,
    hasIndexingErrors: meta?.hasIndexingErrors ?? null,
    lagSeconds,
    notes: describeStaleness(lagSeconds, meta?.hasIndexingErrors ?? null, body.errors),
  };
}

function extractMeta(
  data: Record<string, unknown> | undefined,
): { block: number; timestamp: number; hasIndexingErrors: boolean | null } | null {
  const raw = data?._meta as
    | { block?: { number?: number; timestamp?: number }; hasIndexingErrors?: boolean }
    | undefined;
  if (!raw?.block?.number) return null;
  return {
    block: Number(raw.block.number),
    timestamp: Number(raw.block.timestamp ?? 0),
    hasIndexingErrors: raw.hasIndexingErrors ?? null,
  };
}

function stripInjectedMeta(data: Record<string, unknown>, injected: boolean): Record<string, unknown> {
  if (!injected) return data;
  const { _meta, ...rest } = data;
  void _meta;
  return rest;
}

export function describeStaleness(
  lagSeconds: number | null,
  hasIndexingErrors: boolean | null,
  errors?: Array<{ message: string }>,
): string[] {
  const notes: string[] = [];
  if (errors?.length) {
    notes.push(
      `The subgraph returned ${errors.length} GraphQL error(s). A field-level error here usually `
      + 'means a schema-version boundary rather than a broken endpoint — the base DEX AMM schema '
      + 'has no `tick`, `positions` or `activeLiquidity`, so an Extended-only query fails cleanly '
      + 'against a 1.3.x subgraph. Check `schemaVersion` on dexAmmProtocols.',
    );
  }
  if (hasIndexingErrors) {
    notes.push('hasIndexingErrors is true: some handlers failed, so entity data may be incomplete.');
  }
  if (lagSeconds === null) {
    notes.push('No `_meta` in the response, so the freshness of this data is unknown. Do not date it.');
    return notes;
  }
  const hours = lagSeconds / 3600;
  if (hours > 24) {
    notes.push(
      `This subgraph is ${(hours / 24).toFixed(1)} days behind the chain. Every figure below is `
      + 'that old. It is not wrong, it is historical — do not present it as current state, and do '
      + 'not compare it against a live quote without saying so.',
    );
  } else if (hours > 1) {
    notes.push(`This subgraph is ${hours.toFixed(1)} hours behind the chain.`);
  }
  notes.push(
    'Snapshot series are sparse: a *HourlySnapshot row exists only for an hour in which an event '
    + 'occurred, so `first: 24` is the last 24 rows, not the last 24 hours. Window by the `hour` '
    + 'field, and never divide by the row count to get a rate.',
  );
  return notes;
}

/** Canned documents, so a caller who has never seen the schema can start. */
export const CANNED_QUERIES: Record<string, { description: string; document: string }> = {
  protocol_vitals: {
    description:
      'Protocol-level totals plus the deepest pools and latest swaps. Runs unchanged against any '
      + 'Messari DEX AMM subgraph, which is what makes cross-protocol comparison arithmetic '
      + 'rather than archaeology.',
    document: `query AmmVitals {
  dexAmmProtocols(first: 1) {
    name
    slug
    schemaVersion
    network
    totalValueLockedUSD
    cumulativeVolumeUSD
    cumulativeSupplySideRevenueUSD
    cumulativeUniqueUsers
    totalPoolCount
  }
  liquidityPools(first: 5, orderBy: totalValueLockedUSD, orderDirection: desc) {
    name
    inputTokens { symbol }
    totalValueLockedUSD
    cumulativeVolumeUSD
    fees { feeType feePercentage }
  }
}`,
  },
  concentrated_liquidity: {
    description:
      'Extended-only entities: ticks, positions, active liquidity. Fails cleanly with '
      + '"Type LiquidityPool has no field tick" against a base (1.3.x) DEX AMM subgraph, which is '
      + 'a precise schema-version boundary rather than a mystery.',
    document: `query ConcentratedLiquidity {
  liquidityPools(first: 1, orderBy: cumulativeVolumeUSD, orderDirection: desc) {
    name
    tick
    activeLiquidity
    positionCount
    openPositionCount
    positions(first: 3, orderBy: liquidityUSD, orderDirection: desc) {
      liquidity
      liquidityUSD
      tickLower { index prices }
      tickUpper { index prices }
    }
  }
}`,
  },
  pool_history: {
    description:
      'Daily snapshots for one pool. Remember the series is sparse — window by `day`, do not '
      + 'assume one row per day.',
    document: `query PoolHistory($pool: String!, $first: Int = 30) {
  liquidityPoolDailySnapshots(
    where: { pool: $pool }
    first: $first
    orderBy: timestamp
    orderDirection: desc
  ) {
    day
    timestamp
    totalValueLockedUSD
    dailyVolumeUSD
    dailySupplySideRevenueUSD
    cumulativeVolumeUSD
  }
}`,
  },
};
