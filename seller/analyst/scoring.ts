// The scorer. Pure, deterministic, and the only place a judgement is made.
//
// `assess(input)` is a total function of its argument: no network, no clock, no
// filesystem, no randomness, no module state. It imports types and nothing
// else. MOV-227 moves this file into a Chainlink TEE enclave, where an attested
// verdict is only worth something if the same input provably yields the same
// output — so keep it that way. If you find yourself wanting `Date.now()` here,
// add a field to `AnalystInput` instead.
//
// It answers one question: **is this pool safe to LP?** That is not "is TVL
// large". An LP is not a trader; they are short volatility and long fees, and
// they are exposed to the pool's *inventory*, not to its headline number. So
// the tests below are the ones that decide whether an LP loses money:
//
//   1. inventory-balance   Is the pool actually two-sided, or is it a pile of
//                          one token? A one-sided pool means every arriving
//                          trade hands you more of the side that is falling.
//   2. executable-depth    Does a trade of real size actually execute? TVL is
//                          an accounting figure; depth is a fact you can only
//                          learn by asking the pool.
//   3. depth-vs-tvl        The gap between the two. A pool claiming $3B that
//                          cannot absorb $1k is not a $3B pool.
//   4. slippage-curve      Where the liquidity runs out. Concentrated liquidity
//                          is superlinear by construction; a cliff at small
//                          size means the active range is thin.
//   5. fee-return          What the LP is actually paid for the risk, annualized
//                          from realized supply-side revenue.
//   6. activity-continuity Is the volume continuous, or one burst and silence?
//   7. lp-concentration    How many LPs. A single open position is one person's
//                          inventory, not a market.
//
// Freshness does not fail a pool. It lowers confidence and gets said out loud,
// because "the data is 13 days old" is a different problem from "the pool is
// bad" and conflating them produces a verdict nobody can act on.

import type {
  AnalystInput,
  DepthProfile,
  DepthRung,
  HourlyBucket,
  PoolFacts,
  Rating,
  Signal,
  Verdict,
} from './types.ts';

// --- Thresholds ------------------------------------------------------------
//
// Named, in one block, because a magic number buried in a branch is a rule
// nobody can review. Every one of these is a judgement call, so each says what
// it is defending against rather than just what it is.

export const THRESHOLDS = {
  /** Below this share on the thin side, the pool is inventory rather than a market. */
  oneSidedFailShare: 0.01,
  /** Below this, it is lopsided enough that an LP is taking a directional bet. */
  oneSidedWarnShare: 0.1,

  /** A pool that cannot fill this without reverting is not a venue. */
  minimumViableNotionalUSD: 1_000,
  /** Slippage above this on a $10k trade means retail-size flow is already expensive. */
  retailSlippageWarn: 0.01,
  retailSlippageFail: 0.05,
  /** The notional whose slippage defines "usable depth". */
  usableDepthSlippageCeiling: 0.01,

  /** Usable depth below this share of claimed TVL means TVL is not describing the pool. */
  depthToTvlFailShare: 0.001,
  depthToTvlWarnShare: 0.01,

  /**
   * Slippage should roughly scale with size. Crossing a 10x rung should not
   * cost more than this multiple of the previous rung's slippage; beyond it,
   * the ladder has walked off the edge of the active range.
   */
  slippageCliffMultiple: 25,

  /** Annualized fee return an LP is being paid, on TVL. */
  feeApyWarnLow: 0.01,
  /** Absurdly high realized yield is usually one wash trade, not an opportunity. */
  feeApyWarnHigh: 5.0,

  /** Hours of history the analyst wants before it will call activity continuous. */
  activityWindowHours: 24,
  /** Below this share of hours carrying volume, the pool trades in bursts. */
  activeHourWarnShare: 0.5,
  /**
   * At or below this, it is not a market. Set at a fifth rather than a tenth
   * after the real TRUMP/WETH pool — three traded hours out of twenty-four,
   * $1.54 of volume between them — came back as merely "bursty" at 0.1. A pool
   * that is silent for five hours out of every six is not one an LP should be
   * parked in, whatever the remaining hour looks like.
   */
  activeHourFailShare: 0.2,

  /** Open positions. One LP is one person's inventory. */
  lpCountFail: 1,
  lpCountWarn: 3,

  /** Subgraph lag past which history stops describing the present. */
  lagWarnSeconds: 6 * 3600,
  lagStaleSeconds: 48 * 3600,
} as const;

// --- Small helpers ---------------------------------------------------------

const SECONDS_PER_YEAR = 365 * 24 * 3600;

function usd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'unknown';
  const abs = Math.abs(value);
  if (abs >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(value / 1e3).toFixed(1)}k`;
  if (abs >= 1) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(6)}`;
}

function pct(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return 'unknown';
  return `${(value * 100).toFixed(digits)}%`;
}

