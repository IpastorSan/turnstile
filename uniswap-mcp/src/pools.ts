// Pool discovery, straight from the v3 factory.
//
// The factory is the only authoritative answer to "does this pool exist". A
// hardcoded pool list goes stale, a subgraph is minutes-to-days behind, and
// both will happily omit a pool that exists. `getPool` is a single view call
// and cannot be wrong about the chain it is called on.
//
// The interesting output is not "here is the address" but "here is which of the
// four fee tiers actually exist, and which of those have any liquidity at all".
// A pool can exist with zero liquidity — it was created and never funded, or it
// was drained — and it quotes as a revert rather than as a zero. Reporting the
// tier list with `liquidity` attached lets a caller pick the tier that will
// actually fill before spending a quote on one that cannot.

import { parseAbi } from 'viem';
import type { PublicClient } from 'viem';

import type { ChainConfig } from './chains.ts';
import { priceFromSqrtPriceX96 } from './amounts.ts';
import { reasonOf } from './tokens.ts';
import type { TokenInfo } from './tokens.ts';

const FACTORY_ABI = parseAbi([
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
]);

const POOL_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function liquidity() view returns (uint128)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
]);

/** The four canonical v3 fee tiers, in hundredths of a bip. */
export const V3_FEE_TIERS = [100, 500, 3000, 10_000] as const;

export const FEE_TIER_LABELS: Record<number, string> = {
  100: '0.01%',
  500: '0.05%',
  3000: '0.30%',
  10000: '1.00%',
};

export function feeLabel(fee: number): string {
  return FEE_TIER_LABELS[fee] ?? `${fee / 10_000}%`;
}

export interface PoolInfo {
  feeTier: number;
  feeLabel: string;
  address: `0x${string}`;
  explorerUrl: string;
  /** token0/token1 as the pool orders them, which is by address, not by argument order. */
  token0: `0x${string}`;
  token1: `0x${string}`;
  /** In-range liquidity as a decimal string. Virtual units, not a token balance. */
  activeLiquidity: string;
  tick: number | null;
  sqrtPriceX96: string | null;
  /** Price of token0 in units of token1, from sqrtPriceX96. */
  price0In1: number | null;
  /** True when `liquidity()` is zero: the pool exists but nothing can trade against it. */
  empty: boolean;
  error?: string;
}

export interface FindPoolsResult {
  chain: string;
  chainId: number;
  factory: `0x${string}`;
  tokenA: TokenInfo;
  tokenB: TokenInfo;
  atBlock: number;
  pools: PoolInfo[];
  /** Fee tiers the factory reports as never created. */
  missingTiers: number[];
  notes: string[];
}

const ZERO = '0x0000000000000000000000000000000000000000';

export async function findPools(
  client: PublicClient,
  config: ChainConfig,
  tokenA: TokenInfo,
  tokenB: TokenInfo,
  feeTiers: readonly number[] = V3_FEE_TIERS,
): Promise<FindPoolsResult> {
  const atBlock = await client.getBlockNumber();

  const addresses = await Promise.all(
    feeTiers.map(async (fee) => {
      try {
        const pool = await client.readContract({
          address: config.v3Factory,
          abi: FACTORY_ABI,
          functionName: 'getPool',
          args: [tokenA.address, tokenB.address, fee],
          blockNumber: atBlock,
        });
        return { fee, pool: pool as `0x${string}` };
      } catch (error) {
        return { fee, pool: ZERO as `0x${string}`, error: reasonOf(error) };
      }
    }),
  );

  const pools: PoolInfo[] = [];
  const missingTiers: number[] = [];

  for (const { fee, pool, error } of addresses) {
    if (error) {
      pools.push(emptyPoolInfo(fee, pool, config, error));
      continue;
    }
    if (pool.toLowerCase() === ZERO) {
      missingTiers.push(fee);
      continue;
    }
    pools.push(await describePool(client, config, fee, pool, tokenA, tokenB, atBlock));
  }

  const notes: string[] = [];
  const live = pools.filter((p) => !p.empty && !p.error);
  if (live.length === 0 && pools.length > 0) {
    notes.push(
      'Every pool that exists for this pair reports zero in-range liquidity. A quote against any '
      + 'of them will revert rather than return zero — an empty pool is not a cheap pool.',
    );
  }
  if (pools.length === 0) {
    notes.push('The factory has no pool for this pair at any of the fee tiers checked.');
  }
  if (live.length > 1) {
    notes.push(
      'More than one fee tier holds liquidity. They are separate pools with separate depth: the '
      + 'cheapest tier is not automatically the best fill, and `pool_depth` on each is the way to '
      + 'tell. Liquidity is a virtual quantity and is not comparable across fee tiers by size '
      + 'alone.',
    );
  }

  return {
    chain: config.name,
    chainId: config.id,
    factory: config.v3Factory,
    tokenA,
    tokenB,
    atBlock: Number(atBlock),
    pools,
    missingTiers,
    notes,
  };
}

function emptyPoolInfo(
  fee: number,
  address: `0x${string}`,
  config: ChainConfig,
  error: string,
): PoolInfo {
  return {
    feeTier: fee,
    feeLabel: feeLabel(fee),
    address,
    explorerUrl: `${config.explorer}/address/${address}`,
    token0: ZERO,
    token1: ZERO,
    activeLiquidity: '0',
    tick: null,
    sqrtPriceX96: null,
    price0In1: null,
    empty: true,
    error,
  };
}

async function describePool(
  client: PublicClient,
  config: ChainConfig,
  fee: number,
  address: `0x${string}`,
  tokenA: TokenInfo,
  tokenB: TokenInfo,
  atBlock: bigint,
): Promise<PoolInfo> {
  const base = {
    feeTier: fee,
    feeLabel: feeLabel(fee),
    address,
    explorerUrl: `${config.explorer}/address/${address}`,
  };
  try {
    const [slot0, liquidity, token0] = await Promise.all([
      client.readContract({ address, abi: POOL_ABI, functionName: 'slot0', blockNumber: atBlock }),
      client.readContract({ address, abi: POOL_ABI, functionName: 'liquidity', blockNumber: atBlock }),
      client.readContract({ address, abi: POOL_ABI, functionName: 'token0', blockNumber: atBlock }),
    ]);
    const [sqrtPriceX96, tick] = slot0 as unknown as [bigint, number];
    const t0 = (token0 as `0x${string}`).toLowerCase();
    // The pool orders its tokens by address, which is usually not the order the
    // caller passed them in. Getting the decimals the wrong way round here
    // shifts the price by 10^(d0-d1) — a factor of a trillion for USDC/WETH —
    // so the mapping is done explicitly rather than assumed.
    const aIsToken0 = tokenA.address.toLowerCase() === t0;
    const decimals0 = aIsToken0 ? tokenA.decimals : tokenB.decimals;
    const decimals1 = aIsToken0 ? tokenB.decimals : tokenA.decimals;

    return {
      ...base,
      token0: token0 as `0x${string}`,
      token1: (aIsToken0 ? tokenB.address : tokenA.address),
      activeLiquidity: (liquidity as bigint).toString(),
      tick: Number(tick),
      sqrtPriceX96: sqrtPriceX96.toString(),
      price0In1: priceFromSqrtPriceX96(sqrtPriceX96, decimals0, decimals1),
      empty: (liquidity as bigint) === 0n,
    };
  } catch (error) {
    return { ...emptyPoolInfo(fee, address, config, reasonOf(error)), ...base, error: reasonOf(error) };
  }
}
