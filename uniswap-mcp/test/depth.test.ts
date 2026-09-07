import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { estimateMaxSizeWithin, ladderFor } from '../src/depth.ts';
import type { DepthRung } from '../src/depth.ts';
import { explainQuoterRevert } from '../src/quotes.ts';

function rung(amountIn: number, priceImpact: number | null, filled = true): DepthRung {
  return {
    amountIn,
    amountOut: filled ? String(amountIn) : null,
    executedPrice: filled ? 1 : null,
    priceImpact,
    initializedTicksCrossed: filled ? 1 : null,
    gasEstimate: null,
    filled,
  };
}

describe('ladderFor', () => {
  test('multiplies the base by decades by default', () => {
    assert.deepEqual(ladderFor({ baseAmountIn: 2 } as never), [2, 20, 200, 2000, 20000]);
  });

  test('an explicit ladder is sorted ascending and cleaned', () => {
    // Order matters: impact is measured against the smallest filling rung, so
    // an unsorted ladder would pick an arbitrary reference.
    assert.deepEqual(
      ladderFor({ amountsIn: [100, 1, Number.NaN, -5, 10] } as never),
      [1, 10, 100],
    );
  });

  test('defaults to a base of 1 when nothing is given', () => {
    assert.deepEqual(ladderFor({} as never), [1, 10, 100, 1000, 10000]);
  });
});

describe('estimateMaxSizeWithin', () => {
  test('interpolates between the last rung inside the budget and the first outside', () => {
    // 1% budget; 100 is at 0.5% and 1000 is at 1.5%, so the crossing is half
    // way along in linear space: 100 + 0.5 * 900.
    const result = estimateMaxSizeWithin([rung(100, 0.005), rung(1000, 0.015)], 0.01);
    assert.equal(result?.interpolated, true);
    // Compared with a tolerance: the arithmetic is in doubles and lands on
    // 550.0000000000001. Pinning the exact bit pattern would make this test
    // fail on a change that does not affect any caller.
    assert.ok(Math.abs((result?.amountIn ?? 0) - 550) < 1e-9, `got ${result?.amountIn}`);
  });

  test('reports "at least the largest rung" when the ladder never leaves the budget', () => {
    // The distinction matters: this is not a measured edge, it is a ladder that
    // did not reach one, and marking it interpolated would overstate it.
    const result = estimateMaxSizeWithin([rung(1, 0), rung(10, 0.001)], 0.01);
    assert.deepEqual(result, { slippage: 0.01, amountIn: 10, interpolated: false });
  });

  test('returns a null size when even the smallest rung blows the budget', () => {
    const result = estimateMaxSizeWithin([rung(1, 0.2), rung(10, 0.5)], 0.01);
    assert.deepEqual(result, { slippage: 0.01, amountIn: null, interpolated: false });
  });

  test('returns null when nothing filled at all', () => {
    assert.equal(estimateMaxSizeWithin([rung(1, null, false)], 0.01), null);
  });

  test('ignores rungs that did not fill', () => {
    const result = estimateMaxSizeWithin(
      [rung(1, 0), rung(10, 0.002), rung(100, null, false)],
      0.01,
    );
    assert.equal(result?.amountIn, 10);
    assert.equal(result?.interpolated, false);
  });

  test('does not divide by zero when two rungs report the same impact', () => {
    const result = estimateMaxSizeWithin([rung(1, 0.02), rung(10, 0.02)], 0.01);
    assert.ok(result);
    assert.ok(!Number.isNaN(result.amountIn ?? 0));
  });
});

describe('explainQuoterRevert', () => {
  test('expands the opaque "Unexpected error" into its actual candidate causes', () => {
    const out = explainQuoterRevert('Execution reverted with reason: Unexpected error.');
    assert.match(out, /no pool at this fee tier/);
    assert.match(out, /zero liquidity/);
    assert.match(out, /tokenIn == tokenOut/);
    assert.match(out, /find_pools/);
  });

  test('passes a reason that already says something through unchanged', () => {
    assert.equal(explainQuoterRevert('HTTP request failed'), 'HTTP request failed');
  });
});
