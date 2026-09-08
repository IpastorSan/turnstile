// Prose summaries.
//
// Every tool returns two content blocks: a short summary, then the full JSON.
// The summary is not decoration. The caller is a language model that will act
// on this, and the things it most needs to notice — that a rung reverted, that
// the data is twelve days old, that a token is impersonating a well-known
// symbol — are exactly the things that disappear when they are one field in a
// nested object. Putting them in prose at the top makes them unavoidable.

import type { FindPoolsResult } from './pools.ts';
import type { DepthProfile } from './depth.ts';
import type { QuoteResult } from './quotes.ts';
import type { SubgraphResponse } from './subgraph.ts';
import type { TokenInfo } from './tokens.ts';

export function summarizeToken(token: TokenInfo, chain: string): string {
  const lines = [
    `${token.symbol}${token.name ? ` (${token.name})` : ''} on ${chain}: `
    + `${token.decimals} decimals, ${token.address}`,
  ];
  lines.push(...token.warnings);
  return lines.join('\n');
}

export function summarizePools(result: FindPoolsResult): string {
  const { tokenA, tokenB } = result;
  const lines: string[] = [];
  const live = result.pools.filter((p) => !p.empty && !p.error);

  lines.push(
    `${tokenA.symbol}/${tokenB.symbol} on ${result.chain}: `
    + `${result.pools.length} v3 pool(s) exist, ${live.length} with liquidity, `
    + `at block ${result.atBlock}.`,
  );

  for (const p of result.pools) {
    const state = p.error
      ? `unreadable (${p.error})`
      : p.empty
        ? 'ZERO liquidity — a quote here reverts'
        : `liquidity ${p.activeLiquidity}, tick ${p.tick}`;
    lines.push(`  ${p.feeLabel.padStart(6)}  ${p.address}  ${state}`);
  }
  if (result.missingTiers.length) {
    lines.push(
      `  no pool at ${result.missingTiers.map((f) => `${f / 10_000}%`).join(', ')}`,
    );
  }
  lines.push(...result.notes.map((n) => `NOTE: ${n}`));
  lines.push(...tokenA.warnings.map((w) => `WARNING (${tokenA.symbol}): ${w}`));
  lines.push(...tokenB.warnings.map((w) => `WARNING (${tokenB.symbol}): ${w}`));
  return lines.join('\n');
}

export function summarizeQuote(
  q: QuoteResult,
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
  chain: string,
): string {
  if (q.error) {
    return `Quote FAILED on ${chain} (${q.version}, block ${q.atBlock}): `
      + `${q.amountIn} ${tokenIn.symbol} -> ${tokenOut.symbol}\n${q.error}`;
  }
  const lines = [
    `${q.amountIn} ${tokenIn.symbol} -> ${q.amountOut} ${tokenOut.symbol} `
    + `on ${chain} ${q.version}, block ${q.atBlock}.`,
    `Rate: ${q.executedPrice?.toPrecision(8)} ${tokenOut.symbol} per ${tokenIn.symbol}.`,
  ];
  if (q.initializedTicksCrossed !== null) {
    lines.push(
      `Crossed ${q.initializedTicksCrossed} initialized ticks. This is the depth reading: a trade `
      + 'that crosses few ticks is sitting in dense liquidity, one that crosses many is walking '
      + 'through it.',
    );
  } else if (q.version === 'v4') {
    lines.push('V4Quoter returns no tick count, so there is no depth reading on a v4 quote.');
  }
  lines.push(
    'This is a simulated `eth_call` against a non-view quoter at one block. It is not a '
    + 'guaranteed fill: the pool can move before a real swap lands.',
  );
  return lines.join('\n');
}

export function summarizeDepth(profile: DepthProfile): string {
  const lines = [
    `Depth of the ${profile.tokenIn.symbol}/${profile.tokenOut.symbol} ${profile.feeLabel} pool `
    + `on ${profile.chain}, all rungs at block ${profile.atBlock}.`,
  ];

  const width = Math.max(...profile.rungs.map((r) => String(r.amountIn).length), 6);
  lines.push(`  ${'sizeIn'.padStart(width)}  ${'out'.padStart(18)}  ${'impact'.padStart(8)}  ticks`);
  for (const r of profile.rungs) {
    if (!r.filled) {
      lines.push(`  ${String(r.amountIn).padStart(width)}  ${'CANNOT FILL'.padStart(18)}`);
      continue;
    }
    const impact = r.priceImpact === null ? '—' : `${(r.priceImpact * 100).toFixed(3)}%`;
    lines.push(
      `  ${String(r.amountIn).padStart(width)}  ${String(r.amountOut).padStart(18)}  `
      + `${impact.padStart(8)}  ${r.initializedTicksCrossed ?? '—'}`,
    );
  }

  if (profile.referenceAmountIn !== null) {
    lines.push(
      `Impact is measured against the ${profile.referenceAmountIn}-unit rung, not against spot. `
      + 'Spot is the price of an infinitesimal trade and nobody executes at it.',
    );
  }
  const m = profile.maxSizeWithinSlippage;
  if (m?.amountIn != null) {
    lines.push(
      `Roughly ${m.amountIn.toPrecision(6)} ${profile.tokenIn.symbol} fits inside a `
      + `${(m.slippage * 100).toFixed(2)}% budget`
      + (m.interpolated
        ? ' — INTERPOLATED between two rungs. Concentrated liquidity is piecewise and can fall off '
          + 'a cliff between them, so treat this as where to look, not as a limit to trade on.'
        : ', which is the largest rung measured — the ladder did not reach the edge, so the real '
          + 'figure is at least this.'),
    );
  } else if (m) {
    lines.push(
      `Not even the smallest rung fits inside a ${(m.slippage * 100).toFixed(2)}% budget.`,
    );
  }
  lines.push(...profile.notes.map((n) => `NOTE: ${n}`));
  return lines.join('\n');
}

export function summarizeSubgraph(response: SubgraphResponse): string {
  const lines: string[] = [];
  if (response.meta) {
    const lag = response.lagSeconds ?? 0;
    lines.push(
      `Answered by ${new URL(response.url).host} at block ${response.meta.block} `
      + `(${new Date(response.meta.timestamp * 1000).toISOString()}), `
      + `${formatLag(lag)} behind now.`,
    );
  } else {
    lines.push(`Answered by ${new URL(response.url).host}; no _meta, so freshness is unknown.`);
  }
  if (response.errors?.length) {
    lines.push(...response.errors.map((e) => `GraphQL error: ${e.message}`));
  }
  lines.push(...response.notes.map((n) => `NOTE: ${n}`));
  return lines.join('\n');
}

export function formatLag(seconds: number): string {
  if (seconds < 90) return `${Math.max(0, Math.round(seconds))}s`;
  if (seconds < 5400) return `${(seconds / 60).toFixed(1)} min`;
  if (seconds < 172_800) return `${(seconds / 3600).toFixed(1)} h`;
  return `${(seconds / 86_400).toFixed(1)} days`;
}