function duration(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 5400) return `${(seconds / 60).toFixed(0)}m`;
  if (seconds < 172_800) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86_400).toFixed(1)}d`;
}

/**
 * Slippage of a rung against the shallowest successful rung, which stands in
 * for the marginal (spot) rate. Using the ladder's own smallest fill rather
 * than an external oracle keeps the whole measurement inside one atomic view
 * of the pool — an oracle price taken from somewhere else at some other block
 * would put a spread we did not measure into a number we are calling slippage.
 */
function slippageOf(rung: DepthRung, referenceRate: number | null): number | null {
  if (rung.executedRate === null || referenceRate === null || referenceRate === 0) return null;
  return 1 - rung.executedRate / referenceRate;
}

function referenceRate(depth: DepthProfile): number | null {
  for (const rung of depth.rungs) {
    if (rung.executedRate !== null && rung.executedRate > 0) return rung.executedRate;
  }
  return null;
}

/** The largest notional that fills within the slippage ceiling. */
function usableDepthUSD(depth: DepthProfile): number | null {
  const reference = referenceRate(depth);
  if (reference === null) return null;
  let best: number | null = null;
  for (const rung of depth.rungs) {
    const slip = slippageOf(rung, reference);
    if (slip === null) continue;
    if (slip <= THRESHOLDS.usableDepthSlippageCeiling) best = rung.notionalUSD;
  }
  return best;
}

function rungAtOrAbove(depth: DepthProfile, notionalUSD: number): DepthRung | null {
  for (const rung of depth.rungs) if (rung.notionalUSD >= notionalUSD) return rung;
  return null;
}

function ticksPhrase(ticks: number | null): string {
  if (ticks === null) return '';
  return `, ${ticks} initialized tick${ticks === 1 ? '' : 's'} crossed`;
}

interface HistoryWindow {
  buckets: HourlyBucket[];
  /** Hours of wall-clock the window covers, whether or not each one has a row. */
  elapsedHours: number;
  /** Hours that actually carried trading activity. */
  activeHours: number;
}

/**
 * The last N hours of history, measured in *hours*, not in rows.
 *
 * This distinction is the whole reason the function exists. Hourly snapshots
 * are sparse — a handler writes one when an event lands in a new hour, so a
 * silent hour leaves no row rather than a row of zeroes. Slicing the first 24
 * rows and calling that "24 hours" therefore silently rescales a dead pool into
 * a busy one: three trades spread over a day come back as "3 of 3 hours
 * traded, 100%". Found by running the analyst against Uniswap v3 TRUMP/WETH
 * 0.3%, which has exactly three snapshots spanning 25 hours.
 *
 * The window is anchored to the *subgraph head*, not to `now`, because the
 * subgraph cannot have written a snapshot for an hour it has not indexed. Using
 * `now` on a lagging subgraph would score every pool as dead.
 */
function historyWindow(pool: PoolFacts, hours: number): HistoryWindow {
  const headHour = Math.floor(pool.source.blockTimestamp / 3600);
  const firstHour = headHour - hours + 1;
  const buckets = pool.hourly.filter((b) => b.hour >= firstHour && b.hour <= headHour);

  // The denominator is elapsed time, computed without reference to how many
  // rows landed in it — an empty window is still 24 hours of nothing happening,
  // and reporting it as a 0-hour or 1-hour window would hide exactly the fact
  // that matters. It shrinks only for a pool younger than the window, because a
  // pool cannot be idle before it exists.
  //
  // `createdTimestamp` is the right floor and the oldest snapshot is not: with
  // sparse snapshots, the earliest one marks the pool's first *trade*, not its
  // creation. Using it would let a pool that has been silent for a month claim
  // its window began the last time somebody touched it.
  const createdHour = Math.floor(pool.createdTimestamp / 3600);
  const start = Math.max(firstHour, Math.min(createdHour, headHour));
  return {
    buckets,
    elapsedHours: Math.max(1, headHour - start + 1),
    activeHours: buckets.filter((b) => b.volumeUSD > 0).length,
  };
}

// --- Signals ---------------------------------------------------------------
//
// Each returns exactly one Signal. They do not know about each other and they
// do not know the final rating; composing them is `assess`'s job.

function inventoryBalance(pool: PoolFacts): Signal {
  const priced = pool.tokens.filter((t) => t.balanceUSD !== null);
  const evidence: Record<string, string> = {
    'claimed TVL': usd(pool.totalValueLockedUSD),
  };
  // Keyed by address, not by symbol. Two sides can carry the *same* symbol —
  // the top pool by TVL on our own subgraph is a fake 18-decimal "USDT" at
  // 0x83cf…e169 paired with the real 6-decimal one, and keying by symbol both
  // collapsed the two rows into one and hid the only fact that identifies the
  // impersonation.
  for (const token of pool.tokens) {
    const short = `${token.address.slice(0, 6)}…${token.address.slice(-4)}`;
    evidence[`${token.symbol} side (${short})`] =
      `${token.balance.toLocaleString('en-US', { maximumFractionDigits: 4 })} ${token.symbol}` +
      `, ${token.decimals} decimals` +
      ` (${usd(token.balanceUSD)}${token.priceUSD === null ? ', unpriced' : ''})`;
  }

  if (priced.length < 2) {
    return {
      id: 'inventory-balance',
      label: 'Inventory balance',
      verdict: 'unknown',
      structural: true,
      headline: 'Cannot check two-sidedness: the subgraph could not price every side of this pool.',
      evidence,
      reasoning:
        'Balance is a USD comparison between the sides. With a side unpriced there is no ' +
        'comparison to make, and guessing one would be the same as inventing the answer.',
    };
  }

  const total = priced.reduce((sum, t) => sum + (t.balanceUSD ?? 0), 0);
  const thin = priced.reduce(
    (min, t) => ((t.balanceUSD ?? 0) < (min.balanceUSD ?? 0) ? t : min),
    priced[0]!,
  );
  const share = total > 0 ? (thin.balanceUSD ?? 0) / total : 0;
  evidence['thin side share'] = pct(share, 6);

  if (share < THRESHOLDS.oneSidedFailShare) {
    return {
      id: 'inventory-balance',
      label: 'Inventory balance',
      verdict: 'fail',
      structural: true,
      headline:
        `The pool is effectively one-sided: ${thin.symbol} is ${pct(share, 6)} of the reserves ` +
        `(${usd(thin.balanceUSD)} against ${usd(total)} claimed).`,
      evidence,
      reasoning:
        `Providing liquidity here means depositing against a reserve that is almost entirely ` +
        `${pool.tokens.find((t) => t.symbol !== thin.symbol)?.symbol ?? 'one token'}. Every trade ` +
        `that arrives buys the scarce side out and pays you in the abundant one, so the position ` +
        `converges to holding the token nobody wants. The headline TVL is arithmetically correct ` +
        `and economically meaningless — it is one token's balance multiplied by a price that this ` +
        `same imbalanced pool is what sets.`,
    };
  }

  if (share < THRESHOLDS.oneSidedWarnShare) {
    return {
      id: 'inventory-balance',
      label: 'Inventory balance',
      verdict: 'warn',
      structural: true,
      headline: `Reserves are lopsided: the ${thin.symbol} side is ${pct(share)} of the pool.`,
      evidence,
      reasoning:
        'A concentrated-liquidity pool drifts one-sided as price leaves the active range, so this ' +
        'is not automatically wrong — but it does mean an LP entering now is taking a directional ' +
        'position rather than a neutral fee-earning one.',
    };
  }

  return {
    id: 'inventory-balance',
    label: 'Inventory balance',
    verdict: 'pass',
    structural: true,
    headline: `Both sides are real: the thinner side holds ${pct(share)} of the reserves.`,
    evidence,
    reasoning:
      'A genuinely two-sided reserve means arriving flow trades in both directions, which is the ' +
      'precondition for earning fees rather than accumulating one token.',
  };
}

