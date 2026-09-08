// The scorer is the piece MOV-227 lifts into a TEE enclave, so these tests do
// double duty: they check the judgement, and they check the properties that
// make the lift safe — purity, determinism, and no clock.
//
// Two of them exist because running the analyst against live mainnet data found
// the bug they now pin: hourly snapshots are sparse, so counting rows instead
// of hours turns a dead pool into a busy one, and a slippage cliff from 0% to
// 90% has an infinite ratio that a ratio test skips.

import test from 'node:test';
import assert from 'node:assert/strict';

import { assess } from './scoring.ts';
import type { AnalystInput, DepthProfile, HourlyBucket, PoolFacts } from './types.ts';

const HEAD_TS = 1_787_631_581;
const HEAD_HOUR = Math.floor(HEAD_TS / 3600);

function hourly(count: number, over: Partial<HourlyBucket> = {}): HourlyBucket[] {
  return Array.from({ length: count }, (_, i) => ({
    hour: HEAD_HOUR - i,
    timestamp: HEAD_TS - i * 3600,
    volumeUSD: 4_000_000,
    totalValueLockedUSD: 100_000_000,
    supplySideRevenueUSD: 2_000,
    ...over,
  }));
}

/** A healthy USDC/WETH-shaped pool. */
function pool(over: Partial<PoolFacts> = {}): PoolFacts {
  return {
    address: '0xpool',
    name: 'Uniswap v3 USDC/WETH 0.05%',
    protocol: 'Uniswap v3',
    network: 'MAINNET',
    tokens: [
      { address: '0xusdc', symbol: 'USDC', decimals: 6, priceUSD: 1, balance: 75_000_000, balanceUSD: 75_000_000 },
      { address: '0xweth', symbol: 'WETH', decimals: 18, priceUSD: 2_500, balance: 10_000, balanceUSD: 25_000_000 },
    ],
    createdTimestamp: HEAD_TS - 400 * 86_400,
    totalValueLockedUSD: 100_000_000,
    cumulativeVolumeUSD: 250_000_000,
    cumulativeSupplySideRevenueUSD: 125_000,
    feeTierPct: 0.05,
    positionCount: 250,
    openPositionCount: 100,
    tick: 198_000,
    hourly: hourly(24),
    source: {
      label: 'test',
      endpoint: 'test',
      transport: 'http',
      blockNumber: 25_831_581,
      blockTimestamp: HEAD_TS,
    },
    ...over,
  };
}

/** A ladder that degrades smoothly, as a deep pool does. */
function depth(over: Partial<DepthProfile> = {}): DepthProfile {
  return {
    provider: 'quoter-v2',
    providerDetail: 'test',
    tokenInSymbol: 'USDC',
    tokenOutSymbol: 'WETH',
    atBlock: 25_925_000,
    quotedAt: HEAD_TS,
    rungs: [
      { notionalUSD: 1_000, amountIn: 1_000, amountOut: 0.4, executedRate: 0.0004, ticksCrossed: 1 },
      { notionalUSD: 10_000, amountIn: 10_000, amountOut: 3.9996, executedRate: 0.00039996, ticksCrossed: 1 },
      { notionalUSD: 100_000, amountIn: 100_000, amountOut: 39.98, executedRate: 0.0003998, ticksCrossed: 2 },
      { notionalUSD: 1_000_000, amountIn: 1_000_000, amountOut: 398.5, executedRate: 0.0003985, ticksCrossed: 9 },
    ],
    notionalPricing: { tokenSymbol: 'USDC', priceUSD: 1, priceSource: 'subgraph-lastPriceUSD' },
    ...over,
  };
}

const input = (over: Partial<AnalystInput> = {}): AnalystInput => ({
  pool: pool(),
  depth: depth(),
  now: HEAD_TS + 600,
  ...over,
});

const signal = (verdict: ReturnType<typeof assess>, id: string) => {
  const found = verdict.signals.find((s) => s.id === id);
  assert.ok(found, `no signal ${id}`);
  return found;
};

