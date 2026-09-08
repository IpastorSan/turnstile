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
    // profile down, because until MOV-246 toRawAmount was called outside the
    // per-rung try. A $10M rung against a token priced below ~1e-14 USD reaches
    // 1e21. Both halves are fixed now: the conversion handles the value, and
    // the call site treats a throw as one failed rung.
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
    // threw here too, but as a SyntaxError from inside BigInt. Throwing is
    // correct — there is no raw amount for Infinity — and the `fetchDepth...`
    // block below is where that throw is turned into a failed rung rather than
    // a dead profile.
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

// A price the analyst cannot use must fail one rung, not the profile.
//
// `amountIn` is `notionalUSD / tokenInPriceUSD`, so a price of 0 gives Infinity
// and a price of NaN gives NaN, and `toRawAmount` rejects both. Until MOV-246
// that conversion sat above the per-rung `try`, so the RangeError escaped the
// loop and `fetchDepthFromQuoter` threw instead of returning — no rungs, no
// depth profile, no verdict.
//
// That is the wrong failure mode for this product specifically. The analyst's
// headline demo is a scam-token pool whose fake USDT declares 18 decimals
// against the real 6; badly-priced and unpriced tokens are precisely what it
// exists to catch. A pool that reverts on every rung already yields AVOID with
// the evidence intact, and an unusable price now behaves the same way.

import type { PublicClient } from 'viem';
import { encodeFunctionResult, decodeFunctionData, parseAbi } from 'viem';

import { fetchDepthFromQuoter } from './uniswap-quotes.ts';
import { assess } from './scoring.ts';
import type { AnalystInput, DepthProfile, PoolFacts } from './types.ts';

const QUOTER_ABI = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);

const AT_BLOCK = 25_925_000n;

const TOKEN_OUT = {
  address: '0x2222222222222222222222222222222222222222',
  symbol: 'WETH',
  decimals: 18,
} as const;

function tokenIn(decimals: number) {
  return { address: '0x1111111111111111111111111111111111111111', symbol: 'SCAM', decimals };
}

const LADDER = [1_000, 10_000, 100_000];

function requestAt(tokenInPriceUSD: number, notionalsUSD = LADDER, decimalsIn = 18) {
  return {
    tokenIn: tokenIn(decimalsIn),
    tokenOut: TOKEN_OUT,
    feeTier: 3000,
    tokenInPriceUSD,
    notionalsUSD,
    now: 1_787_631_581,
  };
}

/**
 * A QuoterV2 that always fills, at a flat 1 tokenOut per 2500 tokenIn. Flat and
 * always-filling is the point: a rung missing from the result is missing
 * because the analyst never asked for it, not because the pool said no, so
 * these tests measure the loop rather than the stub. The scaling is done in
 * whole-token space and re-encoded at `decimalsOut` so a rung of a couple of
 * raw input units still returns a non-zero output.
 */
function fillingQuoter(decimalsIn = 18, decimalsOut = TOKEN_OUT.decimals) {
  const amountsIn: bigint[] = [];
  const client = {
    getBlockNumber: async () => AT_BLOCK,
    call: async ({ data }: { data: `0x${string}` }) => {
      const { args } = decodeFunctionData({ abi: QUOTER_ABI, data });
      const rawIn = (args as readonly [{ amountIn: bigint }])[0].amountIn;
      amountsIn.push(rawIn);
      const rawOut = (rawIn * 10n ** BigInt(decimalsOut)) / (2500n * 10n ** BigInt(decimalsIn));
      return {
        data: encodeFunctionResult({
          abi: QUOTER_ABI,
          functionName: 'quoteExactInputSingle',
          result: [rawOut, 0n, 1, 100_000n],
        }),
      };
    },
  } as unknown as PublicClient;
  return { client, amountsIn };
}

describe('fetchDepthFromQuoter survives a price it cannot use', () => {
  test('a healthy price fills every rung — the control for the cases below', async () => {
    const { client, amountsIn } = fillingQuoter();
    const depth = await fetchDepthFromQuoter(requestAt(2), { client });

    assert.equal(depth.rungs.length, 3);
    assert.deepEqual(depth.rungs.map((r) => r.error), [undefined, undefined, undefined]);
    // $1,000 at $2 is 500 tokens; the harness quotes, it does not pretend to.
    assert.deepEqual(amountsIn, [500n * 10n ** 18n, 5_000n * 10n ** 18n, 50_000n * 10n ** 18n]);
  });

  test('a tokenInPriceUSD of 0 marks every rung failed instead of throwing', async () => {
    const { client, amountsIn } = fillingQuoter();

    // The assertion that matters is that this resolves at all. Before MOV-246
    // it rejected with a RangeError out of toRawAmount and there was no profile
    // to inspect.
    const depth = await fetchDepthFromQuoter(requestAt(0), { client });

    assert.equal(depth.rungs.length, 3, 'every rung asked for is present');
    for (const rung of depth.rungs) {
      assert.equal(rung.amountOut, null);
      assert.equal(rung.executedRate, null);
      assert.match(rung.error ?? '', /non-negative finite number, got Infinity/);
    }
    assert.deepEqual(amountsIn, [], 'no unusable amount reached the quoter');
    // The profile is otherwise whole: provenance survives, and the price that
    // broke it is carried through for the scorer to name.
    assert.equal(depth.atBlock, Number(AT_BLOCK));
    assert.equal(depth.notionalPricing.priceUSD, 0);
  });

  test('a tokenInPriceUSD of NaN does the same', async () => {
    const { client } = fillingQuoter();
    const depth = await fetchDepthFromQuoter(requestAt(Number.NaN), { client });

    assert.equal(depth.rungs.length, 3);
    for (const rung of depth.rungs) {
      assert.equal(rung.amountOut, null);
      assert.match(rung.error ?? '', /non-negative finite number, got NaN/);
    }
    assert.ok(Number.isNaN(depth.notionalPricing.priceUSD));
  });

  test('a rung the price breaks does not stop the rungs after it', async () => {
    // The direct proof that the loop keeps walking past a rung the price
    // broke. A price of $1e12 against a 6-decimal token — the shape of a pool
    // whose reported price is off by the 18-vs-6 decimals gap — puts the small
    // rungs below one raw unit while the large ones still convert, so failures
    // and fills are interleaved in one ladder.
    const { client, amountsIn } = fillingQuoter(SKEWED.decimalsIn);
    const depth = await fetchDepthFromQuoter(skewedRequest(), { client });

    assert.equal(depth.rungs.length, 4);
    assert.match(depth.rungs[0]!.error ?? '', /rounds to zero token units/);
    assert.match(depth.rungs[1]!.error ?? '', /rounds to zero token units/);
    assert.equal(depth.rungs[2]!.error, undefined);
    assert.equal(depth.rungs[3]!.error, undefined);
    assert.ok(depth.rungs[2]!.amountOut! > 0 && depth.rungs[3]!.amountOut! > 0);
    assert.equal(amountsIn.length, 2, 'only the two convertible rungs were quoted');
  });
});

