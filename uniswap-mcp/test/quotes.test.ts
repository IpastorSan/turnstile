// Quoter and pool-discovery behaviour against a stubbed client.
//
// The stub returns encoded return data through the same viem decode path the
// real client would, so what is being tested is this module's handling of the
// quoter's contract — including the parts that only appear on failure, which is
// where the interesting behaviour is. No network.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, parseAbiParameters } from 'viem';
import type { PublicClient } from 'viem';

import { CHAINS } from '../src/chains.ts';
import { quoteV3 } from '../src/quotes.ts';
import { findPools } from '../src/pools.ts';
import { profileDepth } from '../src/depth.ts';
import { clearTokenCache } from '../src/tokens.ts';
import type { TokenInfo } from '../src/tokens.ts';

const mainnet = CHAINS.mainnet!;

const WETH: TokenInfo = {
  address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, warnings: [],
};
const USDC: TokenInfo = {
  address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  symbol: 'USDC', name: 'USD Coin', decimals: 6, warnings: [],
};

/** Encodes a QuoterV2 return tuple the way the real contract would. */
function quoterReturn(amountOut: bigint, ticksCrossed: number, gas = 100_000n): `0x${string}` {
  return encodeAbiParameters(
    parseAbiParameters('uint256, uint160, uint32, uint256'),
    [amountOut, 0n, ticksCrossed, gas],
  );
}

interface StubOptions {
  blockNumber?: bigint;
  /** Keyed by amountIn raw value; a string value is thrown as a revert reason. */
  quotes?: Map<bigint, { data: `0x${string}` } | string>;
}

function stubClient(options: StubOptions = {}): PublicClient {
  return {
    getBlockNumber: async () => options.blockNumber ?? 20_000_000n,
    call: async ({ data }: { data: `0x${string}` }) => {
      // The amountIn is the third word of the encoded struct argument, after
      // the 4-byte selector: tokenIn, tokenOut, amountIn.
      const body = data.slice(10);
      const amountIn = BigInt(`0x${body.slice(128, 192)}`);
      const configured = options.quotes?.get(amountIn);
      if (typeof configured === 'string') throw new Error(configured);
      if (!configured) throw new Error('Execution reverted with reason: Unexpected error.');
      return configured;
    },
  } as unknown as PublicClient;
}

beforeEach(() => clearTokenCache());

describe('quoteV3', () => {
  test('decodes a successful quote and surfaces initializedTicksCrossed', async () => {
    const quotes = new Map<bigint, { data: `0x${string}` }>([
      [10n ** 18n, { data: quoterReturn(2_477_420_516n, 3) }],
    ]);
    const result = await quoteV3(stubClient({ quotes }), mainnet, {
      tokenIn: WETH, tokenOut: USDC, feeTier: 500, amountIn: 1,
    });

    assert.equal(result.error, undefined);
    assert.equal(result.amountOut, '2477.420516');
    assert.equal(result.amountOutRaw, '2477420516');
    assert.equal(result.initializedTicksCrossed, 3);
    assert.equal(result.gasEstimate, '100000');
    assert.equal(result.version, 'v3');
    assert.equal(result.atBlock, 20_000_000);
    // Output is scaled by tokenOut's decimals (6), not tokenIn's (18).
    assert.ok(Math.abs(result.executedPrice! - 2477.420516) < 1e-6);
  });

  test('an amount that rounds to zero raw units is refused before the call', async () => {
    let called = false;
    const client = {
      getBlockNumber: async () => 1n,
      call: async () => { called = true; return { data: '0x' }; },
    } as unknown as PublicClient;

    const result = await quoteV3(client, mainnet, {
      tokenIn: USDC, tokenOut: WETH, feeTier: 500, amountIn: 1e-9,
    });
    assert.equal(called, false, 'should not spend an RPC call on an amount of zero');
    assert.match(result.error!, /rounds to zero raw units at 6 decimals/);
    assert.equal(result.amountOut, null);
  });

  test('a revert is returned as a result, not thrown, and the opaque reason is expanded', async () => {
    // A reverting quote is a finding — "this pool cannot fill that size" — so
    // it must not abort a ladder that is trying to locate exactly that edge.
    const result = await quoteV3(stubClient(), mainnet, {
      tokenIn: WETH, tokenOut: USDC, feeTier: 500, amountIn: 1,
    });
    assert.equal(result.amountOut, null);
    assert.match(result.error!, /Unexpected error/);
    assert.match(result.error!, /no pool at this fee tier/);
  });

  test('pins to a caller-supplied block instead of reading a new one', async () => {
    let blockReads = 0;
    const quotes = new Map<bigint, { data: `0x${string}` }>([
      [10n ** 18n, { data: quoterReturn(1n, 0) }],
    ]);
    const inner = stubClient({ quotes });
    const client = {
      ...inner,
      getBlockNumber: async () => { blockReads += 1; return 20_000_000n; },
      call: inner.call,
    } as unknown as PublicClient;

    const result = await quoteV3(client, mainnet, {
      tokenIn: WETH, tokenOut: USDC, feeTier: 500, amountIn: 1, blockNumber: 19_000_000n,
    });
    assert.equal(blockReads, 0);
    assert.equal(result.atBlock, 19_000_000);
  });
});

