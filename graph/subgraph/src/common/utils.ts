import { BigDecimal, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import { ONE_BD, SECONDS_PER_DAY, SECONDS_PER_HOUR, ZERO_BD } from "./constants";

export function exponentToBigDecimal(decimals: i32): BigDecimal {
  let result = BigInt.fromI32(1);
  const ten = BigInt.fromI32(10);
  for (let i = 0; i < decimals; i++) {
    result = result.times(ten);
  }
  return result.toBigDecimal();
}

/** BigDecimal division that yields 0 instead of trapping on a zero divisor. */
export function safeDiv(numerator: BigDecimal, denominator: BigDecimal): BigDecimal {
  if (denominator.equals(ZERO_BD)) {
    return ZERO_BD;
  }
  return numerator.div(denominator);
}

/** Raw token amount -> human units. */
export function bigIntToBigDecimal(amount: BigInt, decimals: i32): BigDecimal {
  return amount.toBigDecimal().div(exponentToBigDecimal(decimals));
}

export function absBigInt(value: BigInt): BigInt {
  return value.lt(BigInt.fromI32(0)) ? value.neg() : value;
}

export function absBigDecimal(value: BigDecimal): BigDecimal {
  return value.lt(ZERO_BD) ? value.neg() : value;
}

export function getDayID(timestamp: BigInt): i32 {
  return timestamp.toI32() / SECONDS_PER_DAY;
}

export function getHourID(timestamp: BigInt): i32 {
  return timestamp.toI32() / SECONDS_PER_HOUR;
}

/** Messari snapshot ids are `<parent bytes>-<interval id>`. */
export function snapshotId(parent: Bytes, interval: i32): Bytes {
  return parent.concat(Bytes.fromUTF8("-" + interval.toString()));
}

/** Messari transaction-entity ids are `<tx hash>-<log index>`. */
export function eventId(event: ethereum.Event): Bytes {
  return event.transaction.hash.concat(
    Bytes.fromUTF8("-" + event.logIndex.toString())
  );
}

/**
 * Uniswap v3 stores price as a Q64.96 square root. Squaring it and dividing by
 * 2^192 gives the raw amount1/amount0 ratio, which then has to be re-scaled by
 * the two tokens' decimals.
 *
 * Returns [token0PerToken1, token1PerToken0].
 */
export function sqrtPriceX96ToTokenPrices(
  sqrtPriceX96: BigInt,
  decimals0: i32,
  decimals1: i32
): BigDecimal[] {
  const q192 = BigInt.fromI32(2).pow(192).toBigDecimal();
  const num = sqrtPriceX96.times(sqrtPriceX96).toBigDecimal();
  // token1 per token0
  const price1 = safeDiv(num, q192)
    .times(exponentToBigDecimal(decimals0))
    .div(exponentToBigDecimal(decimals1));
  // token0 per token1
  const price0 = safeDiv(ONE_BD, price1);
  return [price0, price1];
}

/** 1.0001^n on BigDecimal, by squaring. Avoids f64 formatting round-trips. */
function bigDecimalExponated(base: BigDecimal, exponent: i32): BigDecimal {
  if (exponent == 0) {
    return ONE_BD;
  }
  const negative = exponent < 0;
  let n = negative ? -exponent : exponent;

  let result = ONE_BD;
  let factor = base;
  while (n > 0) {
    if ((n & 1) == 1) {
      result = result.times(factor);
    }
    n = n >> 1;
    if (n > 0) {
      factor = factor.times(factor);
    }
  }
  return negative ? safeDiv(ONE_BD, result) : result;
}

/**
 * Price of token0 in token1 at a tick, i.e. 1.0001^tick re-scaled by decimals.
 * Tick.prices is required on every tick by the Extended schema, and is what
 * makes a concentrated-liquidity range comparable across protocols.
 *
 * Returns [token0PerToken1, token1PerToken0].
 */
export function tickToPrices(
  tick: BigInt,
  decimals0: i32,
  decimals1: i32
): BigDecimal[] {
  const price1 = bigDecimalExponated(
    BigDecimal.fromString("1.0001"),
    tick.toI32()
  )
    .times(exponentToBigDecimal(decimals0))
    .div(exponentToBigDecimal(decimals1));
  const price0 = safeDiv(ONE_BD, price1);
  return [price0, price1];
}