function executableDepth(depth: DepthProfile | null): Signal {
  const base = { id: 'executable-depth', label: 'Executable depth', structural: true } as const;

  if (depth === null) {
    return {
      ...base,
      verdict: 'unknown',
      headline: 'No live quote was obtained, so nothing here has been priced against the real pool.',
      evidence: {},
      reasoning:
        'Every other signal in this report is derived from indexed history. Depth is the only one ' +
        'that asks the pool a question at the current block, and without it a verdict rests ' +
        'entirely on what the pool used to be.',
    };
  }

  const reference = referenceRate(depth);
  const evidence: Record<string, string> = {
    provider: `${depth.provider} (${depth.providerDetail})`,
    'quoted at block': String(depth.atBlock),
    direction: `${depth.tokenInSymbol} -> ${depth.tokenOutSymbol}`,
    'notional priced with': `${depth.notionalPricing.tokenSymbol} at ` +
      `${usd(depth.notionalPricing.priceUSD)} (${depth.notionalPricing.priceSource})`,
  };
  for (const rung of depth.rungs) {
    const slip = slippageOf(rung, reference);
    evidence[usd(rung.notionalUSD)] =
      rung.amountOut === null
        ? `did not execute — ${rung.error ?? 'no reason given'}`
        : `${rung.amountOut.toLocaleString('en-US', { maximumFractionDigits: 6 })} ` +
          `${depth.tokenOutSymbol}, slippage ${pct(slip, 3)}` + ticksPhrase(rung.ticksCrossed);
  }

  const smallest = rungAtOrAbove(depth, THRESHOLDS.minimumViableNotionalUSD);
  if (reference === null || (smallest !== null && smallest.amountOut === null)) {
    return {
      ...base,
      verdict: 'fail',
      headline:
        `The pool cannot fill a ${usd(THRESHOLDS.minimumViableNotionalUSD)} trade — the quote ` +
        `reverted at the smallest size asked for.`,
      evidence,
      reasoning:
        'A pool that reverts on a retail-sized swap has no liquidity in its active range. Whatever ' +
        'the indexer reports as locked value is not reachable by a trade, and fees are only ' +
        'earned by trades.',
    };
  }

  const retail = rungAtOrAbove(depth, 10_000);
  const retailSlip = retail ? slippageOf(retail, reference) : null;
  const usable = usableDepthUSD(depth);
  evidence['usable depth (<=1% slippage)'] = usable === null ? 'none' : usd(usable);

  if (retailSlip !== null && retailSlip > THRESHOLDS.retailSlippageFail) {
    return {
      ...base,
      verdict: 'fail',
      headline: `A ${usd(retail!.notionalUSD)} trade costs ${pct(retailSlip)} in slippage.`,
      evidence,
      reasoning:
        'At that cost, informed flow routes elsewhere and what is left is mostly adverse — the ' +
        'trades that do arrive are the ones that only make sense against a mispriced pool. That ' +
        'is the flow an LP loses to.',
    };
  }

  if (retailSlip !== null && retailSlip > THRESHOLDS.retailSlippageWarn) {
    return {
      ...base,
      verdict: 'warn',
      headline: `Retail size is already expensive: ${usd(retail!.notionalUSD)} costs ${pct(retailSlip)}.`,
      evidence,
      reasoning:
        'The pool executes, but not competitively. Routers will prefer a deeper venue for anything ' +
        'above small size, which caps the fee flow an LP can expect regardless of how much capital ' +
        'is sitting in the pool.',
    };
  }

  return {
    ...base,
    verdict: 'pass',
    headline:
      `Real trades execute: ${usable === null ? 'small size fills' : usd(usable) + ' fills within 1% slippage'}` +
      (retailSlip === null ? '' : `, and ${usd(retail!.notionalUSD)} costs ${pct(retailSlip, 3)}`) +
      '.',
    evidence,
    reasoning:
      'This is the only measurement here taken against the live pool rather than against indexed ' +
      'history, and it is the one an LP is actually exposed to: it is the flow this pool can win.',
  };
}