describe('profileDepth', () => {
  test('quotes every rung at one block and builds the impact curve from the smallest fill', async () => {
    // A ladder priced at 2500, 2450, 2000 per unit: impact is measured against
    // the first rung, so it should read 0, 2%, 20%.
    const quotes = new Map<bigint, { data: `0x${string}` }>([
      [10n ** 18n, { data: quoterReturn(2_500_000_000n, 1) }],
      [10n ** 19n, { data: quoterReturn(24_500_000_000n, 12) }],
      [10n ** 20n, { data: quoterReturn(200_000_000_000n, 140) }],
    ]);
    let blockReads = 0;
    const inner = stubClient({ quotes });
    const client = {
      call: inner.call,
      getBlockNumber: async () => { blockReads += 1; return 20_000_000n; },
    } as unknown as PublicClient;

    const profile = await profileDepth(client, mainnet, {
      tokenIn: WETH, tokenOut: USDC, feeTier: 500, amountsIn: [1, 10, 100],
    });

    assert.equal(blockReads, 1, 'the whole ladder must be one block, or it measures drift');
    assert.equal(profile.rungs.length, 3);
    assert.equal(profile.referenceAmountIn, 1);
    assert.ok(Math.abs(profile.referencePrice! - 2500) < 1e-9);
    assert.ok(Math.abs(profile.rungs[0]!.priceImpact! - 0) < 1e-12);
    assert.ok(Math.abs(profile.rungs[1]!.priceImpact! - 0.02) < 1e-9);
    assert.ok(Math.abs(profile.rungs[2]!.priceImpact! - 0.2) < 1e-9);
    assert.deepEqual(profile.rungs.map((r) => r.initializedTicksCrossed), [1, 12, 140]);
    assert.equal(profile.maxFillableAmountIn, 100);
    // The tick walk should be called out, since it is the mechanical reading.
    assert.ok(profile.notes.some((n) => /initializedTicksCrossed goes 1 -> 140/.test(n)));
  });

  test('a rung that cannot fill is recorded and the walk continues past it', async () => {
    const quotes = new Map<bigint, { data: `0x${string}` } | string>([
      [10n ** 18n, { data: quoterReturn(2_500_000_000n, 1) }],
      // 10 reverts, 100 does not: the walk must not stop at the first failure.
      [10n ** 20n, { data: quoterReturn(200_000_000_000n, 140) }],
    ]);
    const profile = await profileDepth(stubClient({ quotes }), mainnet, {
      tokenIn: WETH, tokenOut: USDC, feeTier: 500, amountsIn: [1, 10, 100],
    });

    assert.deepEqual(profile.rungs.map((r) => r.filled), [true, false, true]);
    assert.equal(profile.maxFillableAmountIn, 100);
    assert.ok(profile.notes.some((n) => /1 of 3 sizes could not fill/.test(n)));
  });

  test('reports no curve at all rather than a fabricated one when nothing fills', async () => {
    const profile = await profileDepth(stubClient(), mainnet, {
      tokenIn: WETH, tokenOut: USDC, feeTier: 500, amountsIn: [1, 10],
    });
    assert.equal(profile.referencePrice, null);
    assert.equal(profile.maxFillableAmountIn, null);
    assert.equal(profile.maxSizeWithinSlippage, null);
    assert.ok(profile.notes.some((n) => /No rung filled/.test(n)));
  });
});

