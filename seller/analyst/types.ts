// The data contract between the three halves of the analyst.
//
// `scoring.ts` imports this file and nothing else. That is deliberate: MOV-227
// lifts the scorer into a Chainlink TEE enclave, where there is no network, no
// clock and no filesystem, so every fact it reasons over has to arrive as an
// argument. Keeping the shapes here rather than in the fetchers is what makes
// that a move rather than a rewrite.
//
// Consequences worth stating, because they are easy to erode by accident:
//   - Every number is already a `number`, decoded at the edge. The subgraph
//     returns 30-significant-digit decimal strings and the quoter returns
//     `bigint` wei; neither reaches the scorer.
//   - Nothing here is optional-because-we-were-lazy. A `null` means "we asked
//     and could not get it", and the scorer is expected to say so out loud
//     rather than substitute a default.
//   - `now` is an input. The scorer never reads a clock.

/** One side of a pool, as the subgraph reports it. */
export interface TokenFacts {
  address: string;
  symbol: string;
  decimals: number;
  /** Subgraph-derived USD price. `null` when the subgraph could not anchor it. */
  priceUSD: number | null;
  /** Pool reserve in whole tokens (already decimal-adjusted). */
  balance: number;
  /** `balance * priceUSD`, or `null` when the price is not knowable. */
  balanceUSD: number | null;
}

/**
 * One closed interval from a `LiquidityPoolHourlySnapshot`.
 *
 * These are **sparse**. The Messari handlers write a snapshot when an event
 * arrives in a new hour, so an hour with no activity produces no row at all —
 * it is not a row of zeroes. Counting non-empty rows therefore always returns
 * 100%, which is why `hour` is carried here: activity has to be measured
 * against elapsed hours, not against the number of rows returned.
 */
export interface HourlyBucket {
  /** `floor(unixSeconds / 3600)`, straight from the schema. The interval's identity. */
  hour: number;
  /** Unix seconds of the block that closed the interval. Not an hour boundary. */
  timestamp: number;
  volumeUSD: number;
  totalValueLockedUSD: number;
  supplySideRevenueUSD: number;
}

/** Everything the scorer knows about a pool's history. Sourced from a subgraph. */
export interface PoolFacts {
  address: string;
  name: string;
  protocol: string;
  network: string;
  tokens: TokenFacts[];
  /** Unix seconds the pool was created on chain. The honest floor for "how long has this existed". */
  createdTimestamp: number;
  totalValueLockedUSD: number;
  cumulativeVolumeUSD: number;
  cumulativeSupplySideRevenueUSD: number;
  /** The LP-facing trading fee, as a percentage — 0.05 means 0.05%. */
  feeTierPct: number | null;
  /** Positions ever opened, and those still open. */
  positionCount: number;
  openPositionCount: number;
  /** Current tick. `null` on a non-concentrated AMM or an uninitialized pool. */
  tick: number | null;
  /** Most recent first. May be empty — a freshly indexed pool has no closed interval. */
  hourly: HourlyBucket[];
  /** Where the history came from, so a verdict can name its source. */
  source: {
    label: string;
    endpoint: string;
    /** 'mcp' when it came through the Subgraph MCP server, 'http' when queried directly. */
    transport: 'mcp' | 'http';
    blockNumber: number;
    /** Unix seconds of the subgraph's head block — NOT of the query. */
    blockTimestamp: number;
  };
}

/** One rung of the depth ladder: what a trade of this size actually gets. */
export interface DepthRung {
  /** The notional this rung was sized at, in USD. */
  notionalUSD: number;
  /** Input in whole tokens. */
  amountIn: number;
  /** Output in whole tokens. `null` when the quote reverted. */
  amountOut: number | null;
  /** `amountOut / amountIn`. `null` when the quote reverted. */
  executedRate: number | null;
  /** Initialized ticks the swap crossed. `null` when the provider does not report it. */
  ticksCrossed: number | null;
  /** Present only on a failed rung — the revert or API error, verbatim. */
  error?: string;
}

/** Live depth-at-size, from Uniswap. */
export interface DepthProfile {
  provider: 'quoter-v2' | 'trading-api';
  /** Human-readable provenance, e.g. the QuoterV2 address and the RPC host. */
  providerDetail: string;
  tokenInSymbol: string;
  tokenOutSymbol: string;
  /** Chain head at quote time — the number that makes this "live". */
  atBlock: number;
  /** Unix seconds when the quotes were taken. */
  quotedAt: number;
  /** Ascending by notional. */
  rungs: DepthRung[];
  /** How the USD notionals were converted into token amounts. */
  notionalPricing: {
    tokenSymbol: string;
    priceUSD: number;
    /** Where that price came from — the scorer downgrades confidence on a self-referential one. */
    priceSource: 'subgraph-lastPriceUSD' | 'caller-supplied';
  };
}

/** The complete argument to `assess()`. Serializable; nothing in it is a handle. */
export interface AnalystInput {
  pool: PoolFacts;
  /** `null` when live depth could not be obtained. The verdict must then say so. */
  depth: DepthProfile | null;
  /** Unix seconds. Supplied, never read from a clock, so the scorer stays deterministic. */
  now: number;
}

export type SignalVerdict = 'pass' | 'warn' | 'fail' | 'unknown';

/** One reasoned observation. The evidence is what makes the verdict auditable. */
export interface Signal {
  id: string;
  /** Short name of what was tested. */
  label: string;
  verdict: SignalVerdict;
  /**
   * A structural signal describes whether the pool is a *venue* at all. One
   * failing structural signal is enough to say AVOID; a non-structural one is
   * a reason to be careful, not to walk away.
   */
  structural: boolean;
  /** One sentence, stating the conclusion and the number it rests on. */
  headline: string;
  /** The numbers the headline is derived from, labelled. Printed under the verdict. */
  evidence: Record<string, string>;
  /** Why that evidence implies that verdict, for an LP specifically. */
  reasoning: string;
}

export type Rating = 'ACCEPTABLE' | 'CAUTION' | 'AVOID' | 'INSUFFICIENT_DATA';

export interface Verdict {
  pool: string;
  poolAddress: string;
  rating: Rating;
  /** 0..1. How much of the evidence the analyst wanted was actually available. */
  confidence: number;
  /** The one-paragraph answer to "is this pool safe to LP?". */
  summary: string;
  signals: Signal[];
  /** Facts a reader needs to judge whether the verdict has aged. */
  provenance: {
    subgraph: string;
    subgraphTransport: 'mcp' | 'http';
    subgraphBlock: number;
    /** Seconds between the subgraph head and `now`. */
    subgraphLagSeconds: number;
    depthProvider: string | null;
    depthBlock: number | null;
    assessedAt: number;
  };
  /** Everything the analyst wanted and did not get. Never silently empty. */
  caveats: string[];
}
