// Depth at size: what a pool actually does as the trade gets bigger.
//
// A single quote tells you the price of one size. It does not tell you whether
// that price survives the next order of magnitude, and that is the question
// behind almost every real use — sizing an entry, judging whether a pool is
// worth providing liquidity to, deciding whether a TVL number means anything.
//
// So this walks a ladder of sizes against the same pool at the same block and
// reports the curve. Two properties make the answer trustworthy:
//
//   1. **Every rung is pinned to one block.** Quoting five sizes over five
//      blocks measures the pool moving as much as it measures the pool's depth.
//   2. **A revert is a data point, not a failure.** The size at which a pool
//      stops being able to fill is precisely the thing being measured. A rung
//      that reverts is recorded as "cannot fill" and the walk continues.
//
// The reference price is the *smallest* rung, not a spot price from `slot0`.
// Spot is the marginal price of an infinitesimal trade and no one can execute
// at it, so measuring impact against it charges every trade for the fee tier
// and for crossing the first tick. Measuring against the smallest executable
// size answers the question a trader actually has: what does going bigger cost
// me, relative to going small.

import type { PublicClient } from 'viem';

import type { ChainConfig } from './chains.ts';
import { quoteV3 } from './quotes.ts';
import type { QuoteResult } from './quotes.ts';
import type { TokenInfo } from './tokens.ts';
import { feeLabel } from './pools.ts';

/** Multipliers applied to the base size when the caller gives no explicit ladder. */
export const DEFAULT_LADDER = [1, 10, 100, 1_000, 10_000];

export interface DepthRung {
  amountIn: number;
  amountOut: string | null;
  executedPrice: number | null;
  /** Loss versus the smallest filling rung, as a fraction. 0.012 is 1.2%. */
  priceImpact: number | null;
  initializedTicksCrossed: number | null;
  gasEstimate: string | null;
  filled: boolean;
  error?: string;
}

export interface DepthProfile {
  chain: string;
  chainId: number;
  version: 'v3';
  quoter: `0x${string}`;
  feeTier: number;
  feeLabel: string;
  tokenIn: { address: string; symbol: string; decimals: number };
  tokenOut: { address: string; symbol: string; decimals: number };
  atBlock: number;
  quotedAt: number;
  referenceAmountIn: number | null;
  referencePrice: number | null;
  rungs: DepthRung[];
  /** Largest ladder size that filled at all. */
  maxFillableAmountIn: number | null;
  /** Interpolated, and labelled as such. See `estimateMaxSizeWithin`. */
  maxSizeWithinSlippage: { slippage: number; amountIn: number | null; interpolated: boolean } | null;
  notes: string[];
}

export interface DepthRequest {
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  feeTier: number;
  /** Explicit sizes in whole tokenIn units. Takes precedence over baseAmountIn. */
  amountsIn?: number[];
  /** Smallest size; the default ladder multiplies it by 1, 10, 100, 1e3, 1e4. */
  baseAmountIn?: number;
  /** Slippage budget for `maxSizeWithinSlippage`, as a fraction. Default 0.01. */
  slippageBudget?: number;
  now?: number;
}

export async function profileDepth(
  client: PublicClient,
  config: ChainConfig,
  request: DepthRequest,
): Promise<DepthProfile> {
  const amounts = ladderFor(request);
  // One block for the whole ladder. Read once, passed into every quote.
  const atBlock = await client.getBlockNumber();

  const quotes: QuoteResult[] = [];
  for (const amountIn of amounts) {
    quotes.push(await quoteV3(client, config, {
      tokenIn: request.tokenIn,
      tokenOut: request.tokenOut,
      feeTier: request.feeTier,
      amountIn,
      blockNumber: atBlock,
    }));
  }

  const filledIndex = quotes.findIndex((q) => q.executedPrice !== null && q.executedPrice > 0);
  const referencePrice = filledIndex >= 0 ? quotes[filledIndex]!.executedPrice : null;
  const referenceAmountIn = filledIndex >= 0 ? amounts[filledIndex]! : null;

  const rungs: DepthRung[] = quotes.map((q, i) => ({
    amountIn: amounts[i]!,
    amountOut: q.amountOut,
    executedPrice: q.executedPrice,
    priceImpact:
      referencePrice && q.executedPrice !== null
        // Positive means "worse than the reference", which is the sign a reader
        // expects from something called impact.
        ? (referencePrice - q.executedPrice) / referencePrice
        : null,
    initializedTicksCrossed: q.initializedTicksCrossed,
    gasEstimate: q.gasEstimate,
    filled: q.amountOut !== null,
    error: q.error,
  }));

  const slippage = request.slippageBudget ?? 0.01;

  return {
    chain: config.name,
    chainId: config.id,
    version: 'v3',
    quoter: config.quoterV2,
    feeTier: request.feeTier,
    feeLabel: feeLabel(request.feeTier),
    tokenIn: pick(request.tokenIn),
    tokenOut: pick(request.tokenOut),
    atBlock: Number(atBlock),
    quotedAt: request.now ?? Math.floor(Date.now() / 1000),
    referenceAmountIn,
    referencePrice,
    rungs,
    maxFillableAmountIn: lastFilled(rungs),
    maxSizeWithinSlippage: estimateMaxSizeWithin(rungs, slippage),
    notes: noteworthy(rungs, referencePrice),
  };
}