function depthVersusTvl(pool: PoolFacts, depth: DepthProfile | null): Signal {
  const base = { id: 'depth-vs-tvl', label: 'Depth against claimed TVL', structural: true } as const;
  const usable = depth ? usableDepthUSD(depth) : null;

  if (depth === null) {
    return {
      ...base,
      verdict: 'unknown',
      headline: 'TVL could not be checked against reality without a live quote.',
      evidence: { 'claimed TVL': usd(pool.totalValueLockedUSD) },
      reasoning:
        'TVL is what an indexer computed from reserves and a derived price. Whether any of it is ' +
        'reachable by a trade is a separate question, and only a quote answers it.',
    };
  }

  const share = usable !== null && pool.totalValueLockedUSD > 0
    ? usable / pool.totalValueLockedUSD
    : null;
  const evidence: Record<string, string> = {
    'claimed TVL': usd(pool.totalValueLockedUSD),
    'usable depth at <=1% slippage': usable === null ? 'none' : usd(usable),
    'usable / claimed': pct(share, 4),
  };

  if (usable === null || (share !== null && share < THRESHOLDS.depthToTvlFailShare)) {
    return {
      ...base,
      verdict: 'fail',
      headline:
        `Claimed TVL of ${usd(pool.totalValueLockedUSD)} does not survive contact with a quote: ` +
        `${usable === null ? 'nothing' : usd(usable)} is reachable within 1% slippage.`,
      evidence,
      reasoning:
        'The gap is the finding. A ranking by TVL puts this pool near the top and a ranking by ' +
        'what a trade can actually do puts it nowhere, which is exactly the trap this analyst ' +
        'exists to catch. TVL is derived from a price; depth is derived from the pool.',
    };
  }

  if (share !== null && share < THRESHOLDS.depthToTvlWarnShare) {
    return {
      ...base,
      verdict: 'warn',
      headline: `Only ${pct(share, 3)} of claimed TVL is reachable within 1% slippage.`,
      evidence,
      reasoning:
        'In concentrated liquidity most capital sits outside the active range by design, so a small ' +
        'ratio is normal — but it does mean the headline number overstates the fee-earning capital ' +
        'by two orders of magnitude, and an LP sizing a position off TVL will be disappointed.',
    };
  }

  return {
    ...base,
    verdict: 'pass',
    headline: `Claimed TVL and executable depth agree to within a plausible ratio (${pct(share, 3)}).`,
    evidence,
    reasoning:
      'The indexed number and the live pool are describing the same object, which is the baseline ' +
      'assumption every other historical signal here depends on.',
  };
}

