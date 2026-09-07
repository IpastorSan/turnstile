// Live depth-at-size from Uniswap.
//
// The subgraph says what a pool *has been*. This module asks what it will do
// right now, at the current block, for a trade of a given size — which is the
// half of "is this pool safe to LP?" that history cannot answer, because an LP
// is paid by the trades that actually route through the pool and those depend
// on depth at the moment they arrive, not on cumulative volume.
//
// ## `quoter-v2` is the primary provider, chosen on the merits
//
// Uniswap's **on-chain quoting API** — QuoterV2's `quoteExactInputSingle`,
// simulated through `eth_call` — is what the analyst quotes with, because it is
// the right instrument for the question:
//
//   - **It is per-pool.** An LP deposits into one pool and is paid by the flow
//     that routes through that pool. "What does this specific pool do under
//     size" is the LP's question. A routed quote that splits across three pools
//     answers "what would I get", which is the trader's question, and tells you
//     nothing about the one pool you were considering.
//   - **It reports `initializedTicksCrossed`.** This is the single most
//     informative number anywhere in the analyst. It turns "the quote got
//     worse" into "the trade walked through 125 initialized ticks", which is a
//     mechanical, comparable measure of how far liquidity is actually spread.
//     The `slippage-curve` signal is built on it, and no routed-quote response
//     carries an equivalent.
//   - **It needs no key**, so the analyst is reusable infrastructure that
//     anyone can run.
//
// `trading-api` — Uniswap's hosted Trading API — is the second provider, wired
// behind `UNISWAP_API_KEY` so a key drops in without a rewrite. It is opt-in
// rather than automatic: switching to it *loses* `initializedTicksCrossed` and
// changes the measurement from one pool to a best route, which would quietly
// degrade the verdict. See `fetchDepth` below.
//
// Note for anyone who tries the Trading API: it needs a key we do not have.
// `POST https://trade-api.gateway.uniswap.org/v1/quote` with a fully valid body
// answers `401 {"errorCode":"Unauthorized","detail":"Unauthenticated api key or
// session"}` (2026-09-07), and `FEEDBACK.md` records the part that cost time —
// the endpoint validates the request body *before* it checks auth, so a request
// with one field wrong returns a helpful 400 field error and only a completely
// correct request reveals that you were never authenticated at all.

import { createPublicClient, http, encodeFunctionData, decodeFunctionResult, parseAbi } from 'viem';
import type { PublicClient } from 'viem';

import type { DepthProfile, DepthRung } from './types.ts';

/** QuoterV2, same address on mainnet and most L2 deployments. */
export const QUOTER_V2_ADDRESS = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e';

export const UNISWAP_TRADING_API_URL = 'https://trade-api.gateway.uniswap.org/v1/quote';

/**
 * QuoterV2's quote functions are `nonpayable`, not `view`: they run the swap and
 * revert on purpose, and the contract catches its own revert to return the
 * amounts. Uniswap's own v3 SDK guide says so and reaches for ethers'
 * `callStatic`.
 *
 * With viem no special handling is needed — `readContract` simulates through
 * `eth_call` and decodes a nonpayable function fine, verified against mainnet
 * on 2026-09-07. Worth writing down because the only place the quirk is
 * explained at all is an ethers-specific SDK guide, whose remedy has no viem
 * equivalent by that name, so the natural conclusion is that viem cannot do it.
 */
const QUOTER_ABI = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);

export const DEFAULT_NOTIONALS_USD = [1_000, 10_000, 100_000, 1_000_000, 10_000_000];

export interface QuoteTokenSpec {
  address: string;
  symbol: string;
  decimals: number;
}

export interface DepthRequest {
  tokenIn: QuoteTokenSpec;
  tokenOut: QuoteTokenSpec;
  /** Uniswap fee tier in hundredths of a bip: 500 is 0.05%. */
  feeTier: number;
  /** USD price of `tokenIn`, used only to size the ladder. */
  tokenInPriceUSD: number;
  /** Provenance of that price, carried through so the scorer can discount it. */
  priceSource?: 'subgraph-lastPriceUSD' | 'caller-supplied';
  /** Ascending USD notionals to quote. */
  notionalsUSD?: number[];
  chainId?: number;
  /** Unix seconds. Passed in so a caller can pin the whole report to one instant. */
  now?: number;
}

export interface QuoterOptions {
  rpcUrl?: string;
  quoterAddress?: string;
  client?: PublicClient;
}

