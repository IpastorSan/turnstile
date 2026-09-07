// Decimal <-> raw integer conversion.
//
// Small file, disproportionate importance: this is where a quoting tool most
// easily goes silently wrong. `BigInt(whole * 10 ** decimals)` overflows a
// double at around 1e21 and, for an 18-decimal token, that is reached by an
// amount as small as a few thousand — the multiplication produces a float that
// has already lost its low digits, and `BigInt()` then converts the *rounded*
// value without complaint. The result is a quote for not quite the amount you
// asked about, which is indistinguishable from a correct quote.
//
// Going through a fixed-point string instead keeps every digit.

export function toRawAmount(whole: number, decimals: number): bigint {
  if (!Number.isFinite(whole) || whole < 0) {
    throw new RangeError(`amount must be a non-negative finite number, got ${whole}`);
  }
  const [integer, fraction] = splitDecimal(whole);
  const padded = (fraction + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(integer) * 10n ** BigInt(decimals) + BigInt(padded || '0');
}

/**
 * A number as an exact pair of digit strings, via its shortest round-tripping
 * decimal form.
 *
 * The obvious implementation is `whole.toFixed(decimals)`, and it is wrong in
 * both directions at once:
 *
 *   - For a small value it *invents* digits. `(0.1).toFixed(18)` is
 *     `"0.100000000000000006"`, because 0.1 is not representable in binary and
 *     toFixed(18) prints what the double really holds. Scaling that gives
 *     100000000000000006 raw units for an amount the caller wrote as 0.1.
 *   - For a large value it silently caps: the `Math.min(decimals, 18)` such
 *     implementations need in order to stay inside toFixed's range truncates a
 *     token with more than 18 decimals.
 *
 * `String(n)` gives the shortest decimal that round-trips to the same double —
 * `"0.1"` for 0.1 — which is the digit sequence the caller meant. The only
 * complication is that it switches to exponent notation outside roughly 1e-7 to
 * 1e21, so that form is expanded here rather than fed to a parser that would
 * read the `e` as a digit.
 */
function splitDecimal(value: number): [integer: string, fraction: string] {
  const s = String(value);
  const e = s.indexOf('e');
  if (e < 0) {
    const [i = '0', f = ''] = s.split('.');
    return [i, f];
  }
  const exponent = Number(s.slice(e + 1));
  const [mantissaInt = '0', mantissaFrac = ''] = s.slice(0, e).split('.');
  const digits = mantissaInt + mantissaFrac;
  // The decimal point starts after the mantissa's integer digits and moves by
  // the exponent.
  const point = mantissaInt.length + exponent;
  if (point <= 0) return ['0', '0'.repeat(-point) + digits];
  if (point >= digits.length) return [digits + '0'.repeat(point - digits.length), ''];
  return [digits.slice(0, point), digits.slice(point)];
}

/**
 * Raw integer to a JS number.
 *
 * Split into whole and fractional parts before touching a double, so a large
 * 18-decimal balance does not lose its integer digits to the exponent. Above
 * ~9e15 the result is still lossy — it is a double — but it is lossy in the
 * last few digits rather than wrong by orders of magnitude. Anything that must
 * be exact should stay a bigint; this is for display and for ratios.
 */
export function fromRawAmount(raw: bigint, decimals: number): number {
  const scale = 10n ** BigInt(decimals);
  return Number(raw / scale) + Number(raw % scale) / Number(scale);
}

/** Exact decimal string, for output that must not be a lossy double. */
export function formatRawAmount(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const scale = 10n ** BigInt(decimals);
  const whole = (abs / scale).toString();
  if (decimals === 0) return (negative ? '-' : '') + whole;
  const fraction = (abs % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return (negative ? '-' : '') + whole + (fraction ? `.${fraction}` : '');
}

/**
 * Uniswap v3's `sqrtPriceX96` to a price of token0 in units of token1.
 *
 * Done in bigint with a fixed scale rather than `Number(sqrtPriceX96) ** 2`,
 * because sqrtPriceX96 routinely exceeds 2^96 and squaring it as a double
 * overflows to Infinity for high-priced pairs and underflows to 0 for low ones.
 */
export function priceFromSqrtPriceX96(
  sqrtPriceX96: bigint,
  decimals0: number,
  decimals1: number,
): number {
  if (sqrtPriceX96 <= 0n) return 0;
  const SCALE = 10n ** 18n;
  // (sqrtPriceX96 / 2^96)^2, carried at 1e18.
  const numerator = sqrtPriceX96 * sqrtPriceX96 * SCALE;
  const ratio = numerator >> 192n; // 2^192, scaled by 1e18
  const decimalAdjust = 10 ** (decimals0 - decimals1);
  return (Number(ratio) / 1e18) * decimalAdjust;
}
