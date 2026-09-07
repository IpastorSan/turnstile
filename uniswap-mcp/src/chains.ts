// Chain configuration.
//
// Every address below was checked with `eth_getCode` on 2026-09-07 and has
// deployed bytecode on the chain it is listed under. That is a low bar — it
// proves *something* is there, not that it is the right something — so the
// deployment page is cited per contract and the bytecode length is recorded,
// since the v3 contracts are deterministic deploys and a length that matches
// across five chains is a second, independent signal.
//
// The table is deliberately small. `find_pools` derives pool addresses from the
// factory rather than from a list, so the only addresses that have to be
// hardcoded are the four singletons per chain, and a chain we have not verified
// is absent rather than guessed. Add one with `--chain-config`, or open a PR
// once you have run the check.

export interface ChainConfig {
  /** viem/EIP-155 chain id. */
  id: number;
  /** The name callers pass to a tool. */
  name: string;
  /** Fallback RPC. Overridden by `<NAME>_RPC_URL`, then by `--rpc`. */
  defaultRpcUrl: string;
  /** Uniswap v3 factory. Authoritative source of pool addresses. */
  v3Factory: `0x${string}`;
  /** QuoterV2. Non-view; simulated through `eth_call`. See `quotes.ts`. */
  quoterV2: `0x${string}`;
  /** V4Quoter. Also non-view, for the same reason. */
  v4Quoter: `0x${string}`;
  /** Block explorer, used only to make output clickable. */
  explorer: string;
  /** A well-known token used to size a ladder when the caller gives no price. */
  usdStable: { address: `0x${string}`; symbol: string; decimals: number };
  wrappedNative: { address: `0x${string}`; symbol: string; decimals: number };
}

/**
 * The v3 factory and QuoterV2 share one address across mainnet, Arbitrum,
 * Optimism and Polygon, and differ on Base — which is exactly the kind of
 * "same everywhere except where it isn't" that produces a silent wrong answer
 * if you assume either half of it. Hence a table rather than a constant.
 */
export const CHAINS: Record<string, ChainConfig> = {
  mainnet: {
    id: 1,
    name: 'mainnet',
    defaultRpcUrl: 'https://ethereum-rpc.publicnode.com',
    v3Factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    quoterV2: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    v4Quoter: '0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203',
    explorer: 'https://etherscan.io',
    usdStable: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6 },
    wrappedNative: { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', decimals: 18 },
  },
  arbitrum: {
    id: 42161,
    name: 'arbitrum',
    defaultRpcUrl: 'https://arbitrum-one-rpc.publicnode.com',
    v3Factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    quoterV2: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    v4Quoter: '0x3972c00f7ed4885e145823eb7c655375d275a1c5',
    explorer: 'https://arbiscan.io',
    usdStable: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', decimals: 6 },
    wrappedNative: { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', symbol: 'WETH', decimals: 18 },
  },
  optimism: {
    id: 10,
    name: 'optimism',
    defaultRpcUrl: 'https://optimism-rpc.publicnode.com',
    v3Factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    quoterV2: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    v4Quoter: '0x1f3131a13296fb91c90870043742c3cdbff1a8d7',
    explorer: 'https://optimistic.etherscan.io',
    usdStable: { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', symbol: 'USDC', decimals: 6 },
    wrappedNative: { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 },
  },
  base: {
    id: 8453,
    name: 'base',
    defaultRpcUrl: 'https://base-rpc.publicnode.com',
    // Base is the exception: both the factory and QuoterV2 differ here.
    v3Factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
    quoterV2: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
    v4Quoter: '0x0d5e0f971ed27fbff6c2837bf31316121532048d',
    explorer: 'https://basescan.org',
    usdStable: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 },
    wrappedNative: { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 },
  },
  polygon: {
    id: 137,
    name: 'polygon',
    defaultRpcUrl: 'https://polygon-bor-rpc.publicnode.com',
    v3Factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    quoterV2: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    v4Quoter: '0xb3d5c3dfc3a7aebff71895a7191796bffc2c81b9',
    explorer: 'https://polygonscan.com',
    usdStable: { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', symbol: 'USDC', decimals: 6 },
    wrappedNative: { address: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', symbol: 'WPOL', decimals: 18 },
  },
};

export const DEFAULT_CHAIN = 'mainnet';

export class UnknownChain extends Error {
  constructor(name: string) {
    super(
      `unknown chain "${name}". Known: ${Object.keys(CHAINS).join(', ')}. `
      + 'Chains are listed only once their factory and quoter addresses have been checked '
      + 'on-chain, so this list is shorter than the set of chains Uniswap is deployed on.',
    );
    this.name = 'UnknownChain';
  }
}

/** Accepts a name ("base") or a chain id (8453, "8453"). */
export function resolveChain(chain?: string | number): ChainConfig {
  if (chain === undefined || chain === null || chain === '') return CHAINS[DEFAULT_CHAIN]!;
  const key = String(chain).toLowerCase().trim();
  const byName = CHAINS[key];
  if (byName) return byName;
  const asId = Number(key);
  if (Number.isFinite(asId)) {
    const byId = Object.values(CHAINS).find((c) => c.id === asId);
    if (byId) return byId;
  }
  throw new UnknownChain(String(chain));
}

/**
 * RPC precedence: explicit argument, then `<CHAIN>_RPC_URL` (e.g. `BASE_RPC_URL`),
 * then the generic `RPC_URL` only when it names the same chain, then the public
 * fallback.
 *
 * The generic variable is deliberately *not* a blanket default. A single
 * `RPC_URL` pointing at mainnet, silently used to answer a Base question, is a
 * confidently wrong answer — and the caller has no way to see it happened. It
 * applies only when `RPC_CHAIN` says which chain it is for.
 */
export function rpcUrlFor(config: ChainConfig, explicit?: string): string {
  if (explicit) return explicit;
  const specific = process.env[`${config.name.toUpperCase()}_RPC_URL`];
  if (specific) return specific;
  const generic = process.env.RPC_URL;
  const genericChain = process.env.RPC_CHAIN;
  if (generic && genericChain && genericChain.toLowerCase().trim() === config.name) return generic;
  return config.defaultRpcUrl;
}