function pick(t: TokenInfo) {
  return { address: t.address, symbol: t.symbol, decimals: t.decimals };
}

export function ladderFor(request: DepthRequest): number[] {
  if (request.amountsIn?.length) {
    return [...request.amountsIn].filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  }
  const base = request.baseAmountIn ?? 1;
  return DEFAULT_LADDER.map((m) => base * m);
}

function lastFilled(rungs: DepthRung[]): number | null {
  let last: number | null = null;
  for (const r of rungs) if (r.filled) last = r.amountIn;
  return last;
}

/**
 * Largest size whose price impact stays inside the budget.
 *
 * Linear interpolation between the last rung inside the budget and the first
 * one outside it. That is an approximation and is flagged `interpolated: true`,
 * because a concentrated-liquidity curve is piecewise and can fall off a cliff
 * between two rungs — the answer is a guide to where to look, not a limit to
 * trade on. When every rung is inside the budget the ladder simply did not go
 * far enough to find the edge, and the answer is the largest rung with
 * `interpolated: false`, meaning "at least this much".
 */
export function estimateMaxSizeWithin(
  rungs: DepthRung[],
  slippage: number,
): { slippage: number; amountIn: number | null; interpolated: boolean } | null {
  const measured = rungs.filter((r) => r.filled && r.priceImpact !== null);
  if (measured.length === 0) return null;

  let inside: DepthRung | null = null;
  let outside: DepthRung | null = null;
  for (const r of measured) {
    if (r.priceImpact! <= slippage) inside = r;
    else { outside = r; break; }
  }

  if (!inside) return { slippage, amountIn: null, interpolated: false };
  if (!outside) return { slippage, amountIn: inside.amountIn, interpolated: false };

  const spanImpact = outside.priceImpact! - inside.priceImpact!;
  if (spanImpact <= 0) return { slippage, amountIn: inside.amountIn, interpolated: false };
  const fraction = (slippage - inside.priceImpact!) / spanImpact;
  const amountIn = inside.amountIn + fraction * (outside.amountIn - inside.amountIn);
  return { slippage, amountIn, interpolated: true };
}

function noteworthy(rungs: DepthRung[], referencePrice: number | null): string[] {
  const notes: string[] = [];
  if (referencePrice === null) {
    notes.push(
      'No rung filled, so there is no reference price and no curve. The pool exists but cannot '
      + 'execute at any size on the ladder — check find_pools for a fee tier that holds liquidity.',
    );
    return notes;
  }

  const failed = rungs.filter((r) => !r.filled);
  if (failed.length > 0) {
    notes.push(
      `${failed.length} of ${rungs.length} sizes could not fill. That is the measurement, not an `
      + 'error: the pool runs out somewhere between '
      + `${lastFilled(rungs) ?? 0} and ${failed[0]!.amountIn} units of input.`,
    );
  }

  const ticks = rungs.filter((r) => r.initializedTicksCrossed !== null);
  if (ticks.length >= 2) {
    const first = ticks[0]!.initializedTicksCrossed!;
    const last = ticks[ticks.length - 1]!.initializedTicksCrossed!;
    notes.push(
      `initializedTicksCrossed goes ${first} -> ${last} across the ladder. This is the mechanical `
      + 'reading of the curve: each initialized tick crossed is a discrete band of liquidity '
      + 'consumed. A pool whose tick count barely moves under 1000x size is deep; one that jumps '
      + 'is thin and merely looks large.',
    );
  }

  const worst = rungs.filter((r) => r.priceImpact !== null).pop();
  if (worst?.priceImpact !== undefined && worst.priceImpact !== null && worst.priceImpact > 0.5) {
    notes.push(
      `The largest filling size loses ${(worst.priceImpact * 100).toFixed(1)}% against the smallest. `
      + 'An impact that large usually means the quote is walking into near-empty ticks; treat the '
      + 'output amount as arithmetic rather than as a price anyone would trade at.',
    );
  }
  return notes;
}