test('a deep, two-sided, continuously traded pool is acceptable to LP', () => {
  const verdict = assess(input());
  assert.equal(verdict.rating, 'ACCEPTABLE');
  assert.equal(signal(verdict, 'inventory-balance').verdict, 'pass');
  assert.equal(signal(verdict, 'executable-depth').verdict, 'pass');
  assert.equal(signal(verdict, 'activity-continuity').verdict, 'pass');
  assert.ok(verdict.confidence > 0.8, `confidence was ${verdict.confidence}`);
});

test('a one-sided pool is AVOID however large its TVL claim', () => {
  // The real TRUMP/WETH 0.3% pool, reduced: 1.5bn tokens on one side and
  // 0.00063 WETH on the other, priced at $3.2B.
  const verdict = assess(input({
    pool: pool({
      name: 'Uniswap v3 TRUMP/WETH 0.3%',
      tokens: [
        { address: '0xtrump', symbol: 'TRUMP', decimals: 18, priceUSD: 2.136, balance: 1_499_998_554, balanceUSD: 3_204_067_040 },
        { address: '0xweth', symbol: 'WETH', decimals: 18, priceUSD: 2_475, balance: 0.00063, balanceUSD: 1.56 },
      ],
      totalValueLockedUSD: 3_204_067_040,
      openPositionCount: 1,
      positionCount: 1,
    }),
  }));

  assert.equal(verdict.rating, 'AVOID');
  assert.equal(signal(verdict, 'inventory-balance').verdict, 'fail');
  assert.match(verdict.summary, /Do not provide liquidity/);
  // The verdict has to name the number it is contradicting, or a reader cannot
  // tell it apart from a dashboard that simply disagrees.
  assert.match(signal(verdict, 'inventory-balance').evidence['claimed TVL'] ?? '', /3\.20B/);
});

test('a pool whose TVL is unreachable by a trade fails depth-vs-TVL', () => {
  const verdict = assess(input({
    pool: pool({ totalValueLockedUSD: 3_200_000_000 }),
    depth: depth({
      rungs: [
        { notionalUSD: 1_000, amountIn: 1_000, amountOut: 0.000027, executedRate: 2.7e-8, ticksCrossed: 1 },
        { notionalUSD: 10_000, amountIn: 10_000, amountOut: 0.000027, executedRate: 2.7e-9, ticksCrossed: 1 },
        { notionalUSD: 100_000, amountIn: 100_000, amountOut: 0.000027, executedRate: 2.7e-10, ticksCrossed: 1 },
      ],
    }),
  }));

  assert.equal(signal(verdict, 'depth-vs-tvl').verdict, 'fail');
  assert.equal(verdict.rating, 'AVOID');
});

test('a slippage cliff off a zero-slippage rung is caught (ratio test alone misses it)', () => {
  // 0.000% -> 90% has an infinite ratio, so the divide-by-zero guard skips it.
  // Found against the live TRUMP/WETH pool, where the curve was reported as
  // "scaling smoothly" while collapsing between $1k and $10k.
  const verdict = assess(input({
    depth: depth({
      rungs: [
        { notionalUSD: 1_000, amountIn: 1_000, amountOut: 0.000027, executedRate: 2.7e-8, ticksCrossed: 1 },
        { notionalUSD: 10_000, amountIn: 10_000, amountOut: 0.000027, executedRate: 2.7e-9, ticksCrossed: 1 },
        { notionalUSD: 100_000, amountIn: 100_000, amountOut: 0.000027, executedRate: 2.7e-10, ticksCrossed: 1 },
      ],
    }),
  }));

  const curve = signal(verdict, 'slippage-curve');
  assert.equal(curve.verdict, 'warn');
  assert.match(curve.headline, /Liquidity runs out between \$1\.0k and \$10\.0k/);
});