describe('findPools', () => {
  const ZERO = '0x0000000000000000000000000000000000000000';

  function poolClient(pools: Record<number, string>): PublicClient {
    return {
      getBlockNumber: async () => 20_000_000n,
      readContract: async ({ functionName, args, address }: {
        functionName: string; args?: readonly unknown[]; address: string;
      }) => {
        if (functionName === 'getPool') return pools[Number(args![2])] ?? ZERO;
        if (functionName === 'token0') return USDC.address;
        if (functionName === 'liquidity') return address.endsWith('dead') ? 0n : 12_345n;
        if (functionName === 'slot0') return [2n ** 96n, 100, 0, 0, 0, 0, true];
        throw new Error(`unexpected call ${functionName}`);
      },
    } as unknown as PublicClient;
  }

  test('separates tiers that do not exist from tiers that exist but are empty', async () => {
    // These are different findings with different fixes, and QuoterV2 reports
    // both with the same opaque revert string — which is why this tool exists.
    const result = await findPools(
      poolClient({
        500: '0x1111111111111111111111111111111111111111',
        3000: '0x000000000000000000000000000000000000dead',
      }),
      mainnet, WETH, USDC,
    );

    assert.deepEqual(result.missingTiers, [100, 10_000]);
    assert.equal(result.pools.length, 2);
    const live = result.pools.find((p) => p.feeTier === 500)!;
    const empty = result.pools.find((p) => p.feeTier === 3000)!;
    assert.equal(live.empty, false);
    assert.equal(live.feeLabel, '0.05%');
    assert.equal(live.tick, 100);
    assert.equal(empty.empty, true);
    assert.ok(result.notes.length >= 0);
  });

  test('warns when every existing pool is empty', async () => {
    const result = await findPools(
      poolClient({ 500: '0x000000000000000000000000000000000000dead' }),
      mainnet, WETH, USDC,
    );
    assert.ok(result.notes.some((n) => /zero in-range liquidity/.test(n)), result.notes.join('\n'));
    assert.ok(result.notes.some((n) => /an empty pool is not a cheap pool/.test(n)));
  });

  test('says so plainly when the pair has no pool at any tier', async () => {
    const result = await findPools(poolClient({}), mainnet, WETH, USDC);
    assert.equal(result.pools.length, 0);
    assert.deepEqual(result.missingTiers, [100, 500, 3000, 10_000]);
    assert.ok(result.notes.some((n) => /no pool for this pair/.test(n)));
  });

  test('maps decimals to the pool\'s own token ordering, not the argument order', async () => {
    // USDC is token0 in the stub. Passing WETH first must still price with
    // decimals0=6, decimals1=18 — getting this backwards moves the price by
    // 10^12 and still looks like a number.
    const result = await findPools(
      poolClient({ 500: '0x1111111111111111111111111111111111111111' }),
      mainnet, WETH, USDC,
    );
    const pool = result.pools[0]!;
    assert.equal(pool.token0.toLowerCase(), USDC.address.toLowerCase());
    // sqrtPriceX96 == 2^96 is a raw ratio of 1; adjusted by 10^(6-18).
    assert.ok(Math.abs(pool.price0In1! - 1e-12) < 1e-24, `got ${pool.price0In1}`);
  });
});
