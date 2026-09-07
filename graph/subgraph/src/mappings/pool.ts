import { BigDecimal, BigInt } from "@graphprotocol/graph-ts";
import {
  Burn,
  Initialize,
  Mint,
  Swap as SwapEvent,
} from "../../generated/templates/Pool/UniswapV3Pool";
import { Deposit, LiquidityPool, Swap, Withdraw } from "../../generated/schema";
import { HUNDRED_BD, ZERO_BD, ZERO_BI } from "../common/constants";
import {
  getOrCreatePool,
  getPoolFeePercentage,
  getPoolTokens,
  refreshPoolValues,
} from "../common/liquidityPool";
import { priceUSDOrZero, updatePricesFromSqrtPrice } from "../common/pricing";
import { getOrCreateProtocol } from "../common/protocol";
import {
  TX_DEPOSIT,
  TX_SWAP,
  TX_WITHDRAW,
  updateFinancialsSnapshot,
  updatePoolSnapshots,
  updateUsageMetrics,
} from "../common/snapshots";
import { updateTick } from "../common/tick";
import { absBigInt, bigIntToBigDecimal, eventId } from "../common/utils";

/** Add signed deltas to the pool's reserves. */
function applyBalanceDeltas(
  pool: LiquidityPool,
  delta0: BigInt,
  delta1: BigInt
): void {
  const balances = pool.inputTokenBalances;
  pool.inputTokenBalances = [balances[0].plus(delta0), balances[1].plus(delta1)];
}

function addVolume(
  pool: LiquidityPool,
  amount0: BigInt,
  amount1: BigInt,
  usd0: BigDecimal,
  usd1: BigDecimal
): void {
  const amounts = pool.cumulativeVolumeByTokenAmount;
  pool.cumulativeVolumeByTokenAmount = [
    amounts[0].plus(amount0),
    amounts[1].plus(amount1),
  ];
  const usd = pool.cumulativeVolumeByTokenUSD;
  pool.cumulativeVolumeByTokenUSD = [usd[0].plus(usd0), usd[1].plus(usd1)];
}

export function handleInitialize(event: Initialize): void {
  const pool = getOrCreatePool(event.address, event, false);
  if (pool == null) {
    return;
  }
  const tokens = getPoolTokens(pool);
  if (tokens.length != 2) {
    return;
  }
  pool.tick = BigInt.fromI32(event.params.tick);
  updatePricesFromSqrtPrice(
    pool,
    tokens[0],
    tokens[1],
    event.params.sqrtPriceX96,
    event.block.number
  );

  // Initialize is the first moment a brand-new pool has a price at all, so the
  // TVL it produces has to reach the protocol total like any other change.
  const protocol = getOrCreateProtocol();
  const tvlDelta = refreshPoolValues(pool);
  protocol.totalValueLockedUSD = protocol.totalValueLockedUSD.plus(tvlDelta);
  protocol.totalLiquidityUSD = protocol.totalLiquidityUSD.plus(tvlDelta);
  protocol.activeLiquidityUSD = protocol.activeLiquidityUSD.plus(tvlDelta);
  protocol.lastUpdateTimestamp = event.block.timestamp;
  protocol.lastUpdateBlockNumber = event.block.number;
  protocol.save();

  pool.lastUpdateTimestamp = event.block.timestamp;
  pool.lastUpdateBlockNumber = event.block.number;
  pool.save();
}