test('sparse hourly snapshots are measured against elapsed hours, not row count', () => {
  // Three snapshots spanning a day is a dead pool. Counting rows reports
  // "3 of 3 hours traded, 100%" — the bug this pins.
  const sparse: HourlyBucket[] = [
    { hour: HEAD_HOUR - 2, timestamp: HEAD_TS - 7_200, volumeUSD: 0.25, totalValueLockedUSD: 3.2e9, supplySideRevenueUSD: 0.00075 },
    { hour: HEAD_HOUR - 12, timestamp: HEAD_TS - 43_200, volumeUSD: 0.44, totalValueLockedUSD: 3.2e9, supplySideRevenueUSD: 0.0013 },
    { hour: HEAD_HOUR - 20, timestamp: HEAD_TS - 72_000, volumeUSD: 0.85, totalValueLockedUSD: 3.2e9, supplySideRevenueUSD: 0.0025 },
  ];
  const verdict = assess(input({ pool: pool({ hourly: sparse, totalValueLockedUSD: 3.2e9 }) }));
  const continuity = signal(verdict, 'activity-continuity');

  assert.equal(continuity.verdict, 'fail');
  assert.equal(continuity.evidence['hours elapsed in window'], '24');
  assert.match(continuity.evidence['hours with volume'] ?? '', /^3 /);
});

test('a pool with older history but nothing in the window fails, and says why', () => {
  const stale: HourlyBucket[] = [
    { hour: HEAD_HOUR - 40, timestamp: HEAD_TS - 144_000, volumeUSD: 1_000, totalValueLockedUSD: 1e6, supplySideRevenueUSD: 3 },
  ];
  const verdict = assess(input({ pool: pool({ hourly: stale }) }));
  const continuity = signal(verdict, 'activity-continuity');

  assert.equal(continuity.verdict, 'fail');
  assert.match(continuity.headline, /though the pool does have older history/);
  assert.equal(continuity.evidence['snapshots in window'], '0');
});

test('no live quote is reported as unknown, never as a pass', () => {
  const verdict = assess(input({ depth: null }));

  assert.equal(signal(verdict, 'executable-depth').verdict, 'unknown');
  assert.equal(signal(verdict, 'depth-vs-tvl').verdict, 'unknown');
  // Two structural questions unanswered is a no-answer, not a cautious yes.
  assert.equal(verdict.rating, 'INSUFFICIENT_DATA');
  assert.equal(verdict.provenance.depthProvider, null);
  assert.ok(verdict.caveats.some((c) => /live quote/i.test(c)));
});

test('an unpriced token side is unknown, not zero', () => {
  const verdict = assess(input({
    pool: pool({
      tokens: [
        { address: '0xa', symbol: 'WETH', decimals: 18, priceUSD: 2_500, balance: 10_000, balanceUSD: 25_000_000 },
        { address: '0xb', symbol: 'MYSTERY', decimals: 18, priceUSD: null, balance: 1_000_000, balanceUSD: null },
      ],
    }),
  }));

  assert.equal(signal(verdict, 'inventory-balance').verdict, 'unknown');
  assert.ok(verdict.caveats.some((c) => c.includes('MYSTERY')));
});

test('subgraph lag lowers confidence and is stated, but never fails a pool', () => {
  const fresh = assess(input());
  const stale = assess(input({ now: HEAD_TS + 13 * 86_400 }));

  assert.equal(stale.rating, fresh.rating, 'lag must not change the rating');
  assert.ok(stale.confidence < fresh.confidence);
  assert.match(stale.summary, /behind the chain head/);
  assert.ok(stale.caveats.some((c) => /behind the chain head/.test(c)));
});

test('a single open position is called out as one participant\'s inventory', () => {
  const verdict = assess(input({ pool: pool({ openPositionCount: 1, positionCount: 1 }) }));
  assert.equal(signal(verdict, 'lp-concentration').verdict, 'fail');
  // Non-structural: it is a reason to be careful, not proof the venue is fake.
  assert.equal(signal(verdict, 'lp-concentration').structural, false);
  assert.equal(verdict.rating, 'CAUTION');
});