function toRawAmount(whole: number, decimals: number): bigint {
  // Going through a fixed-point string rather than `BigInt(whole * 10 ** d)`
  // avoids the float overflow that silently produces `Infinity` for an
  // 18-decimal amount above roughly 1e2.
  const fixed = whole.toFixed(Math.min(decimals, 18));
  const [integer = '0', fraction = ''] = fixed.split('.');
  const padded = (fraction + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(integer) * 10n ** BigInt(decimals) + BigInt(padded || '0');
}

function fromRawAmount(raw: bigint, decimals: number): number {
  const scale = 10n ** BigInt(decimals);
  return Number(raw / scale) + Number(raw % scale) / Number(scale);
}

function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // viem stacks a readable summary above a long dump. The first line is the
  // part a human wants; the rest is the call trace.
  return message.split('\n')[0]!.trim().slice(0, 200);
}

/**
 * Depth-at-size straight from the pool, via QuoterV2. Needs an RPC endpoint and
 * nothing else.
 */
export async function fetchDepthFromQuoter(
  request: DepthRequest,
  options: QuoterOptions = {},
): Promise<DepthProfile> {
  const rpcUrl = options.rpcUrl
    ?? process.env.MAINNET_RPC_URL
    ?? 'https://ethereum-rpc.publicnode.com';
  const quoter = options.quoterAddress ?? QUOTER_V2_ADDRESS;
  const client = options.client
    ?? (createPublicClient({ transport: http(rpcUrl, { timeout: 20_000 }) }) as PublicClient);

  const atBlock = await client.getBlockNumber();
  const notionals = (request.notionalsUSD ?? DEFAULT_NOTIONALS_USD).slice().sort((a, b) => a - b);
  const rungs: DepthRung[] = [];

  for (const notionalUSD of notionals) {
    const amountIn = notionalUSD / request.tokenInPriceUSD;
    const rawIn = toRawAmount(amountIn, request.tokenIn.decimals);
    if (rawIn === 0n) {
      rungs.push({
        notionalUSD,
        amountIn,
        amountOut: null,
        executedRate: null,
        ticksCrossed: null,
        error: 'notional rounds to zero token units at this price and decimals',
      });
      continue;
    }

    try {
      // Encode, `call`, decode — rather than `readContract`, which does work
      // here (see the ABI note above) but whose return type collapses to
      // `never` against a chain-agnostic `PublicClient`. The client has to stay
      // chain-agnostic: the analyst is pointed at mainnet or Arbitrum from a
      // flag, since the same Messari document answers on both.
      //
      // Every rung is pinned to `atBlock`, so the ladder is one coherent view
      // of the pool rather than five samples taken as it moved.
      const data = encodeFunctionData({
        abi: QUOTER_ABI,
        functionName: 'quoteExactInputSingle',
        args: [{
          tokenIn: request.tokenIn.address as `0x${string}`,
          tokenOut: request.tokenOut.address as `0x${string}`,
          amountIn: rawIn,
          fee: request.feeTier,
          sqrtPriceLimitX96: 0n,
        }],
      });
      const result = await client.call({ to: quoter as `0x${string}`, data, blockNumber: atBlock });
      if (!result.data) throw new Error('quoter returned empty data');
      const [amountOutRaw, , ticksCrossed] = decodeFunctionResult({
        abi: QUOTER_ABI,
        functionName: 'quoteExactInputSingle',
        data: result.data,
      });
      const amountOut = fromRawAmount(amountOutRaw, request.tokenOut.decimals);
      rungs.push({
        notionalUSD,
        amountIn,
        amountOut,
        executedRate: amountIn > 0 ? amountOut / amountIn : null,
        ticksCrossed: Number(ticksCrossed),
      });
    } catch (error) {
      // A revert here is a finding, not a failure of the analyst: it means the
      // pool cannot fill that size. Record it and keep walking the ladder.
      rungs.push({
        notionalUSD,
        amountIn,
        amountOut: null,
        executedRate: null,
        ticksCrossed: null,
        error: reasonOf(error),
      });
    }
  }

  return {
    provider: 'quoter-v2',
    providerDetail: `${quoter} via ${new URL(rpcUrl).host}`,
    tokenInSymbol: request.tokenIn.symbol,
    tokenOutSymbol: request.tokenOut.symbol,
    atBlock: Number(atBlock),
    quotedAt: request.now ?? Math.floor(Date.now() / 1000),
    rungs,
    notionalPricing: {
      tokenSymbol: request.tokenIn.symbol,
      priceUSD: request.tokenInPriceUSD,
      priceSource: request.priceSource ?? 'subgraph-lastPriceUSD',
    },
  };
}

export class UniswapApiKeyMissing extends Error {
  constructor() {
    super(
      'UNISWAP_API_KEY is unset, and the Uniswap Trading API answers 401 '
      + '"Unauthenticated api key or session" without one. This provider is opt-in; '
      + 'the analyst quotes with QuoterV2 unless you ask for this one by name.',
    );
    this.name = 'UniswapApiKeyMissing';
  }
}