export function handleSwap(event: SwapEvent): void {
  const pool = getOrCreatePool(event.address, event, false);
  if (pool == null) {
    return;
  }
  const tokens = getPoolTokens(pool);
  if (tokens.length != 2) {
    return;
  }
  const protocol = getOrCreateProtocol();

  // Signed from the pool's point of view: positive flows in, negative flows out.
  const amount0 = event.params.amount0;
  const amount1 = event.params.amount1;

  pool.tick = BigInt.fromI32(event.params.tick);
  pool.activeLiquidity = event.params.liquidity;
  updatePricesFromSqrtPrice(
    pool,
    tokens[0],
    tokens[1],
    event.params.sqrtPriceX96,
    event.block.number
  );

  const zeroForOne = amount0.gt(ZERO_BI);
  const tokenIn = zeroForOne ? tokens[0] : tokens[1];
  const tokenOut = zeroForOne ? tokens[1] : tokens[0];
  const amountIn = absBigInt(zeroForOne ? amount0 : amount1);
  const amountOut = absBigInt(zeroForOne ? amount1 : amount0);

  const amountInUSD = bigIntToBigDecimal(amountIn, tokenIn.decimals).times(
    priceUSDOrZero(tokenIn)
  );
  const amountOutUSD = bigIntToBigDecimal(amountOut, tokenOut.decimals).times(
    priceUSDOrZero(tokenOut)
  );

  // Both sides of a swap are the same trade. Averaging them where both are
  // priced keeps a single mis-priced side from doubling reported volume.
  let volumeUSD = ZERO_BD;
  if (amountInUSD.gt(ZERO_BD) && amountOutUSD.gt(ZERO_BD)) {
    volumeUSD = amountInUSD.plus(amountOutUSD).div(BigDecimal.fromString("2"));
  } else {
    volumeUSD = amountInUSD.gt(amountOutUSD) ? amountInUSD : amountOutUSD;
  }

  applyBalanceDeltas(pool, amount0, amount1);
  const usd0 = zeroForOne ? amountInUSD : amountOutUSD;
  const usd1 = zeroForOne ? amountOutUSD : amountInUSD;
  addVolume(pool, absBigInt(amount0), absBigInt(amount1), usd0, usd1);
  pool.cumulativeVolumeUSD = pool.cumulativeVolumeUSD.plus(volumeUSD);
  pool.cumulativeSwapCount += 1;

  // The v3 swap fee is charged on the input side and, with the protocol fee
  // switch off on mainnet, accrues entirely to liquidity providers.
  const feeUSD = volumeUSD.times(getPoolFeePercentage(pool)).div(HUNDRED_BD);
  pool.cumulativeSupplySideRevenueUSD =
    pool.cumulativeSupplySideRevenueUSD.plus(feeUSD);
  pool.cumulativeTotalRevenueUSD = pool.cumulativeTotalRevenueUSD.plus(feeUSD);

  const tvlDelta = refreshPoolValues(pool);
  protocol.totalValueLockedUSD = protocol.totalValueLockedUSD.plus(tvlDelta);
  protocol.totalLiquidityUSD = protocol.totalLiquidityUSD.plus(tvlDelta);
  protocol.activeLiquidityUSD = protocol.activeLiquidityUSD.plus(tvlDelta);
  protocol.cumulativeVolumeUSD = protocol.cumulativeVolumeUSD.plus(volumeUSD);
  protocol.cumulativeSupplySideRevenueUSD =
    protocol.cumulativeSupplySideRevenueUSD.plus(feeUSD);
  protocol.cumulativeTotalRevenueUSD =
    protocol.cumulativeTotalRevenueUSD.plus(feeUSD);

  const swap = new Swap(eventId(event));
  swap.hash = event.transaction.hash;
  swap.nonce = event.transaction.nonce;
  swap.logIndex = event.logIndex.toI32();
  swap.gasLimit = event.transaction.gasLimit;
  swap.gasPrice = event.transaction.gasPrice;
  swap.protocol = protocol.id;
  swap.account = event.transaction.from;
  swap.pool = pool.id;
  swap.blockNumber = event.block.number;
  swap.timestamp = event.block.timestamp;
  swap.tick = pool.tick;
  swap.tokenIn = tokenIn.id;
  swap.amountIn = amountIn;
  swap.amountInUSD = amountInUSD;
  swap.tokenOut = tokenOut.id;
  swap.amountOut = amountOut;
  swap.amountOutUSD = amountOutUSD;
  swap.reserveAmounts = pool.inputTokenBalances;
  swap.save();

  updateUsageMetrics(event, event.transaction.from, TX_SWAP, protocol);
  updatePoolSnapshots(event, pool, protocol);
  updateFinancialsSnapshot(event, protocol);

  pool.lastUpdateTimestamp = event.block.timestamp;
  pool.lastUpdateBlockNumber = event.block.number;
  pool.save();
  protocol.lastUpdateTimestamp = event.block.timestamp;
  protocol.lastUpdateBlockNumber = event.block.number;
  protocol.save();
}

export function handleMint(event: Mint): void {
  const pool = getOrCreatePool(event.address, event, false);
  if (pool == null) {
    return;
  }
  const tokens = getPoolTokens(pool);
  if (tokens.length != 2) {
    return;
  }
  const protocol = getOrCreateProtocol();

  const amount0 = event.params.amount0;
  const amount1 = event.params.amount1;
  const liquidity = event.params.amount;
  const tickLower = BigInt.fromI32(event.params.tickLower);
  const tickUpper = BigInt.fromI32(event.params.tickUpper);

  applyBalanceDeltas(pool, amount0, amount1);
  pool.totalLiquidity = pool.totalLiquidity.plus(liquidity);
  // Liquidity only counts as active while the pool's tick sits inside the range.
  const currentTick = pool.tick;
  if (
    currentTick !== null &&
    (currentTick as BigInt).ge(tickLower) &&
    (currentTick as BigInt).lt(tickUpper)
  ) {
    pool.activeLiquidity = pool.activeLiquidity.plus(liquidity);
  }
  pool.cumulativeDepositCount += 1;

  const amountUSD = bigIntToBigDecimal(amount0, tokens[0].decimals)
    .times(priceUSDOrZero(tokens[0]))
    .plus(
      bigIntToBigDecimal(amount1, tokens[1].decimals).times(
        priceUSDOrZero(tokens[1])
      )
    );

  const tvlDelta = refreshPoolValues(pool);
  protocol.totalValueLockedUSD = protocol.totalValueLockedUSD.plus(tvlDelta);
  protocol.totalLiquidityUSD = protocol.totalLiquidityUSD.plus(tvlDelta);
  protocol.activeLiquidityUSD = protocol.activeLiquidityUSD.plus(tvlDelta);

  updateTick(pool, tickLower, liquidity, false, event);
  updateTick(pool, tickUpper, liquidity, true, event);

  const deposit = new Deposit(eventId(event));
  deposit.hash = event.transaction.hash;
  deposit.nonce = event.transaction.nonce;
  deposit.logIndex = event.logIndex.toI32();
  deposit.gasLimit = event.transaction.gasLimit;
  deposit.gasPrice = event.transaction.gasPrice;
  deposit.protocol = protocol.id;
  deposit.account = event.transaction.from;
  deposit.pool = pool.id;
  deposit.tickLower = tickLower;
  deposit.tickUpper = tickUpper;
  deposit.blockNumber = event.block.number;
  deposit.timestamp = event.block.timestamp;
  deposit.liquidity = liquidity;
  deposit.inputTokens = [tokens[0].id, tokens[1].id];
  deposit.inputTokenAmounts = [amount0, amount1];
  deposit.reserveAmounts = pool.inputTokenBalances;
  deposit.amountUSD = amountUSD;
  deposit.save();

  updateUsageMetrics(event, event.transaction.from, TX_DEPOSIT, protocol);
  updatePoolSnapshots(event, pool, protocol);
  updateFinancialsSnapshot(event, protocol);

  pool.lastUpdateTimestamp = event.block.timestamp;
  pool.lastUpdateBlockNumber = event.block.number;
  pool.save();
  protocol.lastUpdateTimestamp = event.block.timestamp;
  protocol.lastUpdateBlockNumber = event.block.number;
  protocol.save();
}