function slippageCurve(depth: DepthProfile | null): Signal {
  const base = { id: 'slippage-curve', label: 'Slippage curve', structural: false } as const;
  if (depth === null || depth.rungs.length < 3) {
    return {
      ...base,
      verdict: 'unknown',
      headline: 'Not enough rungs quoted to see where the liquidity runs out.',
      evidence: {},
      reasoning:
        'The shape of the curve — not any single point on it — is what tells you whether the ' +
        'active range is deep or merely present.',
    };
  }

  const reference = referenceRate(depth);
  const points: { notionalUSD: number; slip: number; ticks: number | null }[] = [];
  for (const rung of depth.rungs) {
    const slip = slippageOf(rung, reference);
    if (slip !== null) points.push({ notionalUSD: rung.notionalUSD, slip, ticks: rung.ticksCrossed });
  }

  const evidence: Record<string, string> = {};
  for (const p of points) {
    evidence[usd(p.notionalUSD)] =
      `${pct(p.slip, 3)}${p.ticks === null ? '' : ` (${p.ticks} tick${p.ticks === 1 ? '' : 's'})`}`;
  }

  // Rungs were quoted but few or none of them filled. There is no curve to read
  // the shape of — `executable-depth` is where that failure belongs, and saying
  // it twice in different words would double-count one fact.
  if (points.length < 2) {
    return {
      ...base,
      verdict: 'unknown',
      headline:
        `Only ${points.length} of ${depth.rungs.length} quoted sizes filled, so there is no ` +
        `curve to read.`,
      evidence: {
        ...evidence,
        'rungs that did not fill': depth.rungs
          .filter((r) => r.amountOut === null)
          .map((r) => usd(r.notionalUSD))
          .join(', ') || 'none',
      },
      reasoning:
        'The shape of the curve is what says where liquidity runs out, and a shape needs at ' +
        'least two points. Whether the pool trades at all is answered above, not here.',
    };
  }

  // Two tests, because either one alone is blind in a case the other catches.
  // The ratio test finds a curve that bends sharply while staying small. The
  // absolute test finds a curve that goes from fine to catastrophic in one
  // step — which the ratio test misses whenever the previous rung rounded to
  // zero slippage, and TRUMP/WETH is exactly that: 0.000% at $1k, 90% at $10k,
  // a ratio of infinity that the guard against dividing by zero skipped.
  let cliff: { from: number; to: number; describe: string } | null = null;
  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1]!;
    const current = points[i]!;
    if (
      previous.slip <= THRESHOLDS.usableDepthSlippageCeiling
      && current.slip >= THRESHOLDS.retailSlippageFail * 5
    ) {
      cliff = {
        from: previous.notionalUSD,
        to: current.notionalUSD,
        describe: `slippage goes from ${pct(previous.slip, 3)} to ${pct(current.slip, 1)}`,
      };
      break;
    }
    if (previous.slip <= 0) continue;
    const multiple = current.slip / previous.slip;
    if (multiple > THRESHOLDS.slippageCliffMultiple) {
      cliff = {
        from: previous.notionalUSD,
        to: current.notionalUSD,
        describe: `slippage jumps ${multiple.toFixed(0)}x`,
      };
      break;
    }
  }

  if (cliff) {
    return {
      ...base,
      verdict: 'warn',
      headline:
        `Liquidity runs out between ${usd(cliff.from)} and ${usd(cliff.to)}: ${cliff.describe} ` +
        `across that one step.`,
      evidence,
      reasoning:
        'A cliff is the edge of the active range. Below it the pool is competitive; above it a ' +
        'trade walks through ticks with nothing in them. For an LP that means fee income is capped ' +
        'at the flow that fits under the cliff, and it marks how far price can move before the ' +
        'position is entirely on one side.',
    };
  }

  const last = points[points.length - 1]!;
  return {
    ...base,
    verdict: 'pass',
    headline:
      `Slippage scales smoothly with size, reaching ${pct(last.slip, 3)} at ${usd(last.notionalUSD)}.`,
    evidence,
    reasoning:
      'No cliff inside the quoted range means the active liquidity is continuous across every size ' +
      'tested, so the pool degrades gracefully rather than emptying at one particular size.',
  };
}

