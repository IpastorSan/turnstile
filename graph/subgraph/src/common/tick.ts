import { BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import {
  LiquidityPool,
  Tick,
  TickDailySnapshot,
  TickHourlySnapshot,
} from "../../generated/schema";
import { ZERO_BD, ZERO_BI } from "./constants";
import { getPoolTokens, liquidityToUSD } from "./liquidityPool";
import { getDayID, getHourID, snapshotId, tickToPrices } from "./utils";

export function tickId(pool: LiquidityPool, index: BigInt): Bytes {
  return pool.id.concat(Bytes.fromUTF8("-" + index.toString()));
}

export function getOrCreateTick(
  pool: LiquidityPool,
  index: BigInt,
  event: ethereum.Event
): Tick {
  const id = tickId(pool, index);
  let tick = Tick.load(id);
  if (tick != null) {
    return tick;
  }

  tick = new Tick(id);
  tick.index = index;
  tick.pool = pool.id;
  tick.createdTimestamp = event.block.timestamp;
  tick.createdBlockNumber = event.block.number;

  const tokens = getPoolTokens(pool);
  tick.prices =
    tokens.length == 2
      ? tickToPrices(index, tokens[0].decimals, tokens[1].decimals)
      : [ZERO_BD, ZERO_BD];

  tick.liquidityGross = ZERO_BI;
  tick.liquidityGrossUSD = ZERO_BD;
  tick.liquidityNet = ZERO_BI;
  tick.liquidityNetUSD = ZERO_BD;
  tick.lastSnapshotDayID = 0;
  tick.lastSnapshotHourID = 0;
  tick.lastUpdateTimestamp = event.block.timestamp;
  tick.lastUpdateBlockNumber = event.block.number;
  tick.save();

  return tick;
}

/**
 * Apply a liquidity delta to one end of a range, exactly as the pool does:
 * gross is unsigned exposure, net is signed and flips at the upper bound.
 */
export function updateTick(
  pool: LiquidityPool,
  index: BigInt,
  liquidityDelta: BigInt,
  isUpper: boolean,
  event: ethereum.Event
): void {
  const tick = getOrCreateTick(pool, index, event);

  tick.liquidityGross = tick.liquidityGross.plus(liquidityDelta);
  tick.liquidityNet = isUpper
    ? tick.liquidityNet.minus(liquidityDelta)
    : tick.liquidityNet.plus(liquidityDelta);

  tick.liquidityGrossUSD = liquidityToUSD(pool, tick.liquidityGross);
  tick.liquidityNetUSD = liquidityToUSD(pool, tick.liquidityNet);
  tick.lastUpdateTimestamp = event.block.timestamp;
  tick.lastUpdateBlockNumber = event.block.number;

  snapshotTick(tick, pool, event);
  tick.save();
}

/**
 * Tick snapshots carry no interval deltas, only levels, so they are written on
 * the rollover of the interval they close. The entities are immutable, which is
 * why the write happens once per interval rather than on every touch.
 */
function snapshotTick(
  tick: Tick,
  pool: LiquidityPool,
  event: ethereum.Event
): void {
  const day = getDayID(event.block.timestamp);
  const hour = getHourID(event.block.timestamp);

  if (tick.lastSnapshotDayID == 0) {
    tick.lastSnapshotDayID = day;
  } else if (day > tick.lastSnapshotDayID) {
    const id = snapshotId(tick.id, tick.lastSnapshotDayID);
    if (TickDailySnapshot.load(id) == null) {
      const snapshot = new TickDailySnapshot(id);
      snapshot.day = tick.lastSnapshotDayID;
      snapshot.tick = tick.id;
      snapshot.pool = pool.id;
      snapshot.liquidityGross = tick.liquidityGross;
      snapshot.liquidityGrossUSD = tick.liquidityGrossUSD;
      snapshot.liquidityNet = tick.liquidityNet;
      snapshot.liquidityNetUSD = tick.liquidityNetUSD;
      snapshot.timestamp = event.block.timestamp;
      snapshot.blockNumber = event.block.number;
      snapshot.save();
    }
    tick.lastSnapshotDayID = day;
  }

  if (tick.lastSnapshotHourID == 0) {
    tick.lastSnapshotHourID = hour;
  } else if (hour > tick.lastSnapshotHourID) {
    const id = snapshotId(tick.id, tick.lastSnapshotHourID);
    if (TickHourlySnapshot.load(id) == null) {
      const snapshot = new TickHourlySnapshot(id);
      snapshot.hour = tick.lastSnapshotHourID;
      snapshot.tick = tick.id;
      snapshot.pool = pool.id;
      snapshot.liquidityGross = tick.liquidityGross;
      snapshot.liquidityGrossUSD = tick.liquidityGrossUSD;
      snapshot.liquidityNet = tick.liquidityNet;
      snapshot.liquidityNetUSD = tick.liquidityNetUSD;
      snapshot.timestamp = event.block.timestamp;
      snapshot.blockNumber = event.block.number;
      snapshot.save();
    }
    tick.lastSnapshotHourID = hour;
  }
}