export function handleBurn(event: Burn): void {
  const pool = getOrCreatePool(event.address, event, false);
  if (pool == null) {
    return;
  }
  const tokens = getPoolTokens(pool);
  if (tokens.length != 2) {
    return;
  }
  const protocol = getOrCreateProtocol();

  const amount0 = event.params.amount0;
  const amount1 = event.params.amount1;
  const liquidity = event.params.amount;
  const tickLower = BigInt.fromI32(event.params.tickLower);
  const tickUpper = BigInt.fromI32(event.params.tickUpper);

  // Burn credits the amounts as owed rather than transferring them, and Collect
  // moves them out later. Treating the burn as the withdrawal is what every
  // production v3 subgraph does: it keeps reserves and TVL aligned with the
  // liquidity that is actually still working.
  applyBalanceDeltas(pool, amount0.neg(), amount1.neg());
  pool.totalLiquidity = pool.totalLiquidity.minus(liquidity);
  const currentTick = pool.tick;
  if (
    currentTick !== null &&
    (currentTick as BigInt).ge(tickLower) &&
    (currentTick as BigInt).lt(tickUpper)
  ) {
    pool.activeLiquidity = pool.activeLiquidity.minus(liquidity);
  }
  pool.cumulativeWithdrawCount += 1;

  const amountUSD = bigIntToBigDecimal(amount0, tokens[0].decimals)
    .times(priceUSDOrZero(tokens[0]))
    .plus(
      bigIntToBigDecimal(amount1, tokens[1].decimals).times(
        priceUSDOrZero(tokens[1])
      )
    );

  const tvlDelta = refreshPoolValues(pool);
  protocol.totalValueLockedUSD = protocol.totalValueLockedUSD.plus(tvlDelta);
  protocol.totalLiquidityUSD = protocol.totalLiquidityUSD.plus(tvlDelta);
  protocol.activeLiquidityUSD = protocol.activeLiquidityUSD.plus(tvlDelta);

  updateTick(pool, tickLower, liquidity.neg(), false, event);
  updateTick(pool, tickUpper, liquidity.neg(), true, event);

  const withdraw = new Withdraw(eventId(event));
  withdraw.hash = event.transaction.hash;
  withdraw.nonce = event.transaction.nonce;
  withdraw.logIndex = event.logIndex.toI32();
  withdraw.gasLimit = event.transaction.gasLimit;
  withdraw.gasPrice = event.transaction.gasPrice;
  withdraw.protocol = protocol.id;
  withdraw.account = event.transaction.from;
  withdraw.pool = pool.id;
  withdraw.tickLower = tickLower;
  withdraw.tickUpper = tickUpper;
  withdraw.blockNumber = event.block.number;
  withdraw.timestamp = event.block.timestamp;
  withdraw.liquidity = liquidity;
  withdraw.inputTokens = [tokens[0].id, tokens[1].id];
  withdraw.inputTokenAmounts = [amount0, amount1];
  withdraw.reserveAmounts = pool.inputTokenBalances;
  withdraw.amountUSD = amountUSD;
  withdraw.save();

  updateUsageMetrics(event, event.transaction.from, TX_WITHDRAW, protocol);
  updatePoolSnapshots(event, pool, protocol);
  updateFinancialsSnapshot(event, protocol);

  pool.lastUpdateTimestamp = event.block.timestamp;
  pool.lastUpdateBlockNumber = event.block.number;
  pool.save();
  protocol.lastUpdateTimestamp = event.block.timestamp;
  protocol.lastUpdateBlockNumber = event.block.number;
  protocol.save();
}