function feeReturn(pool: PoolFacts): Signal {
  const base = { id: 'fee-return', label: 'Fee return to LPs', structural: false } as const;
  const window = historyWindow(pool, THRESHOLDS.activityWindowHours);

  if (pool.hourly.length === 0 || pool.totalValueLockedUSD <= 0) {
    return {
      ...base,
      verdict: 'unknown',
      headline: 'No closed hourly interval to compute a realized fee return from.',
      evidence: {
        'closed hourly snapshots': String(pool.hourly.length),
        'claimed TVL': usd(pool.totalValueLockedUSD),
      },
      reasoning:
        'The Messari schema writes interval snapshots only at rollover, so a pool indexed very ' +
        'recently has a currently-open interval and nothing closed. Annualizing from the ' +
        'cumulative figure instead would silently divide by an indexing window rather than by ' +
        'elapsed time, which is how a two-day-old subgraph produces a fictional APY.',
    };
  }

  // Elapsed hours, not row count. Dividing realized revenue by the number of
  // rows would annualize a sparse pool's three busy hours as though the other
  // twenty-one did not exist, inflating the yield by whatever the sparsity
  // factor happens to be.
  const hours = Math.max(1, window.elapsedHours);
  const revenue = window.buckets.reduce((sum, h) => sum + h.supplySideRevenueUSD, 0);
  const volume = window.buckets.reduce((sum, h) => sum + h.volumeUSD, 0);
  const averageTvl = window.buckets.length > 0
    ? window.buckets.reduce((sum, h) => sum + h.totalValueLockedUSD, 0) / window.buckets.length
    : pool.totalValueLockedUSD;
  const apy = averageTvl > 0 ? (revenue / averageTvl) * (SECONDS_PER_YEAR / (hours * 3600)) : 0;
  const turnover = averageTvl > 0 ? volume / averageTvl : 0;

  const evidence: Record<string, string> = {
    'window': `${hours}h of subgraph history, ${window.buckets.length} snapshot(s) in it`,
    'LP revenue in window': usd(revenue),
    'volume in window': usd(volume),
    'average TVL in window': usd(averageTvl),
    'daily turnover (volume / TVL)': `${(turnover * (24 / hours)).toFixed(3)}x`,
    'annualized fee return on TVL': pct(apy),
    'fee tier': pool.feeTierPct === null ? 'unknown' : `${pool.feeTierPct}%`,
  };

  if (apy > THRESHOLDS.feeApyWarnHigh) {
    return {
      ...base,
      verdict: 'warn',
      headline: `Realized fee return annualizes to ${pct(apy, 0)}, which is too good to be real.`,
      evidence,
      reasoning:
        'Yields at this level are normally one large trade extrapolated across a year, or wash ' +
        'volume. Either way the number will not persist, and sizing a position against it is the ' +
        'mistake the number is designed to produce.',
    };
  }

  if (apy < THRESHOLDS.feeApyWarnLow) {
    return {
      ...base,
      verdict: 'warn',
      headline: `LPs are being paid ${pct(apy)} annualized, which does not cover the risk.`,
      evidence,
      reasoning:
        'Fee income is the entire compensation for impermanent loss. Below roughly 1% annualized ' +
        'the position is a directional bet on the pair with a rounding error attached.',
    };
  }

  return {
    ...base,
    verdict: 'pass',
    headline: `Realized fee return is ${pct(apy)} annualized on ${usd(averageTvl)} of average TVL.`,
    evidence,
    reasoning:
      'This is computed from supply-side revenue the subgraph actually recorded in closed ' +
      'intervals, not from an advertised fee tier multiplied by hoped-for volume, so it is what ' +
      'LPs were paid rather than what they might be.',
  };
}

function activityContinuity(pool: PoolFacts): Signal {
  const base = { id: 'activity-continuity', label: 'Trading continuity', structural: true } as const;
  const window = historyWindow(pool, THRESHOLDS.activityWindowHours);

  if (pool.hourly.length === 0) {
    return {
      ...base,
      verdict: 'unknown',
      headline: 'No closed hourly interval — this pool has no queryable trading history yet.',
      evidence: { 'closed hourly snapshots': '0' },
      reasoning:
        'Either the pool is new or the subgraph has not indexed far enough past its start block ' +
        'to close an interval. Both are reasons to withhold a historical judgement rather than to ' +
        'make one from nothing.',
    };
  }

  if (window.buckets.length === 0) {
    return {
      ...base,
      verdict: 'fail',
      headline:
        `Nothing traded in the ${THRESHOLDS.activityWindowHours} hours before the subgraph head, ` +
        `though the pool does have older history.`,
      evidence: {
        'window': `${THRESHOLDS.activityWindowHours}h ending at the subgraph head`,
        'snapshots in window': '0',
        'most recent snapshot': `hour ${Math.max(...pool.hourly.map((h) => h.hour))}`,
        'total snapshots held': String(pool.hourly.length),
      },
      reasoning:
        'A pool that has stopped trading still holds an LP\'s capital and still reprices against ' +
        'every move in the pair. All of the risk, none of the fees.',
    };
  }

  const share = window.activeHours / window.elapsedHours;
  const volumes = window.buckets.map((h) => h.volumeUSD);
  const evidence: Record<string, string> = {
    'hours elapsed in window': String(window.elapsedHours),
    'hours with volume': `${window.activeHours} (${pct(share, 1)})`,
    'volume in window': usd(volumes.reduce((sum, v) => sum + v, 0)),
    'busiest hour': usd(Math.max(...volumes)),
    'quietest traded hour': usd(Math.min(...volumes)),
  };

  if (share <= THRESHOLDS.activeHourFailShare) {
    return {
      ...base,
      verdict: 'fail',
      headline:
        `Trading is not continuous: ${window.activeHours} of ${window.elapsedHours} elapsed hours ` +
        `saw any volume.`,
      evidence,
      reasoning:
        'An LP is exposed to the pool every hour and paid only in the hours it trades. A pool that ' +
        'is idle most of the time carries the full inventory risk of a live market and earns a ' +
        "fraction of a live market's fees.",
    };
  }

  if (share < THRESHOLDS.activeHourWarnShare) {
    return {
      ...base,
      verdict: 'warn',
      headline:
        `Volume arrives in bursts: ${window.activeHours} of ${window.elapsedHours} elapsed hours traded.`,
      evidence,
      reasoning:
        'Intermittent flow makes realized fee income lumpy and much harder to forecast than the ' +
        'annualized figure suggests, and it usually means a single router or bot is the pool.',
    };
  }

  return {
    ...base,
    verdict: 'pass',
    headline: `Flow is continuous: ${window.activeHours} of the last ${window.elapsedHours} hours traded.`,
    evidence,
    reasoning:
      'Continuous two-way flow is what turns a fee tier into income. It also means the price is ' +
      'being kept honest by arbitrage rather than drifting between rare trades.',
  };
}

