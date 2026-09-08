import {
  Address,
  BigDecimal,
  BigInt,
  Bytes,
  ethereum,
} from "@graphprotocol/graph-ts";
import { UniswapV3Pool } from "../../generated/Factory/UniswapV3Pool";
import {
  LiquidityPool,
  LiquidityPoolFee,
  Token,
  _LiquidityPoolAmount,
} from "../../generated/schema";
import { Pool as PoolTemplate } from "../../generated/templates";
import {
  FEE_DENOMINATOR,
  FEE_TYPE_FIXED_LP,
  FEE_TYPE_FIXED_PROTOCOL,
  FEE_TYPE_FIXED_TRADING,
  HUNDRED_BD,
  ZERO_BD,
  ZERO_BI,
} from "./constants";
import { priceUSDOrZero } from "./pricing";
import { getOrCreateProtocol } from "./protocol";
import { getOrCreateToken, tokenBalanceOf } from "./tokens";
import { bigIntToBigDecimal, safeDiv } from "./utils";

function feeId(feeType: string, poolId: Bytes): Bytes {
  return Bytes.fromUTF8(feeType + "-").concat(poolId);
}

function createFee(feeType: string, poolId: Bytes, percentage: BigDecimal): Bytes {
  const id = feeId(feeType, poolId);
  let fee = LiquidityPoolFee.load(id);
  if (fee == null) {
    fee = new LiquidityPoolFee(id);
  }
  fee.feeType = feeType;
  fee.feePercentage = percentage;
  fee.save();
  return id;
}

/** Uniswap v3 fee tiers are hundredths of a bip: 3000 -> 0.30%. */
function feeTierToPercentage(feeTier: i32): BigDecimal {
  return BigDecimal.fromString(feeTier.toString()).div(FEE_DENOMINATOR);
}

export function getPoolFeePercentage(pool: LiquidityPool): BigDecimal {
  const fee = LiquidityPoolFee.load(feeId(FEE_TYPE_FIXED_TRADING, pool.id));
  if (fee == null) {
    return ZERO_BD;
  }
  const percentage = fee.feePercentage;
  return percentage === null ? ZERO_BD : (percentage as BigDecimal);
}

/**
 * Load a pool, or build it from the chain.
 *
 * Every field the Messari standard marks non-null is populated here, including
 * the ones that are only knowable by calling the pool: an existing pool first
 * seen mid-sync gets its real reserves and tick, not zeros that would slowly
 * converge as events arrive.
 */
export function getOrCreatePool(
  address: Address,
  event: ethereum.Event,
  spawnTemplate: boolean
): LiquidityPool | null {
  const id = Bytes.fromHexString(address.toHexString());
  let pool = LiquidityPool.load(id);
  if (pool != null) {
    return pool;
  }

  const contract = UniswapV3Pool.bind(address);
  const token0Call = contract.try_token0();
  const token1Call = contract.try_token1();
  const feeCall = contract.try_fee();
  if (token0Call.reverted || token1Call.reverted || feeCall.reverted) {
    // Not a Uniswap v3 pool. Nothing to index.
    return null;
  }

  const token0 = getOrCreateToken(token0Call.value);
  const token1 = getOrCreateToken(token1Call.value);
  const feeTier = feeCall.value;

  pool = new LiquidityPool(id);
  const protocol = getOrCreateProtocol();
  pool.protocol = protocol.id;
  pool.name =
    protocol.name +
    " " +
    token0.symbol +
    "/" +
    token1.symbol +
    " " +
    feeTierToPercentage(feeTier).toString() +
    "%";
  pool.symbol = token0.symbol + "/" + token1.symbol;
  pool.inputTokens = [token0.id, token1.id];
  pool.rewardTokens = [];

  // v3 charges one swap fee, all of which accrues to the LP unless the
  // protocol fee switch is flipped on -- which, on mainnet, it is not.
  const tradingFee = feeTierToPercentage(feeTier);
  pool.fees = [
    createFee(FEE_TYPE_FIXED_TRADING, id, tradingFee),
    createFee(FEE_TYPE_FIXED_LP, id, tradingFee),
    createFee(FEE_TYPE_FIXED_PROTOCOL, id, ZERO_BD),
  ];

  pool.isSingleSided = false;
  pool.createdTimestamp = event.block.timestamp;
  pool.createdBlockNumber = event.block.number;

  const slot0 = contract.try_slot0();
  pool.tick = slot0.reverted ? null : BigInt.fromI32(slot0.value.value1);

  const liquidityCall = contract.try_liquidity();
  const activeLiquidity = liquidityCall.reverted ? ZERO_BI : liquidityCall.value;
  pool.totalLiquidity = activeLiquidity;
  pool.totalLiquidityUSD = ZERO_BD;
  pool.activeLiquidity = activeLiquidity;
  pool.activeLiquidityUSD = ZERO_BD;

  pool.uncollectedProtocolSideTokenAmounts = [ZERO_BI, ZERO_BI];
  pool.uncollectedProtocolSideValuesUSD = [ZERO_BD, ZERO_BD];
  pool.uncollectedSupplySideTokenAmounts = [ZERO_BI, ZERO_BI];
  pool.uncollectedSupplySideValuesUSD = [ZERO_BD, ZERO_BD];

  pool.cumulativeSupplySideRevenueUSD = ZERO_BD;
  pool.cumulativeProtocolSideRevenueUSD = ZERO_BD;
  pool.cumulativeTotalRevenueUSD = ZERO_BD;
  pool.cumulativeVolumeByTokenAmount = [ZERO_BI, ZERO_BI];
  pool.cumulativeVolumeByTokenUSD = [ZERO_BD, ZERO_BD];
  pool.cumulativeVolumeUSD = ZERO_BD;

  // Real reserves, read from the tokens rather than accumulated from events.
  pool.inputTokenBalances = [
    tokenBalanceOf(token0, address),
    tokenBalanceOf(token1, address),
  ];
  pool.inputTokenBalancesUSD = [ZERO_BD, ZERO_BD];
  pool.inputTokenWeights = [
    BigDecimal.fromString("50"),
    BigDecimal.fromString("50"),
  ];
  pool.totalValueLockedUSD = ZERO_BD;

  pool.stakedOutputTokenAmount = null;
  pool.rewardTokenEmissionsAmount = null;
  pool.rewardTokenEmissionsUSD = null;

  pool.cumulativeDepositCount = 0;
  pool.cumulativeWithdrawCount = 0;
  pool.cumulativeSwapCount = 0;
  pool.positionCount = 0;
  pool.openPositionCount = 0;
  pool.closedPositionCount = 0;

  pool.lastSnapshotDayID = 0;
  pool.lastSnapshotHourID = 0;
  pool.lastUpdateTimestamp = event.block.timestamp;
  pool.lastUpdateBlockNumber = event.block.number;
  pool.save();

  const amounts = new _LiquidityPoolAmount(id);
  amounts.inputTokens = [token0.id, token1.id];
  amounts.inputTokenBalances = [ZERO_BD, ZERO_BD];
  amounts.tokenPrices = [ZERO_BD, ZERO_BD];
  amounts.save();

  // Price the reserves we just read, rather than reporting a pool that has
  // real balances and a zero TVL until its first swap. WETH and stablecoin
  // pairs resolve immediately; a pair anchored to neither stays at zero, which
  // is the honest answer for a token this subgraph cannot price.
  const initialTVL = refreshPoolValues(pool);
  pool.save();

  protocol.totalPoolCount += 1;
  protocol.totalValueLockedUSD = protocol.totalValueLockedUSD.plus(initialTVL);
  protocol.totalLiquidityUSD = protocol.totalLiquidityUSD.plus(initialTVL);
  protocol.activeLiquidityUSD = protocol.activeLiquidityUSD.plus(initialTVL);
  protocol.lastUpdateTimestamp = event.block.timestamp;
  protocol.lastUpdateBlockNumber = event.block.number;
  protocol.save();

  if (spawnTemplate) {
    PoolTemplate.create(address);
  }

  return pool;
}

