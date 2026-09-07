import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  toRawAmount,
  fromRawAmount,
  formatRawAmount,
  priceFromSqrtPriceX96,
} from '../src/amounts.ts';

describe('toRawAmount', () => {
  test('scales by decimals', () => {
    assert.equal(toRawAmount(1, 18), 1_000_000_000_000_000_000n);
    assert.equal(toRawAmount(1.5, 6), 1_500_000n);
    assert.equal(toRawAmount(0, 18), 0n);
  });

  test('is exact where the naive float multiplication has already lost digits', () => {
    // `BigInt(Math.round(1234.5678 * 1e18))` is 1234567800000000032768: the
    // multiplication happens in a double, which cannot hold that many
    // significant digits, so the low ones are gone before BigInt sees the
    // value. Checked rather than asserted in prose.
    const viaFloat = BigInt(Math.round(1234.5678 * 10 ** 18));
    assert.equal(viaFloat, 1_234_567_800_000_000_032_768n);
    assert.equal(toRawAmount(1234.5678, 18), 1_234_567_800_000_000_000_000n);
  });

  test('does not invent digits for a value that is not representable in binary', () => {
    // The trap in the other direction: (0.1).toFixed(18) is
    // "0.100000000000000006", so a toFixed-based conversion returns
    // 100000000000000006 raw units for an amount the caller wrote as 0.1.
    assert.equal((0.1).toFixed(18), '0.100000000000000006');
    assert.equal(toRawAmount(0.1, 18), 100_000_000_000_000_000n);
    assert.equal(toRawAmount(1.1, 18), 1_100_000_000_000_000_000n);
    assert.equal(toRawAmount(2.675, 18), 2_675_000_000_000_000_000n);
  });

  test('handles the exponent notation String() switches to at the extremes', () => {
    // String(1e21) is "1e+21" and String(1e-7) is "1e-7". A parser that splits
    // on "." alone reads the "e" as a digit and throws inside BigInt.
    assert.equal(toRawAmount(1e21, 18), 10n ** 39n);
    assert.equal(toRawAmount(1e-7, 18), 100_000_000_000n);
    assert.equal(toRawAmount(1.5e-7, 18), 150_000_000_000n);
    assert.equal(toRawAmount(1.234e22, 6), 12_340_000_000_000_000_000_000_000_000n);
  });

  test('supports tokens with more than 18 decimals', () => {
    // A toFixed-based implementation has to clamp at 18 to stay in range, which
    // silently truncates here.
    assert.equal(toRawAmount(1, 24), 10n ** 24n);
    assert.equal(toRawAmount(1.5, 24), 15n * 10n ** 23n);
  });

  test('a fraction below one raw unit truncates to zero rather than rounding up', () => {
    // Callers depend on this: a zero result is how they detect "this notional
    // is smaller than the token can express" instead of quoting a rounded size.
    assert.equal(toRawAmount(0.4, 0), 0n);
    assert.equal(toRawAmount(0.0000001, 6), 0n);
  });

  test('rejects negative and non-finite input instead of producing a bigint', () => {
    assert.throws(() => toRawAmount(-1, 18), RangeError);
    assert.throws(() => toRawAmount(Number.NaN, 18), RangeError);
    assert.throws(() => toRawAmount(Number.POSITIVE_INFINITY, 18), RangeError);
  });
});

describe('fromRawAmount', () => {
  test('round-trips ordinary amounts', () => {
    assert.equal(fromRawAmount(toRawAmount(1.5, 6), 6), 1.5);
    assert.equal(fromRawAmount(toRawAmount(2477.420516, 6), 6), 2477.420516);
  });

  test('keeps the integer digits of a large 18-decimal amount', () => {
    // Naive Number(raw) / 1e18 loses the integer part into the exponent.
    assert.equal(fromRawAmount(10_000_000_000_000_000_000_000n, 18), 10_000);
  });
});

describe('formatRawAmount', () => {
  test('is exact where a double would not be', () => {
    assert.equal(formatRawAmount(1_500_000n, 6), '1.5');
    assert.equal(formatRawAmount(1n, 18), '0.000000000000000001');
    assert.equal(formatRawAmount(0n, 18), '0');
    assert.equal(formatRawAmount(1_000_000n, 6), '1');
  });

  test('handles zero-decimal tokens and negatives', () => {
    assert.equal(formatRawAmount(42n, 0), '42');
    assert.equal(formatRawAmount(-1_500_000n, 6), '-1.5');
  });
});

describe('priceFromSqrtPriceX96', () => {
  test('a sqrt price of exactly 2^96 is a raw ratio of 1', () => {
    const Q96 = 2n ** 96n;
    assert.equal(priceFromSqrtPriceX96(Q96, 18, 18), 1);
  });

  test('applies the decimal adjustment between differently-scaled tokens', () => {
    // Same raw ratio, but token0 has 12 more decimals than token1, so the
    // human-readable price is 1e12 larger.
    const Q96 = 2n ** 96n;
    assert.equal(priceFromSqrtPriceX96(Q96, 18, 6), 1e12);
  });

  test('does not overflow on a sqrt price far above 2^96', () => {
    // Squaring this as a double is where the naive implementation returns
    // Infinity. The bigint path must return a finite number.
    const big = 2n ** 120n;
    const price = priceFromSqrtPriceX96(big, 18, 18);
    assert.ok(Number.isFinite(price), `expected finite, got ${price}`);
    assert.ok(price > 0);
  });

  test('a zero or negative sqrt price is zero rather than NaN', () => {
    assert.equal(priceFromSqrtPriceX96(0n, 18, 18), 0);
  });
});