/**
 * Depth from Uniswap's hosted Trading API.
 *
 * **Unverified end to end.** We have never had a key, so the request shape
 * below is built from the endpoint's own validation errors — which is a real
 * source, just not the same as a successful response. Confirmed by probing on
 * 2026-09-07: `routingPreference` must be one of `BEST_PRICE` or `FASTEST`
 * (the docs' `CLASSIC` is rejected), and the four token/chain fields and
 * `swapper` are all required. The parsing below is therefore best-effort and
 * marked as such; the first successful call should be used to correct it.
 */
export async function fetchDepthFromTradingApi(
  request: DepthRequest,
  options: { apiKey?: string; url?: string } = {},
): Promise<DepthProfile> {
  const apiKey = options.apiKey ?? process.env.UNISWAP_API_KEY;
  if (!apiKey) throw new UniswapApiKeyMissing();
  const url = options.url ?? UNISWAP_TRADING_API_URL;
  const chainId = request.chainId ?? 1;
  const notionals = (request.notionalsUSD ?? DEFAULT_NOTIONALS_USD).slice().sort((a, b) => a - b);

  const rungs: DepthRung[] = [];
  let atBlock = 0;

  for (const notionalUSD of notionals) {
    const amountIn = notionalUSD / request.tokenInPriceUSD;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({
          type: 'EXACT_INPUT',
          amount: toRawAmount(amountIn, request.tokenIn.decimals).toString(),
          tokenInChainId: chainId,
          tokenOutChainId: chainId,
          tokenIn: request.tokenIn.address,
          tokenOut: request.tokenOut.address,
          swapper: '0x0000000000000000000000000000000000000000',
          routingPreference: 'BEST_PRICE',
        }),
      });
      const body = (await response.json()) as {
        quote?: { output?: { amount?: string }; blockNumber?: string; route?: unknown };
        detail?: string;
        errorCode?: string;
      };
      if (!response.ok) {
        throw new Error(`${body.errorCode ?? response.status}: ${body.detail ?? 'no detail'}`);
      }
      const outRaw = body.quote?.output?.amount;
      if (!outRaw) throw new Error('response carried no quote.output.amount');
      atBlock = Number(body.quote?.blockNumber ?? atBlock);
      const amountOut = fromRawAmount(BigInt(outRaw), request.tokenOut.decimals);
      rungs.push({
        notionalUSD,
        amountIn,
        amountOut,
        executedRate: amountIn > 0 ? amountOut / amountIn : null,
        // The Trading API returns a route, not a tick walk. There is no
        // equivalent of `initializedTicksCrossed`, which is one concrete reason
        // the quoter is the better instrument for a single-pool question.
        ticksCrossed: null,
      });
    } catch (error) {
      rungs.push({
        notionalUSD,
        amountIn,
        amountOut: null,
        executedRate: null,
        ticksCrossed: null,
        error: reasonOf(error),
      });
    }
  }

  return {
    provider: 'trading-api',
    providerDetail: new URL(url).host,
    tokenInSymbol: request.tokenIn.symbol,
    tokenOutSymbol: request.tokenOut.symbol,
    atBlock,
    quotedAt: request.now ?? Math.floor(Date.now() / 1000),
    rungs,
    notionalPricing: {
      tokenSymbol: request.tokenIn.symbol,
      priceUSD: request.tokenInPriceUSD,
      priceSource: request.priceSource ?? 'subgraph-lastPriceUSD',
    },
  };
}

export type DepthProvider = 'quoter-v2' | 'trading-api' | 'auto';

/**
 * Pick a provider. `auto` — the default — is QuoterV2.
 *
 * Deliberately NOT "use the Trading API whenever a key happens to be set". The
 * presence of a credential in the environment is not a reason to change what is
 * being measured, and it would: the Trading API returns a best route across
 * pools rather than this pool, and carries no `initializedTicksCrossed`, so the
 * `slippage-curve` signal would silently lose the evidence it is built on. A
 * verdict that changes because someone exported a variable is not a verdict.
 *
 * Ask for `trading-api` by name when you want it.
 */
export async function fetchDepth(
  request: DepthRequest,
  options: { provider?: DepthProvider; quoter?: QuoterOptions; apiKey?: string } = {},
): Promise<DepthProfile> {
  if ((options.provider ?? 'auto') === 'trading-api') {
    return fetchDepthFromTradingApi(request, { apiKey: options.apiKey });
  }
  return fetchDepthFromQuoter(request, options.quoter);
}
