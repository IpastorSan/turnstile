// The Liquidity Analyst. Answers one question — **is this pool safe to LP?** —
// by combining what a Messari-schema subgraph knows about the pool's past with
// what Uniswap's quoter says it will do at the current block.
//
// This file is the only one that does I/O and reasoning-about-I/O. The
// judgement lives in `scoring.ts`, which is pure. The seam between them is
// deliberate and load-bearing:
//
//     gatherInput(...)  ->  AnalystInput  ->  assess(...)  ->  Verdict
//     ^ network                ^ plain JSON       ^ pure
//
// MOV-227 moves `assess` into a Chainlink TEE enclave. When it does, this file
// does not change: `gatherInput` still runs out here where there is a network,
// serializes its result, and the enclave scores it. That is a swap rather than
// a rewrite precisely because no fetch ever reaches into the scorer and no
// scoring rule ever reaches into a fetcher.
//
// Importable on its own. Nothing here needs an HTTP server, a database, or the
// rest of Turnstile:
//
//     import { analyzePool, renderVerdict } from './seller/analyst/analyst.ts';
//     const verdict = await analyzePool({ pool: '0x88e6a0c2...' });
//     console.log(renderVerdict(verdict));

import { assess } from './scoring.ts';
import { fetchPoolFacts, httpSource } from './subgraph.ts';
import type { SubgraphSource } from './subgraph.ts';
import { fetchDepth } from './uniswap-quotes.ts';
import type { DepthProvider, QuoterOptions } from './uniswap-quotes.ts';
import type { AnalystInput, DepthProfile, PoolFacts, Signal, Verdict } from './types.ts';

/**
 * Tokens whose USD price the subgraph anchors directly rather than deriving
 * through another pool. Used only to decide which side's price to trust when
 * sizing the depth ladder — never to fill in a price we do not have.
 */
const ANCHOR_SYMBOLS = new Set(['USDC', 'USDT', 'DAI', 'WETH', 'WBTC', 'FRAX', 'LUSD']);

export type QuoteDirection = 'drain-thin-side' | 'in0' | 'in1';

export interface AnalyzeOptions {
  /** Pool address. Lowercased for you. */
  pool: string;
  /** Defaults to Turnstile's own subgraph over HTTP. Pass `mcpSource(...)` for any other. */
  source?: SubgraphSource;
  /** Hours of closed snapshots to pull. */
  hours?: number;
  /** `auto` uses the Trading API when `UNISWAP_API_KEY` exists, else QuoterV2. */
  depthProvider?: DepthProvider;
  quoter?: QuoterOptions;
  notionalsUSD?: number[];
  direction?: QuoteDirection;
  /** Skip the live quote entirely. The verdict will say so and lose confidence. */
  skipDepth?: boolean;
  /** Unix seconds. Pin it to make a run reproducible; defaults to the wall clock. */
  now?: number;
  chainId?: number;
}

/**
 * Which way to quote.
 *
 * Depth is directional, and for an LP the interesting direction is the one that
 * *drains the thinner side*, because that is the side that runs out. Quoting
 * TRUMP/WETH the other way round — buying an abundant token with a scarce one —
 * makes an empty pool look bottomless. Defaulting to "drain the thin side"
 * means the ladder is aimed at the failure mode rather than away from it.
 *
 * The notional is then priced in the abundant token, which on a healthy pair is
 * the stable side. On a broken pair it is whatever the subgraph derived, and
 * `scoring.ts` discounts confidence for exactly that reason.
 */
function chooseDirection(pool: PoolFacts, requested: QuoteDirection): [number, number] {
  if (requested === 'in0') return [0, 1];
  if (requested === 'in1') return [1, 0];

  const [a, b] = pool.tokens;
  if (!a || !b) throw new Error(`pool ${pool.address} does not have two input tokens`);

  const aUSD = a.balanceUSD;
  const bUSD = b.balanceUSD;
  if (aUSD !== null && bUSD !== null) return aUSD >= bUSD ? [0, 1] : [1, 0];

  // Only one side priced: sell that one, since it is the only side whose USD
  // notional means anything.
  if (aUSD !== null) return [0, 1];
  if (bUSD !== null) return [1, 0];

  // Neither priced. Prefer an anchor token so the ladder is at least sized in
  // something recognisable; the scorer will flag the whole thing as unknown.
  if (ANCHOR_SYMBOLS.has(b.symbol) && !ANCHOR_SYMBOLS.has(a.symbol)) return [1, 0];
  return [0, 1];
}

/** Uniswap's uint24 fee tier from the Messari percentage. 0.05 -> 500. */
function feeTierUint24(feePct: number | null): number | null {
  if (feePct === null) return null;
  return Math.round(feePct * 10_000);
}

/**
 * Collect every fact the scorer needs. This is the half that touches the
 * network; everything it returns is plain JSON, so it can be handed across a
 * process, a queue, or an enclave boundary unchanged.
 */
export async function gatherInput(options: AnalyzeOptions): Promise<AnalystInput> {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const source = options.source ?? httpSource();
  const pool = await fetchPoolFacts(source, options.pool, options.hours ?? 48);

  let depth: DepthProfile | null = null;
  if (!options.skipDepth) {
    depth = await quoteDepthFor(pool, options, now);
  }

  return { pool, depth, now };
}

