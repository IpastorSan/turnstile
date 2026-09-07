// On-chain quoting, v3 and v4.
//
// ## The thing everyone gets wrong first
//
// Uniswap's quoter functions are **not `view`**. Both QuoterV2 (v3) and
// V4Quoter (v4) work by starting the swap and deliberately reverting, then
// catching their own revert to read the amounts out of the revert data.
// V4Quoter.sol says so in its own NatSpec:
//
//   "These functions are not marked view because they rely on calling non-view
//    functions and reverting to compute the result. They are also not gas
//    efficient and should not be called on-chain."
//
// The remedy every Uniswap guide gives for this is ethers v5's `callStatic`.
// That is a library-specific spelling of a library-neutral idea, and it has
// aged badly:
//
//   - `contract.callStatic.fn()` is **ethers v5 only**. It was removed in
//     ethers v6, where the spelling is `contract.fn.staticCall()`. Verified
//     against ethers 6.17.0: `contract.callStatic` is `undefined`, so the
//     documented call throws `TypeError: Cannot read properties of undefined`.
//   - viem has no `callStatic` by any name. `readContract` simulates through
//     `eth_call` and decodes a nonpayable function without complaint.
//
// The underlying idea is just `eth_call`: send the call, let the node execute
// it against current state, throw the state changes away, keep the return data.
// Every library can do that. This module does it with viem, and the
// `uniswap-mcp` SKILL states the neutral version so an agent using it does not
// reproduce the ethers-v5 spelling in a codebase that has no ethers in it.
//
// Verified live on 2026-09-07 against mainnet V4Quoter
// (0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203), the ETH/USDC 0.05% pool: viem
// `readContract` and ethers v6 `.staticCall` both return 2477.420516 USDC for
// 1 ETH, agreeing to the last decimal; the documented `callStatic` throws.
//
// ## Why `initializedTicksCrossed` is the number worth having
//
// QuoterV2 returns it and nothing in a routed quoting API does. It converts
// "the price got worse" into "this trade walked through 126 initialized ticks",
// which is a mechanical, comparable measure of how far liquidity is spread —
// the difference between a pool that is deep and one that merely has a large
// TVL number attached to it. `depth.ts` is built on it.

import { encodeFunctionData, decodeFunctionResult, parseAbi } from 'viem';
import type { PublicClient } from 'viem';

import type { ChainConfig } from './chains.ts';
import { toRawAmount, fromRawAmount, formatRawAmount } from './amounts.ts';
import { reasonOf } from './tokens.ts';
import type { TokenInfo } from './tokens.ts';

const QUOTER_V2_ABI = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);

const V4_QUOTER_ABI = parseAbi([
  'function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)',
]);

export interface QuoteResult {
  version: 'v3' | 'v4';
  quoter: `0x${string}`;
  atBlock: number;
  amountIn: string;
  amountInRaw: string;
  amountOut: string | null;
  amountOutRaw: string | null;
  /** amountOut per unit amountIn. */
  executedPrice: number | null;
  /** v3 only. The single most informative field the quoter returns. */
  initializedTicksCrossed: number | null;
  gasEstimate: string | null;
  error?: string;
}

export interface V3QuoteRequest {
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  feeTier: number;
  amountIn: number;
  blockNumber?: bigint;
}

/**
 * A v3 quote through QuoterV2.
 *
 * Encode / `eth_call` / decode by hand rather than `readContract`, for one
 * reason worth stating: against a chain-agnostic `PublicClient`, viem's
 * `readContract` return type collapses to `never` for a nonpayable function.
 * The call itself works either way. The client has to stay chain-agnostic
 * because this server is pointed at five chains from an argument.
 */
