import { Address, BigDecimal, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import {
  DexAmmProtocol,
  FinancialsDailySnapshot,
  LiquidityPool,
  LiquidityPoolDailySnapshot,
  LiquidityPoolHourlySnapshot,
  UsageMetricsDailySnapshot,
  UsageMetricsHourlySnapshot,
  _HelperStore,
} from "../../generated/schema";
import { ZERO_BD, ZERO_BI } from "./constants";
import { getOrCreateAccount, markActive } from "./account";
import { getDayID, getHourID, snapshotId } from "./utils";

export const TX_SWAP: i32 = 0;
export const TX_DEPOSIT: i32 = 1;
export const TX_WITHDRAW: i32 = 2;

// --- previous-interval bookkeeping -------------------------------------------
//
// Every *Snapshot entity carrying interval deltas is immutable in the standard
// schema, so a snapshot can only be written once -- at the moment its interval
// rolls over. The delta is then `cumulative now` minus `cumulative at the last
// rollover`, and the second term has to live somewhere. _HelperStore is the
// schema's own escape hatch for exactly this, so it goes there rather than into
// a non-standard entity that would break conformance.

function loadPrevious(id: Bytes, size: i32): BigDecimal[] {
  const store = _HelperStore.load(id);
  if (store != null) {
    const values = store.valueDecimalList;
    if (values != null && (values as BigDecimal[]).length == size) {
      return values as BigDecimal[];
    }
  }
  const zeros: BigDecimal[] = [];
  for (let i = 0; i < size; i++) {
    zeros.push(ZERO_BD);
  }
  return zeros;
}

function storePrevious(id: Bytes, values: BigDecimal[]): void {
  let store = _HelperStore.load(id);
  if (store == null) {
    store = new _HelperStore(id);
  }
  store.valueDecimalList = values;
  store.save();
}

function toBD(value: BigInt): BigDecimal {
  return value.toBigDecimal();
}

function toBI(value: BigDecimal): BigInt {
  return BigInt.fromString(value.truncate(0).toString());
}

function countBD(value: i32): BigDecimal {
  return BigDecimal.fromString(value.toString());
}

function countI32(value: BigDecimal): i32 {
  return toBI(value).toI32();
}

// --- usage metrics -----------------------------------------------------------
//
// These two are the only snapshots the standard leaves mutable, so they are
// updated in place and the current, still-open interval is queryable.

export function updateUsageMetrics(
  event: ethereum.Event,
  accountAddress: Address,
  txType: i32,
  protocol: DexAmmProtocol
): void {
  const day = getDayID(event.block.timestamp);
  const hour = getHourID(event.block.timestamp);

  const result = getOrCreateAccount(accountAddress);
  if (result.isNew) {
    protocol.cumulativeUniqueUsers += 1;
    if (txType == TX_SWAP) {
      protocol.cumulativeUniqueTraders += 1;
    } else {
      protocol.cumulativeUniqueLPs += 1;
    }
  }

  const account = result.account;
  if (txType == TX_SWAP) {
    account.swapCount += 1;
  } else if (txType == TX_DEPOSIT) {
    account.depositCount += 1;
  } else {
    account.withdrawCount += 1;
  }
  account.save();

  const dailyId = Bytes.fromUTF8(day.toString());
  let daily = UsageMetricsDailySnapshot.load(dailyId);
  if (daily == null) {
    daily = new UsageMetricsDailySnapshot(dailyId);
    daily.day = day;
    daily.protocol = protocol.id;
    daily.dailyActiveUsers = 0;
    daily.dailyTransactionCount = 0;
    daily.dailyDepositCount = 0;
    daily.dailyWithdrawCount = 0;
    daily.dailySwapCount = 0;
  }
  if (markActive(account.id, "day", day)) {
    daily.dailyActiveUsers += 1;
  }
  daily.cumulativeUniqueUsers = protocol.cumulativeUniqueUsers;
  daily.totalPoolCount = protocol.totalPoolCount;
  daily.dailyTransactionCount += 1;
  if (txType == TX_SWAP) {
    daily.dailySwapCount += 1;
  } else if (txType == TX_DEPOSIT) {
    daily.dailyDepositCount += 1;
  } else {
    daily.dailyWithdrawCount += 1;
  }
  daily.timestamp = event.block.timestamp;
  daily.blockNumber = event.block.number;
  daily.save();

  const hourlyId = Bytes.fromUTF8(hour.toString());
  let hourly = UsageMetricsHourlySnapshot.load(hourlyId);
  if (hourly == null) {
    hourly = new UsageMetricsHourlySnapshot(hourlyId);
    hourly.hour = hour;
    hourly.protocol = protocol.id;
    hourly.hourlyActiveUsers = 0;
    hourly.hourlyTransactionCount = 0;
    hourly.hourlyDepositCount = 0;
    hourly.hourlyWithdrawCount = 0;
    hourly.hourlySwapCount = 0;
  }
  if (markActive(account.id, "hour", hour)) {
    hourly.hourlyActiveUsers += 1;
  }
  hourly.cumulativeUniqueUsers = protocol.cumulativeUniqueUsers;
  hourly.hourlyTransactionCount += 1;
  if (txType == TX_SWAP) {
    hourly.hourlySwapCount += 1;
  } else if (txType == TX_DEPOSIT) {
    hourly.hourlyDepositCount += 1;
  } else {
    hourly.hourlyWithdrawCount += 1;
  }
  hourly.timestamp = event.block.timestamp;
  hourly.blockNumber = event.block.number;
  hourly.save();
}

// --- protocol financials ------------------------------------------------------

const FINANCIALS_PREV = Bytes.fromUTF8("PREV-FINANCIALS-DAILY");

export function updateFinancialsSnapshot(
  event: ethereum.Event,
  protocol: DexAmmProtocol
): void {
  const day = getDayID(event.block.timestamp);

  if (protocol.lastSnapshotDayID == 0) {
    protocol.lastSnapshotDayID = day;
    return;
  }
  if (day <= protocol.lastSnapshotDayID) {
    return;
  }

  const closingDay = protocol.lastSnapshotDayID;
  const id = Bytes.fromUTF8(closingDay.toString());
  if (FinancialsDailySnapshot.load(id) == null) {
    const previous = loadPrevious(FINANCIALS_PREV, 4);
    const snapshot = new FinancialsDailySnapshot(id);
    snapshot.day = closingDay;
    snapshot.protocol = protocol.id;
    snapshot.totalValueLockedUSD = protocol.totalValueLockedUSD;
    snapshot.totalLiquidityUSD = protocol.totalLiquidityUSD;
    snapshot.activeLiquidityUSD = protocol.activeLiquidityUSD;
    snapshot.uncollectedProtocolSideValueUSD =
      protocol.uncollectedProtocolSideValueUSD;
    snapshot.uncollectedSupplySideValueUSD =
      protocol.uncollectedSupplySideValueUSD;
    snapshot.protocolControlledValueUSD = null;

    snapshot.cumulativeVolumeUSD = protocol.cumulativeVolumeUSD;
    snapshot.cumulativeSupplySideRevenueUSD =
      protocol.cumulativeSupplySideRevenueUSD;
    snapshot.cumulativeProtocolSideRevenueUSD =
      protocol.cumulativeProtocolSideRevenueUSD;
    snapshot.cumulativeTotalRevenueUSD = protocol.cumulativeTotalRevenueUSD;

    snapshot.dailyVolumeUSD = protocol.cumulativeVolumeUSD.minus(previous[0]);
    snapshot.dailySupplySideRevenueUSD =
      protocol.cumulativeSupplySideRevenueUSD.minus(previous[1]);
    snapshot.dailyProtocolSideRevenueUSD =
      protocol.cumulativeProtocolSideRevenueUSD.minus(previous[2]);
    snapshot.dailyTotalRevenueUSD = protocol.cumulativeTotalRevenueUSD.minus(
      previous[3]
    );

    snapshot.timestamp = event.block.timestamp;
    snapshot.blockNumber = event.block.number;
    snapshot.save();

    storePrevious(FINANCIALS_PREV, [
      protocol.cumulativeVolumeUSD,
      protocol.cumulativeSupplySideRevenueUSD,
      protocol.cumulativeProtocolSideRevenueUSD,
      protocol.cumulativeTotalRevenueUSD,
    ]);
  }

  protocol.lastSnapshotDayID = day;
}

// --- pool snapshots -----------------------------------------------------------
//
// Layout of the previous-cumulative list, shared by both intervals:
//   0 volumeUSD              4 volumeByTokenAmount[0]   8  depositCount
//   1 supplySideRevenueUSD   5 volumeByTokenAmount[1]   9  withdrawCount
//   2 protocolSideRevenueUSD 6 volumeByTokenUSD[0]      10 swapCount
//   3 totalRevenueUSD        7 volumeByTokenUSD[1]

const POOL_PREV_SIZE: i32 = 11;

function poolPreviousId(pool: LiquidityPool, tag: string): Bytes {
  return Bytes.fromUTF8("PREV-POOL-" + tag + "-").concat(pool.id);
}

function poolCumulativeList(pool: LiquidityPool): BigDecimal[] {
  const byTokenAmount = pool.cumulativeVolumeByTokenAmount;
  const byTokenUSD = pool.cumulativeVolumeByTokenUSD;
  return [
    pool.cumulativeVolumeUSD,
    pool.cumulativeSupplySideRevenueUSD,
    pool.cumulativeProtocolSideRevenueUSD,
    pool.cumulativeTotalRevenueUSD,
    byTokenAmount.length > 0 ? toBD(byTokenAmount[0]) : ZERO_BD,
    byTokenAmount.length > 1 ? toBD(byTokenAmount[1]) : ZERO_BD,
    byTokenUSD.length > 0 ? byTokenUSD[0] : ZERO_BD,
    byTokenUSD.length > 1 ? byTokenUSD[1] : ZERO_BD,
    countBD(pool.cumulativeDepositCount),
    countBD(pool.cumulativeWithdrawCount),
    countBD(pool.cumulativeSwapCount),
  ];
}

export function updatePoolSnapshots(
  event: ethereum.Event,
  pool: LiquidityPool,
  protocol: DexAmmProtocol
): void {
  const day = getDayID(event.block.timestamp);
  const hour = getHourID(event.block.timestamp);

  if (pool.lastSnapshotDayID == 0) {
    pool.lastSnapshotDayID = day;
  } else if (day > pool.lastSnapshotDayID) {
    writePoolDaily(event, pool, protocol, pool.lastSnapshotDayID);
    pool.lastSnapshotDayID = day;
  }

  if (pool.lastSnapshotHourID == 0) {
    pool.lastSnapshotHourID = hour;
  } else if (hour > pool.lastSnapshotHourID) {
    writePoolHourly(event, pool, protocol, pool.lastSnapshotHourID);
    pool.lastSnapshotHourID = hour;
  }
}

function writePoolDaily(
  event: ethereum.Event,
  pool: LiquidityPool,
  protocol: DexAmmProtocol,
  closingDay: i32
): void {
  const id = snapshotId(pool.id, closingDay);
  if (LiquidityPoolDailySnapshot.load(id) != null) {
    return;
  }
  const prevId = poolPreviousId(pool, "DAILY");
  const previous = loadPrevious(prevId, POOL_PREV_SIZE);
  const current = poolCumulativeList(pool);

  const snapshot = new LiquidityPoolDailySnapshot(id);
  snapshot.day = closingDay;
  snapshot.protocol = protocol.id;
  snapshot.pool = pool.id;
  snapshot.tick = pool.tick;
  snapshot.totalValueLockedUSD = pool.totalValueLockedUSD;
  snapshot.totalLiquidity = pool.totalLiquidity;
  snapshot.totalLiquidityUSD = pool.totalLiquidityUSD;
  snapshot.activeLiquidity = pool.activeLiquidity;
  snapshot.activeLiquidityUSD = pool.activeLiquidityUSD;
  snapshot.uncollectedProtocolSideTokenAmounts =
    pool.uncollectedProtocolSideTokenAmounts;
  snapshot.uncollectedProtocolSideValuesUSD =
    pool.uncollectedProtocolSideValuesUSD;
  snapshot.uncollectedSupplySideTokenAmounts =
    pool.uncollectedSupplySideTokenAmounts;
  snapshot.uncollectedSupplySideValuesUSD =
    pool.uncollectedSupplySideValuesUSD;

  snapshot.cumulativeSupplySideRevenueUSD = pool.cumulativeSupplySideRevenueUSD;
  snapshot.dailySupplySideRevenueUSD = current[1].minus(previous[1]);
  snapshot.cumulativeProtocolSideRevenueUSD =
    pool.cumulativeProtocolSideRevenueUSD;
  snapshot.dailyProtocolSideRevenueUSD = current[2].minus(previous[2]);
  snapshot.cumulativeTotalRevenueUSD = pool.cumulativeTotalRevenueUSD;
  snapshot.dailyTotalRevenueUSD = current[3].minus(previous[3]);
  snapshot.cumulativeVolumeUSD = pool.cumulativeVolumeUSD;
  snapshot.dailyVolumeUSD = current[0].minus(previous[0]);
  snapshot.cumulativeVolumeByTokenAmount = pool.cumulativeVolumeByTokenAmount;
  snapshot.dailyVolumeByTokenAmount = [
    toBI(current[4].minus(previous[4])),
    toBI(current[5].minus(previous[5])),
  ];
  snapshot.cumulativeVolumeByTokenUSD = pool.cumulativeVolumeByTokenUSD;
  snapshot.dailyVolumeByTokenUSD = [
    current[6].minus(previous[6]),
    current[7].minus(previous[7]),
  ];

  snapshot.inputTokenBalances = pool.inputTokenBalances;
  snapshot.inputTokenBalancesUSD = pool.inputTokenBalancesUSD;
  snapshot.inputTokenWeights = pool.inputTokenWeights;
  snapshot.stakedOutputTokenAmount = pool.stakedOutputTokenAmount;
  snapshot.rewardTokenEmissionsAmount = pool.rewardTokenEmissionsAmount;
  snapshot.rewardTokenEmissionsUSD = pool.rewardTokenEmissionsUSD;

  snapshot.cumulativeDepositCount = pool.cumulativeDepositCount;
  snapshot.dailyDepositCount = countI32(current[8].minus(previous[8]));
  snapshot.cumulativeWithdrawCount = pool.cumulativeWithdrawCount;
  snapshot.dailyWithdrawCount = countI32(current[9].minus(previous[9]));
  snapshot.cumulativeSwapCount = pool.cumulativeSwapCount;
  snapshot.dailySwapCount = countI32(current[10].minus(previous[10]));

  snapshot.positionCount = pool.positionCount;
  snapshot.openPositionCount = pool.openPositionCount;
  snapshot.closedPositionCount = pool.closedPositionCount;
  snapshot.timestamp = event.block.timestamp;
  snapshot.blockNumber = event.block.number;
  snapshot.save();

  storePrevious(prevId, current);
}

function writePoolHourly(
  event: ethereum.Event,
  pool: LiquidityPool,
  protocol: DexAmmProtocol,
  closingHour: i32
): void {
  const id = snapshotId(pool.id, closingHour);
  if (LiquidityPoolHourlySnapshot.load(id) != null) {
    return;
  }
  const prevId = poolPreviousId(pool, "HOURLY");
  const previous = loadPrevious(prevId, POOL_PREV_SIZE);
  const current = poolCumulativeList(pool);

  const snapshot = new LiquidityPoolHourlySnapshot(id);
  snapshot.hour = closingHour;
  snapshot.protocol = protocol.id;
  snapshot.pool = pool.id;
  snapshot.tick = pool.tick;
  snapshot.totalValueLockedUSD = pool.totalValueLockedUSD;
  snapshot.totalLiquidity = pool.totalLiquidity;
  snapshot.totalLiquidityUSD = pool.totalLiquidityUSD;
  snapshot.activeLiquidity = pool.activeLiquidity;
  snapshot.activeLiquidityUSD = pool.activeLiquidityUSD;
  snapshot.uncollectedProtocolSideTokenAmounts =
    pool.uncollectedProtocolSideTokenAmounts;
  snapshot.uncollectedProtocolSideValuesUSD =
    pool.uncollectedProtocolSideValuesUSD;
  snapshot.uncollectedSupplySideTokenAmounts =
    pool.uncollectedSupplySideTokenAmounts;
  snapshot.uncollectedSupplySideValuesUSD =
    pool.uncollectedSupplySideValuesUSD;

  snapshot.cumulativeSupplySideRevenueUSD = pool.cumulativeSupplySideRevenueUSD;
  snapshot.hourlySupplySideRevenueUSD = current[1].minus(previous[1]);
  snapshot.cumulativeProtocolSideRevenueUSD =
    pool.cumulativeProtocolSideRevenueUSD;
  snapshot.hourlyProtocolSideRevenueUSD = current[2].minus(previous[2]);
  snapshot.cumulativeTotalRevenueUSD = pool.cumulativeTotalRevenueUSD;
  snapshot.hourlyTotalRevenueUSD = current[3].minus(previous[3]);
  snapshot.cumulativeVolumeUSD = pool.cumulativeVolumeUSD;
  snapshot.hourlyVolumeUSD = current[0].minus(previous[0]);
  snapshot.cumulativeVolumeByTokenAmount = pool.cumulativeVolumeByTokenAmount;
  snapshot.hourlyVolumeByTokenAmount = [
    toBI(current[4].minus(previous[4])),
    toBI(current[5].minus(previous[5])),
  ];
  snapshot.cumulativeVolumeByTokenUSD = pool.cumulativeVolumeByTokenUSD;
  snapshot.hourlyVolumeByTokenUSD = [
    current[6].minus(previous[6]),
    current[7].minus(previous[7]),
  ];

  snapshot.inputTokenBalances = pool.inputTokenBalances;
  snapshot.inputTokenBalancesUSD = pool.inputTokenBalancesUSD;
  snapshot.inputTokenWeights = pool.inputTokenWeights;
  snapshot.stakedOutputTokenAmount = pool.stakedOutputTokenAmount;
  snapshot.rewardTokenEmissionsAmount = pool.rewardTokenEmissionsAmount;
  snapshot.rewardTokenEmissionsUSD = pool.rewardTokenEmissionsUSD;

  snapshot.cumulativeDepositCount = pool.cumulativeDepositCount;
  snapshot.hourlyDepositCount = countI32(current[8].minus(previous[8]));
  snapshot.cumulativeWithdrawCount = pool.cumulativeWithdrawCount;
  snapshot.hourlyWithdrawCount = countI32(current[9].minus(previous[9]));
  snapshot.cumulativeSwapCount = pool.cumulativeSwapCount;
  snapshot.hourlySwapCount = countI32(current[10].minus(previous[10]));

  snapshot.positionCount = pool.positionCount;
  snapshot.openPositionCount = pool.openPositionCount;
  snapshot.closedPositionCount = pool.closedPositionCount;
  snapshot.timestamp = event.block.timestamp;
  snapshot.blockNumber = event.block.number;
  snapshot.save();

  storePrevious(prevId, current);
}