/** The mispriced-token ladder: two rungs below one raw unit, two above. */
const SKEWED = {
  priceUSD: 1e12,
  decimalsIn: 6,
  notionals: [1_000, 10_000, 1_000_000, 10_000_000],
} as const;

function skewedRequest() {
  return requestAt(SKEWED.priceUSD, [...SKEWED.notionals], SKEWED.decimalsIn);
}

/** A pool shaped like the scam-token pool the demo opens on. */
function scamPool(): PoolFacts {
  const headTs = 1_787_631_581;
  return {
    address: '0x83cff3334e2d00d98416ad72fc383b77a242e169',
    name: 'Uniswap v3 SCAM/WETH 0.3%',
    protocol: 'Uniswap v3',
    network: 'MAINNET',
    tokens: [
      { ...tokenIn(18), priceUSD: null, balance: 1_000_000_000, balanceUSD: null },
      { ...TOKEN_OUT, priceUSD: 2_500, balance: 4, balanceUSD: 10_000 },
    ],
    createdTimestamp: headTs - 3 * 86_400,
    totalValueLockedUSD: 3_000_000_000,
    cumulativeVolumeUSD: 12_000,
    cumulativeSupplySideRevenueUSD: 36,
    feeTierPct: 0.3,
    positionCount: 1,
    openPositionCount: 1,
    tick: 0,
    hourly: [],
    source: {
      label: 'test',
      endpoint: 'test',
      transport: 'http',
      blockNumber: 25_831_581,
      blockTimestamp: headTs,
    },
  };
}

describe('the verdict renders on a ladder the price broke', () => {
  async function verdictFrom(request: ReturnType<typeof requestAt>) {
    const { client } = fillingQuoter(request.tokenIn.decimals);
    const depth: DepthProfile = await fetchDepthFromQuoter(request, { client });
    const input: AnalystInput = { pool: scamPool(), depth, now: 1_787_631_581 };
    return { depth, verdict: assess(input) };
  }

  test('every rung unpriced still produces a rated verdict, not an exception', async () => {
    const { verdict } = await verdictFrom(requestAt(0));

    assert.equal(verdict.rating, 'AVOID');
    const executable = verdict.signals.find((s) => s.id === 'executable-depth')!;
    assert.equal(executable.verdict, 'fail');
    // The evidence names the price that broke it and keeps every rung's reason,
    // which is the whole point of failing the rung rather than the profile.
    assert.match(executable.evidence['notional priced with'] ?? '', /SCAM at \$0\.000000/);
    for (const notional of ['$1.0k', '$10.0k', '$100.0k']) {
      assert.match(executable.evidence[notional] ?? '', /did not execute — .*finite number/);
    }

    // slippage-curve declines to double-count it, exactly as it does when the
    // quoter reverts on every rung.
    const curve = verdict.signals.find((s) => s.id === 'slippage-curve')!;
    assert.equal(curve.verdict, 'unknown');
    assert.match(curve.headline, /Only 0 of 3 quoted sizes filled/);

    assert.ok(verdict.summary.length > 0);
    assert.ok(verdict.confidence >= 0 && verdict.confidence <= 1);
  });

  test('NaN reaches the same verdict', async () => {
    const { verdict } = await verdictFrom(requestAt(Number.NaN));
    assert.equal(verdict.rating, 'AVOID');
    assert.equal(verdict.signals.find((s) => s.id === 'executable-depth')!.verdict, 'fail');
  });

  test('a partial ladder is scored on the rungs that did fill', async () => {
    // Two rungs failed on the price and two filled. The verdict is rendered
    // from the survivors rather than discarded.
    const { depth, verdict } = await verdictFrom(skewedRequest());

    assert.equal(depth.rungs.filter((r) => r.amountOut !== null).length, 2);
    const executable = verdict.signals.find((s) => s.id === 'executable-depth')!;
    assert.notEqual(executable.verdict, 'unknown');
    assert.match(executable.evidence['$1.0k'] ?? '', /did not execute/);
    assert.match(executable.evidence['$1.00M'] ?? '', /WETH, slippage/);

    // Two rungs filled, so the curve has the two points it needs and is read
    // rather than skipped — a partial ladder is scored, not discarded.
    const curve = verdict.signals.find((s) => s.id === 'slippage-curve')!;
    assert.notEqual(curve.verdict, 'unknown');
    assert.ok(verdict.summary.length > 0);
    assert.ok(verdict.caveats.length > 0, 'the verdict says what it did not get');
  });
});