export async function quoteV3(
  client: PublicClient,
  config: ChainConfig,
  request: V3QuoteRequest,
): Promise<QuoteResult> {
  const atBlock = request.blockNumber ?? await client.getBlockNumber();
  const rawIn = toRawAmount(request.amountIn, request.tokenIn.decimals);

  const base = {
    version: 'v3' as const,
    quoter: config.quoterV2,
    atBlock: Number(atBlock),
    amountIn: formatRawAmount(rawIn, request.tokenIn.decimals),
    amountInRaw: rawIn.toString(),
  };

  if (rawIn === 0n) {
    return {
      ...base,
      amountOut: null,
      amountOutRaw: null,
      executedPrice: null,
      initializedTicksCrossed: null,
      gasEstimate: null,
      error: `${request.amountIn} rounds to zero raw units at ${request.tokenIn.decimals} decimals`,
    };
  }

  try {
    const data = encodeFunctionData({
      abi: QUOTER_V2_ABI,
      functionName: 'quoteExactInputSingle',
      args: [{
        tokenIn: request.tokenIn.address,
        tokenOut: request.tokenOut.address,
        amountIn: rawIn,
        fee: request.feeTier,
        // 0 means "no limit": let the swap walk as far through the book as the
        // size requires. A non-zero limit would cap the fill and make the
        // answer a different question from "what does this size cost".
        sqrtPriceLimitX96: 0n,
      }],
    });
    const result = await client.call({ to: config.quoterV2, data, blockNumber: atBlock });
    if (!result.data) throw new Error('quoter returned empty data');
    const [amountOutRaw, , ticksCrossed, gasEstimate] = decodeFunctionResult({
      abi: QUOTER_V2_ABI,
      functionName: 'quoteExactInputSingle',
      data: result.data,
    });
    const amountOut = fromRawAmount(amountOutRaw, request.tokenOut.decimals);
    return {
      ...base,
      amountOut: formatRawAmount(amountOutRaw, request.tokenOut.decimals),
      amountOutRaw: amountOutRaw.toString(),
      executedPrice: request.amountIn > 0 ? amountOut / request.amountIn : null,
      initializedTicksCrossed: Number(ticksCrossed),
      gasEstimate: gasEstimate.toString(),
    };
  } catch (error) {
    return {
      ...base,
      amountOut: null,
      amountOutRaw: null,
      executedPrice: null,
      initializedTicksCrossed: null,
      gasEstimate: null,
      error: explainQuoterRevert(reasonOf(error)),
    };
  }
}

export interface V4QuoteRequest {
  currency0: `0x${string}`;
  currency1: `0x${string}`;
  fee: number;
  tickSpacing: number;
  hooks: `0x${string}`;
  zeroForOne: boolean;
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  amountIn: number;
  hookData?: `0x${string}`;
  blockNumber?: bigint;
}

/** A v4 quote through V4Quoter. Same `eth_call` mechanics; no tick count. */
export async function quoteV4(
  client: PublicClient,
  config: ChainConfig,
  request: V4QuoteRequest,
): Promise<QuoteResult> {
  const atBlock = request.blockNumber ?? await client.getBlockNumber();
  const rawIn = toRawAmount(request.amountIn, request.tokenIn.decimals);

  const base = {
    version: 'v4' as const,
    quoter: config.v4Quoter,
    atBlock: Number(atBlock),
    amountIn: formatRawAmount(rawIn, request.tokenIn.decimals),
    amountInRaw: rawIn.toString(),
  };

  try {
    const data = encodeFunctionData({
      abi: V4_QUOTER_ABI,
      functionName: 'quoteExactInputSingle',
      args: [{
        poolKey: {
          currency0: request.currency0,
          currency1: request.currency1,
          fee: request.fee,
          tickSpacing: request.tickSpacing,
          hooks: request.hooks,
        },
        zeroForOne: request.zeroForOne,
        exactAmount: rawIn,
        hookData: request.hookData ?? '0x00',
      }],
    });
    const result = await client.call({ to: config.v4Quoter, data, blockNumber: atBlock });
    if (!result.data) throw new Error('quoter returned empty data');
    const [amountOutRaw, gasEstimate] = decodeFunctionResult({
      abi: V4_QUOTER_ABI,
      functionName: 'quoteExactInputSingle',
      data: result.data,
    });
    const amountOut = fromRawAmount(amountOutRaw, request.tokenOut.decimals);
    return {
      ...base,
      amountOut: formatRawAmount(amountOutRaw, request.tokenOut.decimals),
      amountOutRaw: amountOutRaw.toString(),
      executedPrice: request.amountIn > 0 ? amountOut / request.amountIn : null,
      // v4's quoter returns only (amountOut, gasEstimate). There is no tick
      // walk in the response, so a v4 depth profile is a price curve without
      // the mechanical explanation the v3 one carries.
      initializedTicksCrossed: null,
      gasEstimate: gasEstimate.toString(),
    };
  } catch (error) {
    return {
      ...base,
      amountOut: null,
      amountOutRaw: null,
      executedPrice: null,
      initializedTicksCrossed: null,
      gasEstimate: null,
      error: explainQuoterRevert(reasonOf(error)),
    };
  }
}

/**
 * QuoterV2 collapses several distinct failures into one opaque string.
 *
 * `Unexpected error` is returned for a pool that does not exist at that fee
 * tier, for a pool with no liquidity, and for identical tokens — three
 * different problems with three different fixes. Since the contract will not
 * distinguish them, the message at least says what the candidates are, so a
 * caller is not left believing the quoter malfunctioned.
 */
export function explainQuoterRevert(reason: string): string {
  if (/unexpected error/i.test(reason)) {
    return `${reason} — QuoterV2 returns this same string for several different causes: no pool `
      + 'at this fee tier, a pool with zero liquidity, or tokenIn == tokenOut. Use find_pools to '
      + 'tell them apart; it reports which tiers exist and which hold liquidity.';
  }
  return reason;
}