test('every signal carries the evidence its headline rests on', () => {
  const verdict = assess(input());
  for (const s of verdict.signals) {
    assert.ok(s.headline.length > 0, `${s.id} has no headline`);
    assert.ok(s.reasoning.length > 0, `${s.id} has no reasoning`);
    if (s.verdict !== 'unknown') {
      assert.ok(Object.keys(s.evidence).length > 0, `${s.id} asserts without evidence`);
    }
  }
});

test('assess is pure: same input, same output, and it never reads a clock', () => {
  const one = input();
  const first = assess(one);
  const second = assess(one);
  assert.deepEqual(first, second);

  // `now` is the only source of time. If a clock crept in, freezing the input
  // and moving the wall clock would change the answer; it cannot here, but the
  // assertion documents the contract for whoever edits scoring.ts next.
  assert.equal(first.provenance.assessedAt, one.now);
  assert.equal(JSON.stringify(first), JSON.stringify(assess(structuredClone(one))));
});

test('a pool younger than the window is not blamed for hours before it existed', () => {
  // The denominator is elapsed time since creation, not the full window. A pool
  // five hours old that traded in four of them is continuous, not 4/24 dead.
  const verdict = assess(input({
    pool: pool({
      createdTimestamp: HEAD_TS - 5 * 3600,
      hourly: hourly(4),
    }),
  }));
  const continuity = signal(verdict, 'activity-continuity');

  assert.equal(continuity.verdict, 'pass');
  assert.equal(continuity.evidence['hours elapsed in window'], '6');
});

test('two sides sharing a symbol stay two rows, with addresses and decimals', () => {
  // The real trap: a fake 18-decimal "USDT" paired with the real 6-decimal one,
  // ranked #1 by TVL on our subgraph at $1.9 trillion. Keying evidence by
  // symbol collapsed it to a single row and hid the impersonation.
  const verdict = assess(input({
    pool: pool({
      name: 'Uniswap v3 USDT/USDT 1%',
      tokens: [
        { address: '0x83cff3334e2d00d98416ad72fc383b77a242e169', symbol: 'USDT', decimals: 18, priceUSD: 0.9727, balance: 2e12, balanceUSD: 1_945_562_628_312 },
        { address: '0xdac17f958d2ee523a2206206994597c13d831ec7', symbol: 'USDT', decimals: 6, priceUSD: 1, balance: 0, balanceUSD: 0 },
      ],
      totalValueLockedUSD: 1_945_562_628_312,
      openPositionCount: 1,
      positionCount: 1,
    }),
  }));
  const balance = signal(verdict, 'inventory-balance');

  assert.equal(balance.verdict, 'fail');
  assert.ok(balance.evidence['USDT side (0x83cf…e169)']?.includes('18 decimals'));
  assert.ok(balance.evidence['USDT side (0xdac1…1ec7)']?.includes('6 decimals'));
  assert.equal(verdict.rating, 'AVOID');
});

test('quoted rungs that all revert leave no curve to read, and say so once', () => {
  const verdict = assess(input({
    depth: depth({
      rungs: [
        { notionalUSD: 1_000, amountIn: 1_000, amountOut: null, executedRate: null, ticksCrossed: null, error: 'Execution reverted' },
        { notionalUSD: 10_000, amountIn: 10_000, amountOut: null, executedRate: null, ticksCrossed: null, error: 'Execution reverted' },
        { notionalUSD: 100_000, amountIn: 100_000, amountOut: null, executedRate: null, ticksCrossed: null, error: 'Execution reverted' },
      ],
    }),
  }));

  assert.equal(signal(verdict, 'executable-depth').verdict, 'fail');
  // Not a second failure for the same fact.
  assert.equal(signal(verdict, 'slippage-curve').verdict, 'unknown');
  assert.equal(verdict.rating, 'AVOID');
});
