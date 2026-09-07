import { Address, BigDecimal, BigInt } from "@graphprotocol/graph-ts";
import { UniswapV3Pool } from "../../generated/Factory/UniswapV3Pool";
import { LiquidityPool, Token, _HelperStore } from "../../generated/schema";
import {
  ETH_PRICE_KEY,
  ONE_BD,
  STABLECOINS,
  USDC_WETH_005_POOL,
  WETH_ADDRESS,
  ZERO_BD,
} from "./constants";
import { sqrtPriceX96ToTokenPrices } from "./utils";

export function isStablecoin(token: Token): boolean {
  const hex = token.id.toHexString();
  for (let i = 0; i < STABLECOINS.length; i++) {
    if (STABLECOINS[i] == hex) {
      return true;
    }
  }
  return false;
}

export function isWeth(token: Token): boolean {
  return token.id.toHexString() == WETH_ADDRESS.toHexString();
}

function ethPriceStore(): _HelperStore {
  let store = _HelperStore.load(ETH_PRICE_KEY);
  if (store == null) {
    store = new _HelperStore(ETH_PRICE_KEY);
    store.valueDecimal = ZERO_BD;
    store.valueInt = 0;
    store.save();
  }
  return store;
}

/**
 * ETH/USD, cached in _HelperStore and refreshed on every swap through the
 * USDC/WETH 0.05% pool. On the very first event of the sync there is no cached
 * value yet, so bootstrap it with a slot0() call rather than pricing that
 * block's swaps at zero.
 */
export function getEthPriceUSD(): BigDecimal {
  const store = ethPriceStore();
  const cached = store.valueDecimal;
  if (cached !== null && (cached as BigDecimal).gt(ZERO_BD)) {
    return cached as BigDecimal;
  }

  const pool = UniswapV3Pool.bind(USDC_WETH_005_POOL);
  const slot0 = pool.try_slot0();
  if (slot0.reverted) {
    return ZERO_BD;
  }
  // token0 = USDC (6 decimals), token1 = WETH (18). token0-per-token1 is the
  // USDC value of one WETH.
  const prices = sqrtPriceX96ToTokenPrices(slot0.value.value0, 6, 18);
  store.valueDecimal = prices[0];
  store.save();
  return prices[0];
}

export function setEthPriceUSD(price: BigDecimal): void {
  if (price.le(ZERO_BD)) {
    return;
  }
  const store = ethPriceStore();
  store.valueDecimal = price;
  store.save();
}

/**
 * USD price of a token, or null when this subgraph has no path to one.
 * Stablecoins are pinned to 1; WETH comes from the reference pool; everything
 * else carries the price last derived for it from a pool it trades in.
 */
export function knownPriceUSD(token: Token): BigDecimal | null {
  if (isStablecoin(token)) {
    return ONE_BD;
  }
  if (isWeth(token)) {
    const eth = getEthPriceUSD();
    return eth.gt(ZERO_BD) ? eth : null;
  }
  const last = token.lastPriceUSD;
  if (last !== null && (last as BigDecimal).gt(ZERO_BD)) {
    return last as BigDecimal;
  }
  return null;
}

/** Same, but 0 rather than null, for the many non-nullable USD fields. */
export function priceUSDOrZero(token: Token): BigDecimal {
  const price = knownPriceUSD(token);
  return price === null ? ZERO_BD : (price as BigDecimal);
}

/**
 * Re-derive both tokens' USD prices from a pool's current sqrt price.
 *
 * A v3 sqrt price is an exact on-chain quantity, so whichever side of the pair
 * already has a USD anchor (a stablecoin, or WETH) prices the other side. Pairs
 * with no anchor on either side keep whatever price they had.
 */
export function updatePricesFromSqrtPrice(
  pool: LiquidityPool,
  token0: Token,
  token1: Token,
  sqrtPriceX96: BigInt,
  blockNumber: BigInt
): void {
  if (sqrtPriceX96.le(BigInt.fromI32(0))) {
    return;
  }
  const prices = sqrtPriceX96ToTokenPrices(
    sqrtPriceX96,
    token0.decimals,
    token1.decimals
  );
  const token0PerToken1 = prices[0];
  const token1PerToken0 = prices[1];

  // The reference pool defines ETH/USD for the whole subgraph.
  if (Address.fromBytes(pool.id).equals(USDC_WETH_005_POOL)) {
    setEthPriceUSD(token0PerToken1);
  }

  const anchor0 = knownPriceUSD(token0);
  const anchor1 = knownPriceUSD(token1);

  if (anchor0 !== null) {
    token0.lastPriceUSD = anchor0;
    token0.lastPriceBlockNumber = blockNumber;
    token0._lastPricePool = pool.id;
    token0.save();
  }
  if (anchor1 !== null) {
    token1.lastPriceUSD = anchor1;
    token1.lastPriceBlockNumber = blockNumber;
    token1._lastPricePool = pool.id;
    token1.save();
  }

  if (anchor0 !== null && anchor1 === null) {
    token1.lastPriceUSD = token0PerToken1.times(anchor0 as BigDecimal);
    token1.lastPriceBlockNumber = blockNumber;
    token1._lastPricePool = pool.id;
    token1.save();
  } else if (anchor1 !== null && anchor0 === null) {
    token0.lastPriceUSD = token1PerToken0.times(anchor1 as BigDecimal);
    token0.lastPriceBlockNumber = blockNumber;
    token0._lastPricePool = pool.id;
    token0.save();
  }
}