async function quoteDepthFor(
  pool: PoolFacts,
  options: AnalyzeOptions,
  now: number,
): Promise<DepthProfile | null> {
  const [inIndex, outIndex] = chooseDirection(pool, options.direction ?? 'drain-thin-side');
  const tokenIn = pool.tokens[inIndex];
  const tokenOut = pool.tokens[outIndex];
  const feeTier = feeTierUint24(pool.feeTierPct);

  // Each of these is a reason we cannot quote, not an error. The verdict says
  // "no live quote was obtained" and drops confidence, which is a truthful
  // answer; throwing here would turn a partial answer into no answer.
  if (!tokenIn || !tokenOut) return null;
  if (feeTier === null) return null;
  if (tokenIn.priceUSD === null) return null;

  try {
    return await fetchDepth(
      {
        tokenIn: { address: tokenIn.address, symbol: tokenIn.symbol, decimals: tokenIn.decimals },
        tokenOut: { address: tokenOut.address, symbol: tokenOut.symbol, decimals: tokenOut.decimals },
        feeTier,
        tokenInPriceUSD: tokenIn.priceUSD,
        priceSource: 'subgraph-lastPriceUSD',
        notionalsUSD: options.notionalsUSD,
        chainId: options.chainId,
        now,
      },
      { provider: options.depthProvider, quoter: options.quoter },
    );
  } catch {
    // A provider that cannot be reached at all (RPC down, no key) is the same
    // situation as no depth: reported, not fatal.
    return null;
  }
}

/** Gather, then score. The whole analyst, in one call. */
export async function analyzePool(options: AnalyzeOptions): Promise<Verdict> {
  const input = await gatherInput(options);
  return assess(input);
}

// --- Rendering -------------------------------------------------------------
//
// A verdict is only useful if a reader can check it, so every signal prints the
// numbers it was derived from underneath the sentence it produced. That is the
// difference between an analyst and a query formatter: the query result is
// present, but it is present as *evidence for a claim*, not as the output.

function wrap(text: string, width: number, indent: string): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line.length === 0) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.map((l) => indent + l).join('\n');
}

const MARK: Record<Signal['verdict'], string> = {
  pass: 'PASS',
  warn: 'WARN',
  fail: 'FAIL',
  unknown: ' ?  ',
};

function relativeTime(seconds: number): string {
  if (seconds < 120) return `${Math.round(seconds)}s`;
  if (seconds < 7200) return `${Math.round(seconds / 60)}m`;
  if (seconds < 172_800) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86_400).toFixed(1)}d`;
}

export function renderVerdict(verdict: Verdict, width = 92): string {
  const out: string[] = [];
  const rule = '='.repeat(width);

  out.push(rule);
  out.push(`LIQUIDITY ANALYST — is this pool safe to LP?`);
  out.push(`${verdict.pool}`);
  out.push(`${verdict.poolAddress}`);
  out.push(rule);
  out.push('');
  out.push(`VERDICT: ${verdict.rating}    confidence ${(verdict.confidence * 100).toFixed(0)}%`);
  out.push('');
  out.push(wrap(verdict.summary, width - 2, '  '));
  out.push('');
  out.push('WHY');

  for (const signal of verdict.signals) {
    out.push('');
    out.push(`  [${MARK[signal.verdict]}] ${signal.label}`);
    out.push(wrap(signal.headline, width - 10, '         '));
    out.push(wrap(signal.reasoning, width - 10, '         '));
    const keys = Object.keys(signal.evidence);
    if (keys.length > 0) {
      const pad = Math.min(38, Math.max(...keys.map((k) => k.length)));
      out.push('');
      for (const key of keys) {
        out.push(`           ${key.padEnd(pad)}  ${signal.evidence[key]}`);
      }
    }
  }

  if (verdict.caveats.length > 0) {
    out.push('');
    out.push('WHAT THIS VERDICT DOES NOT KNOW');
    for (const caveat of verdict.caveats) {
      // Hanging indent, so a wrapped caveat still reads as one bullet.
      out.push(`  - ${wrap(caveat, width - 6, '    ').trimStart()}`);
    }
  }

  out.push('');
  out.push('INPUTS');
  out.push(`  subgraph        ${verdict.provenance.subgraph} [${verdict.provenance.subgraphTransport}]`);
  out.push(
    `  subgraph head   block ${verdict.provenance.subgraphBlock}, `
    + `${relativeTime(verdict.provenance.subgraphLagSeconds)} behind chain head`,
  );
  out.push(`  live depth      ${verdict.provenance.depthProvider ?? 'not obtained'}`);
  if (verdict.provenance.depthBlock !== null) {
    out.push(`  quoted at       block ${verdict.provenance.depthBlock}`);
  }
  out.push(`  assessed at     ${new Date(verdict.provenance.assessedAt * 1000).toISOString()}`);
  out.push(rule);

  return out.join('\n');
}

export { assess } from './scoring.ts';
export { httpSource, mcpSource, fetchPoolFacts, fetchTopPoolsByTvl } from './subgraph.ts';
export { SubgraphMcpClient } from './subgraph-mcp.ts';
export { fetchDepth, fetchDepthFromQuoter, fetchDepthFromTradingApi } from './uniswap-quotes.ts';
export type { AnalystInput, DepthProfile, PoolFacts, Rating, Signal, Verdict } from './types.ts';