function lpConcentration(pool: PoolFacts): Signal {
  const base = { id: 'lp-concentration', label: 'LP concentration', structural: false } as const;
  const evidence: Record<string, string> = {
    'open positions': String(pool.openPositionCount),
    'positions ever opened': String(pool.positionCount),
  };

  if (pool.positionCount === 0) {
    return {
      ...base,
      verdict: 'unknown',
      headline: 'No position data indexed for this pool.',
      evidence,
      reasoning:
        'Positions reach this subgraph through the NonfungiblePositionManager, so liquidity ' +
        'provided directly to the pool contract — or before the indexer start block — is invisible ' +
        'here. Absence is not evidence of absence.',
    };
  }

  if (pool.openPositionCount <= THRESHOLDS.lpCountFail) {
    return {
      ...base,
      verdict: 'fail',
      structural: false,
      headline: `${pool.openPositionCount} open position: this pool is one participant's inventory.`,
      evidence,
      reasoning:
        'With a single LP there is no market to join — you would be trading against whoever set the ' +
        'pool up, on terms they chose, and they can withdraw the whole range in one transaction.',
    };
  }

  if (pool.openPositionCount <= THRESHOLDS.lpCountWarn) {
    return {
      ...base,
      verdict: 'warn',
      headline: `Only ${pool.openPositionCount} open positions — the pool is a handful of LPs.`,
      evidence,
      reasoning:
        'A small LP set means one withdrawal can move the depth profile materially, so the depth ' +
        'measured above is less durable than it looks.',
    };
  }

  return {
    ...base,
    verdict: 'pass',
    headline: `${pool.openPositionCount} open positions across ${pool.positionCount} ever opened.`,
    evidence,
    reasoning:
      'A broad LP base means the depth profile is the aggregate of many independent decisions and ' +
      'does not disappear when one of them changes their mind.',
  };
}

// --- Composition -----------------------------------------------------------

function confidenceOf(input: AnalystInput, signals: Signal[], lagSeconds: number): number {
  let confidence = 1;
  const unknowns = signals.filter((s) => s.verdict === 'unknown').length;
  confidence -= unknowns * 0.12;

  if (input.depth === null) confidence -= 0.3;
  else if (input.depth.notionalPricing.priceSource === 'subgraph-lastPriceUSD') {
    // The notional ladder was sized using a price the same subgraph derived from
    // this same pool. On a healthy pool that is fine; on a broken one it is
    // circular, so it costs a little confidence everywhere rather than being
    // silently trusted.
    confidence -= 0.05;
  }

  const hours = Math.min(input.pool.hourly.length, THRESHOLDS.activityWindowHours);
  confidence -= (1 - hours / THRESHOLDS.activityWindowHours) * 0.25;

  if (lagSeconds > THRESHOLDS.lagStaleSeconds) confidence -= 0.2;
  else if (lagSeconds > THRESHOLDS.lagWarnSeconds) confidence -= 0.08;

  return Math.max(0, Math.min(1, Number(confidence.toFixed(2))));
}

function ratingOf(signals: Signal[]): Rating {
  const structuralFail = signals.some((s) => s.structural && s.verdict === 'fail');
  if (structuralFail) return 'AVOID';

  const fails = signals.filter((s) => s.verdict === 'fail').length;
  const warns = signals.filter((s) => s.verdict === 'warn').length;
  const structuralUnknowns = signals.filter((s) => s.structural && s.verdict === 'unknown').length;

  // Two structural questions unanswered is not a cautious yes, it is a
  // no-answer. Saying CAUTION there would let a missing measurement masquerade
  // as a measured concern.
  if (structuralUnknowns >= 2) return 'INSUFFICIENT_DATA';
  if (fails > 0 || warns >= 2) return 'CAUTION';
  return 'ACCEPTABLE';
}

