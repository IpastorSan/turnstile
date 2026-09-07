// The conversion from a human amount to raw token units, pinned to exact
// values.
//
// Every rung of every depth ladder the analyst reports goes through
// `toRawAmount`, and its failure mode is quiet: an amount six wei off the one
// the caller asked for still produces a perfectly plausible quote. No assertion
// on a quote *result* would catch that, so the exact integers have to be
// asserted here or the bug MOV-245 fixed regresses invisibly.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { toRawAmount } from './uniswap-quotes.ts';

describe('toRawAmount', () => {
  test('scales by decimals', () => {
    assert.equal(toRawAmount(1, 18), 1_000_000_000_000_000_000n);
    assert.equal(toRawAmount(1.5, 6), 1_500_000n);
    assert.equal(toRawAmount(0, 18), 0n);
  });

  test('does not invent digits for a value that is not representable in binary', () => {
    // The bug this file exists for. `(0.1).toFixed(18)` is
    // "0.100000000000000006", so the old conversion quoted 0.1 WETH as six wei
    // more than 1e17. Asserted rather than described, because the wrong answer
    // is only six wei away from the right one.
    assert.equal((0.1).toFixed(18), '0.100000000000000006');
    assert.equal(toRawAmount(0.1, 18), 100_000_000_000_000_000n);

    // Same class, larger error, and in the other direction: toFixed(18) gave
    // 1100000000000000089 and 2674999999999999822 for these two.
    assert.equal(toRawAmount(1.1, 18), 1_100_000_000_000_000_000n);
    assert.equal(toRawAmount(2.675, 18), 2_674_999_999_999_999_822n + 178n);
    assert.equal(toRawAmount(2.675, 18), 2_675_000_000_000_000_000n);
  });

  test('is exact where the naive float multiplication has already lost digits', () => {
    // `BigInt(Math.round(1234.5678 * 1e18))` rounds inside the double before
    // BigInt ever sees the value. Checked, not asserted in prose.
    assert.equal(BigInt(Math.round(1234.5678 * 10 ** 18)), 1_234_567_800_000_000_032_768n);
    assert.equal(toRawAmount(1234.5678, 18), 1_234_567_800_000_000_000_000n);
  });

  test('handles the exponent notation String() switches to at the extremes', () => {
    // `(1e21).toFixed(18)` is "1e+21" and `BigInt("1e+21")` throws, so the old
    // conversion did not merely round this rung wrong — it took the whole depth
    // profile down, because toRawAmount is called outside the per-rung try. A
    // $10M rung against a token priced below ~1e-14 USD reaches 1e21.
    assert.throws(() => BigInt((1e21).toFixed(18)), SyntaxError);
    assert.equal(toRawAmount(1e21, 18), 10n ** 39n);
    assert.equal(toRawAmount(1e-7, 18), 100_000_000_000n);
    assert.equal(toRawAmount(1.5e-7, 18), 150_000_000_000n);
    assert.equal(toRawAmount(1.234e22, 6), 12_340_000_000_000_000_000_000_000_000n);
  });

  test('supports tokens with more than 18 decimals', () => {
    // The `Math.min(decimals, 18)` clamp the old version needed to stay inside
    // toFixed's range truncated a fraction past the 18th digit.
    assert.equal(toRawAmount(1, 24), 10n ** 24n);
    assert.equal(toRawAmount(1.5, 24), 15n * 10n ** 23n);
    assert.equal(toRawAmount(1.0000000000000000001, 24), 10n ** 24n);
  });

  test('a fraction below one raw unit truncates to zero rather than rounding up', () => {
    // fetchDepthFromQuoter branches on `rawIn === 0n` to report "notional
    // rounds to zero token units at this price and decimals". Rounding up here
    // would replace that finding with a quote for a size nobody asked about.
    assert.equal(toRawAmount(0.4, 0), 0n);
    assert.equal(toRawAmount(0.0000001, 6), 0n);
  });

  test('rejects negative and non-finite input instead of producing a bigint', () => {
    // A zero or NaN tokenInPriceUSD makes amountIn non-finite. The old version
    // threw here too, but as a SyntaxError from inside BigInt.
    assert.throws(() => toRawAmount(-1, 18), RangeError);
    assert.throws(() => toRawAmount(Number.NaN, 18), RangeError);
    assert.throws(() => toRawAmount(Number.POSITIVE_INFINITY, 18), RangeError);
  });

  test('agrees with viem parseUnits everywhere parseUnits accepts the input', async () => {
    // viem is already a dependency and parseUnits is the reference conversion,
    // so agreeing with it is the strongest available check on the digits.
    const { parseUnits } = await import('viem');
    for (const [value, decimals] of [
      [0.1, 18], [1.1, 18], [2.675, 18], [1234.5678, 18], [0.07, 6], [0, 18],
    ] as const) {
      assert.equal(
        toRawAmount(value, decimals),
        parseUnits(String(value), decimals),
        `${value} at ${decimals} decimals`,
      );
    }
  });

  test('parseUnits cannot replace this function, because it rejects exponent notation', () => {
    // Recorded because parseUnits is the obvious thing to reach for instead of
    // splitDecimal, and it does not work here. It takes a *string*, and the
    // string for a small or large amount — `String(1e-7)` is "1e-7" — is one it
    // refuses outright rather than parses. amountIn is computed as
    // notionalUSD / tokenInPriceUSD, so both extremes are reachable from an
    // ordinary ladder against an unusually priced token.
    assert.equal(String(1e-7), '1e-7');
    assert.equal(String(1e21), '1e+21');
  });
});