/**
 * A concentrated-liquidity `liquidity` value is virtual -- sqrt(x*y), not a
 * token amount -- so the only defensible USD figure for it is the pool's own
 * value per unit of active liquidity. Stated here rather than buried, because
 * the Extended schema demands the field on ticks and positions and an honest
 * reading of it matters.
 */
export function liquidityToUSD(
  pool: LiquidityPool,
  liquidity: BigInt
): BigDecimal {
  if (pool.activeLiquidity.equals(ZERO_BI)) {
    return ZERO_BD;
  }
  const usdPerLiquidity = safeDiv(
    pool.totalValueLockedUSD,
    pool.activeLiquidity.toBigDecimal()
  );
  return liquidity.toBigDecimal().times(usdPerLiquidity);
}

export function getPoolTokens(pool: LiquidityPool): Token[] {
  const ids = pool.inputTokens;
  const tokens: Token[] = [];
  for (let i = 0; i < ids.length; i++) {
    const token = Token.load(ids[i]);
    if (token != null) {
      tokens.push(token);
    }
  }
  return tokens;
}

/**
 * Recompute USD-denominated pool state from the current reserves and prices,
 * and fold the change into the protocol total. Returns the TVL delta so the
 * caller does not have to diff it again.
 */
export function refreshPoolValues(pool: LiquidityPool): BigDecimal {
  const tokens = getPoolTokens(pool);
  if (tokens.length != 2) {
    return ZERO_BD;
  }
  const balances = pool.inputTokenBalances;
  const price0 = priceUSDOrZero(tokens[0]);
  const price1 = priceUSDOrZero(tokens[1]);

  const balance0USD = bigIntToBigDecimal(balances[0], tokens[0].decimals).times(
    price0
  );
  const balance1USD = bigIntToBigDecimal(balances[1], tokens[1].decimals).times(
    price1
  );
  const tvlUSD = balance0USD.plus(balance1USD);

  const previousTvlUSD = pool.totalValueLockedUSD;
  pool.inputTokenBalancesUSD = [balance0USD, balance1USD];
  pool.totalValueLockedUSD = tvlUSD;
  pool.inputTokenWeights = [
    safeDiv(balance0USD, tvlUSD).times(HUNDRED_BD),
    safeDiv(balance1USD, tvlUSD).times(HUNDRED_BD),
  ];

  // A concentrated-liquidity pool's `liquidity` is a virtual quantity, not a
  // token amount, so the only honest USD figure for it is the value actually
  // sitting in the pool.
  pool.totalLiquidityUSD = tvlUSD;
  pool.activeLiquidityUSD = tvlUSD;

  const amounts = _LiquidityPoolAmount.load(pool.id);
  if (amounts != null) {
    amounts.inputTokenBalances = [
      bigIntToBigDecimal(balances[0], tokens[0].decimals),
      bigIntToBigDecimal(balances[1], tokens[1].decimals),
    ];
    amounts.tokenPrices = [price0, price1];
    amounts.save();
  }

  return tvlUSD.minus(previousTvlUSD);
}