function summarize(
  pool: PoolFacts,
  rating: Rating,
  confidence: number,
  signals: Signal[],
  lagSeconds: number,
  hasDepth: boolean,
): string {
  const fails = signals.filter((s) => s.verdict === 'fail');
  const warns = signals.filter((s) => s.verdict === 'warn');
  const parts: string[] = [];

  if (rating === 'AVOID') {
    parts.push(
      `Do not provide liquidity to ${pool.name}. ` +
        fails.map((s) => s.headline).join(' ') +
        ' Any one of those is disqualifying on its own; the headline TVL does not offset them, ' +
        'because it is derived from the same reserves that produced them.',
    );
  } else if (rating === 'INSUFFICIENT_DATA') {
    parts.push(
      `No verdict on ${pool.name}. The measurements that decide whether a pool is a venue at all ` +
        `could not be taken, and a confident-sounding answer built on the ones that did land would ` +
        `be worse than none.`,
    );
  } else if (rating === 'CAUTION') {
    parts.push(
      `${pool.name} works as a venue but is not a clean LP position. ` +
        [...fails, ...warns].map((s) => s.headline).join(' '),
    );
  } else {
    parts.push(
      `${pool.name} looks safe to LP on the evidence available. Reserves are genuinely two-sided, ` +
        `live quotes execute at the sizes tested, and the fee return is realized rather than ` +
        `projected.`,
    );
  }

  if (!hasDepth) {
    parts.push(
      'This rests on indexed history alone — no live quote was obtained, so nothing here has been ' +
        'checked against the pool as it stands right now.',
    );
  }

  if (lagSeconds > THRESHOLDS.lagStaleSeconds) {
    parts.push(
      `The subgraph is ${duration(lagSeconds)} behind the chain head, so the historical half of ` +
        `this verdict describes the pool as it was, not as it is. Where the live quote and the ` +
        `history disagree, believe the quote.`,
    );
  } else if (lagSeconds > THRESHOLDS.lagWarnSeconds) {
    parts.push(`History is ${duration(lagSeconds)} behind the chain head.`);
  }

  parts.push(`Confidence ${pct(confidence, 0)}.`);
  return parts.join(' ');
}

/**
 * The whole judgement, from facts to verdict. Pure: same input, same output,
 * on any machine, inside or outside an enclave.
 */
export function assess(input: AnalystInput): Verdict {
  const { pool, depth, now } = input;
  const lagSeconds = Math.max(0, now - pool.source.blockTimestamp);

  const signals: Signal[] = [
    inventoryBalance(pool),
    executableDepth(depth),
    depthVersusTvl(pool, depth),
    slippageCurve(depth),
    feeReturn(pool),
    activityContinuity(pool),
    lpConcentration(pool),
  ];

  const rating = ratingOf(signals);
  const confidence = confidenceOf(input, signals, lagSeconds);

  const caveats: string[] = [];
  for (const signal of signals) {
    if (signal.verdict === 'unknown') caveats.push(`${signal.label}: ${signal.headline}`);
  }
  if (lagSeconds > THRESHOLDS.lagWarnSeconds) {
    caveats.push(
      `Subgraph head is block ${pool.source.blockNumber}, ${duration(lagSeconds)} behind the ` +
        `chain head. Every historical figure above is as of that block.`,
    );
  }
  if (depth && depth.notionalPricing.priceSource === 'subgraph-lastPriceUSD') {
    caveats.push(
      `USD notionals on the depth ladder were sized using the subgraph's own derived price for ` +
        `${depth.notionalPricing.tokenSymbol} (${usd(depth.notionalPricing.priceUSD)}). For a pool ` +
        `whose price the subgraph derives from this same pool, that is circular — the token ` +
        `amounts quoted are exact, the dollar labels on them are only as good as that price.`,
    );
  }
  if (pool.tokens.some((t) => t.priceUSD === null)) {
    caveats.push(
      `The subgraph could not anchor a USD price for ` +
        pool.tokens.filter((t) => t.priceUSD === null).map((t) => t.symbol).join(', ') +
        `, so any USD figure involving that side is incomplete rather than zero.`,
    );
  }

  return {
    pool: pool.name,
    poolAddress: pool.address,
    rating,
    confidence,
    summary: summarize(pool, rating, confidence, signals, lagSeconds, depth !== null),
    signals,
    provenance: {
      subgraph: pool.source.label,
      subgraphTransport: pool.source.transport,
      subgraphBlock: pool.source.blockNumber,
      subgraphLagSeconds: lagSeconds,
      depthProvider: depth ? `${depth.provider} (${depth.providerDetail})` : null,
      depthBlock: depth ? depth.atBlock : null,
      assessedAt: now,
    },
    caveats,
  };
}
