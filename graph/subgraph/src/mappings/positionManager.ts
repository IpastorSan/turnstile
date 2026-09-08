import {
  Address,
  BigDecimal,
  BigInt,
  Bytes,
  ethereum,
} from "@graphprotocol/graph-ts";
import {
  DecreaseLiquidity,
  IncreaseLiquidity,
  NonfungiblePositionManager,
  Transfer,
} from "../../generated/PositionManager/NonfungiblePositionManager";
import { UniswapV3Factory } from "../../generated/PositionManager/UniswapV3Factory";
import {
  LiquidityPool,
  Position,
  PositionSnapshot,
} from "../../generated/schema";
import { getOrCreateAccount } from "../common/account";
import {
  FACTORY_ADDRESS,
  POSITION_MANAGER_ADDRESS,
  isCuratedPool,
  ZERO_BD,
  ZERO_BI,
} from "../common/constants";
import {
  getOrCreatePool,
  getPoolTokens,
  liquidityToUSD,
} from "../common/liquidityPool";
import { priceUSDOrZero } from "../common/pricing";
import { countUniqueUser, getOrCreateProtocol } from "../common/protocol";
import { getOrCreateTick } from "../common/tick";
import { bigIntToBigDecimal } from "../common/utils";

/** Position ids are the NFT token id -- v3 has no other stable handle. */
function positionId(tokenId: BigInt): Bytes {
  return Bytes.fromUTF8(tokenId.toString());
}

class ResolvedPosition {
  pool: LiquidityPool;
  tickLower: BigInt;
  tickUpper: BigInt;

  constructor(pool: LiquidityPool, tickLower: BigInt, tickUpper: BigInt) {
    this.pool = pool;
    this.tickLower = tickLower;
    this.tickUpper = tickUpper;
  }
}

/**
 * The position manager's events carry a token id and nothing else, so the pool
 * and the range have to be read back off the contract and the pool address
 * recomputed from the factory.
 */
function resolve(
  tokenId: BigInt,
  event: ethereum.Event
): ResolvedPosition | null {
  const manager = NonfungiblePositionManager.bind(POSITION_MANAGER_ADDRESS);
  const result = manager.try_positions(tokenId);
  if (result.reverted) {
    return null;
  }
  const token0 = result.value.value2;
  const token1 = result.value.value3;
  const fee = result.value.value4;
  const tickLower = BigInt.fromI32(result.value.value5);
  const tickUpper = BigInt.fromI32(result.value.value6);

  const factory = UniswapV3Factory.bind(FACTORY_ADDRESS);
  const poolCall = factory.try_getPool(token0, token1, fee);
  if (poolCall.reverted || poolCall.value.equals(Address.zero())) {
    return null;
  }
  const poolAddress = poolCall.value;

  // Curated pools are already static data sources; spawning a template for one
  // would index every event in it twice.
  const pool = getOrCreatePool(poolAddress, event, !isCuratedPool(poolAddress));
  if (pool == null) {
    return null;
  }
  return new ResolvedPosition(pool, tickLower, tickUpper);
}

function loadOrCreatePosition(
  tokenId: BigInt,
  resolved: ResolvedPosition,
  owner: Bytes,
  event: ethereum.Event
): Position {
  const id = positionId(tokenId);
  let position = Position.load(id);
  if (position != null) {
    return position;
  }

  const pool = resolved.pool;
  position = new Position(id);
  position.account = owner;
  position.pool = pool.id;
  position.hashOpened = event.transaction.hash;
  position.blockNumberOpened = event.block.number;
  position.timestampOpened = event.block.timestamp;
  position.tickLower = getOrCreateTick(pool, resolved.tickLower, event).id;
  position.tickUpper = getOrCreateTick(pool, resolved.tickUpper, event).id;
  position.liquidityToken = null;
  position.liquidityTokenType = "ERC721";
  position.liquidity = ZERO_BI;
  position.liquidityUSD = ZERO_BD;
  position.cumulativeDepositTokenAmounts = [ZERO_BI, ZERO_BI];
  position.cumulativeDepositUSD = ZERO_BD;
  position.cumulativeWithdrawTokenAmounts = [ZERO_BI, ZERO_BI];
  position.cumulativeWithdrawUSD = ZERO_BD;
  position.depositCount = 0;
  position.withdrawCount = 0;
  position.save();

  const protocol = getOrCreateProtocol();
  protocol.cumulativePositionCount += 1;
  protocol.openPositionCount += 1;

  pool.positionCount += 1;
  pool.openPositionCount += 1;
  pool.save();

  // An LP first seen here is a unique user. Counting them only in
  // updateUsageMetrics -- which this path never reaches -- let
  // dailyActiveUsers exceed cumulativeUniqueUsers.
  const result = getOrCreateAccount(Address.fromBytes(owner));
  countUniqueUser(protocol, result.isNew, true);
  protocol.lastUpdateTimestamp = event.block.timestamp;
  protocol.lastUpdateBlockNumber = event.block.number;
  protocol.save();

  const account = result.account;
  account.positionCount += 1;
  account.openPositionCount += 1;
  account.save();

  return position;
}

function snapshotPosition(position: Position, event: ethereum.Event): void {
  const id = position.id
    .concat(Bytes.fromUTF8("-"))
    .concat(event.transaction.hash)
    .concat(Bytes.fromUTF8("-" + event.logIndex.toString()));

  const snapshot = new PositionSnapshot(id);
  snapshot.hash = event.transaction.hash;
  snapshot.logIndex = event.logIndex.toI32();
  snapshot.nonce = event.transaction.nonce;
  snapshot.position = position.id;
  snapshot.liquidityTokenType = position.liquidityTokenType;
  snapshot.liquidity = position.liquidity;
  snapshot.liquidityUSD = position.liquidityUSD;
  snapshot.cumulativeDepositTokenAmounts =
    position.cumulativeDepositTokenAmounts;
  snapshot.cumulativeDepositUSD = position.cumulativeDepositUSD;
  snapshot.cumulativeWithdrawTokenAmounts =
    position.cumulativeWithdrawTokenAmounts;
  snapshot.cumulativeWithdrawUSD = position.cumulativeWithdrawUSD;
  snapshot.cumulativeRewardTokenAmounts = null;
  snapshot.cumulativeRewardUSD = null;
  snapshot.depositCount = position.depositCount;
  snapshot.withdrawCount = position.withdrawCount;
  snapshot.blockNumber = event.block.number;
  snapshot.timestamp = event.block.timestamp;
  snapshot.save();
}

function amountsUSD(
  pool: LiquidityPool,
  amount0: BigInt,
  amount1: BigInt
): BigDecimal {
  const tokens = getPoolTokens(pool);
  if (tokens.length != 2) {
    return ZERO_BD;
  }
  return bigIntToBigDecimal(amount0, tokens[0].decimals)
    .times(priceUSDOrZero(tokens[0]))
    .plus(
      bigIntToBigDecimal(amount1, tokens[1].decimals).times(
        priceUSDOrZero(tokens[1])
      )
    );
}

export function handleIncreaseLiquidity(event: IncreaseLiquidity): void {
  const resolved = resolve(event.params.tokenId, event);
  if (resolved == null) {
    return;
  }
  const manager = NonfungiblePositionManager.bind(POSITION_MANAGER_ADDRESS);
  const ownerCall = manager.try_ownerOf(event.params.tokenId);
  const owner: Bytes = ownerCall.reverted
    ? event.transaction.from
    : Bytes.fromHexString(ownerCall.value.toHexString());

  const position = loadOrCreatePosition(
    event.params.tokenId,
    resolved as ResolvedPosition,
    owner,
    event
  );
  const pool = (resolved as ResolvedPosition).pool;

  position.liquidity = position.liquidity.plus(event.params.liquidity);
  position.liquidityUSD = liquidityToUSD(pool, position.liquidity);

  const deposits = position.cumulativeDepositTokenAmounts;
  position.cumulativeDepositTokenAmounts = [
    deposits[0].plus(event.params.amount0),
    deposits[1].plus(event.params.amount1),
  ];
  position.cumulativeDepositUSD = position.cumulativeDepositUSD.plus(
    amountsUSD(pool, event.params.amount0, event.params.amount1)
  );
  position.depositCount += 1;
  position.save();

  snapshotPosition(position, event);
}

export function handleDecreaseLiquidity(event: DecreaseLiquidity): void {
  const id = positionId(event.params.tokenId);
  let position = Position.load(id);
  if (position == null) {
    // A position opened before the start block. Resolve it so the withdrawal
    // is still recorded against a real pool and range.
    const resolved = resolve(event.params.tokenId, event);
    if (resolved == null) {
      return;
    }
    const manager = NonfungiblePositionManager.bind(POSITION_MANAGER_ADDRESS);
    const ownerCall = manager.try_ownerOf(event.params.tokenId);
    const owner: Bytes = ownerCall.reverted
      ? event.transaction.from
      : Bytes.fromHexString(ownerCall.value.toHexString());
    position = loadOrCreatePosition(
      event.params.tokenId,
      resolved as ResolvedPosition,
      owner,
      event
    );
  }

  const pool = LiquidityPool.load(position.pool);
  if (pool == null) {
    return;
  }

  position.liquidity = position.liquidity.minus(event.params.liquidity);
  if (position.liquidity.lt(ZERO_BI)) {
    position.liquidity = ZERO_BI;
  }
  position.liquidityUSD = liquidityToUSD(pool, position.liquidity);

  const withdraws = position.cumulativeWithdrawTokenAmounts;
  position.cumulativeWithdrawTokenAmounts = [
    withdraws[0].plus(event.params.amount0),
    withdraws[1].plus(event.params.amount1),
  ];
  position.cumulativeWithdrawUSD = position.cumulativeWithdrawUSD.plus(
    amountsUSD(pool, event.params.amount0, event.params.amount1)
  );
  position.withdrawCount += 1;

  const wasOpen = position.hashClosed === null;
  if (position.liquidity.equals(ZERO_BI) && wasOpen) {
    position.hashClosed = event.transaction.hash;
    position.blockNumberClosed = event.block.number;
    position.timestampClosed = event.block.timestamp;

    const protocol = getOrCreateProtocol();
    protocol.openPositionCount -= 1;
    protocol.save();

    pool.openPositionCount -= 1;
    pool.closedPositionCount += 1;
    pool.save();

    const account = getOrCreateAccount(
      Address.fromBytes(position.account)
    ).account;
    account.openPositionCount -= 1;
    account.closedPositionCount += 1;
    account.save();
  }
  position.save();

  snapshotPosition(position, event);
}

/**
 * A position NFT changing hands moves the position with it. The mint transfer
 * (from the zero address) arrives before IncreaseLiquidity, so there is nothing
 * to move yet and it is correctly a no-op.
 */
export function handlePositionTransfer(event: Transfer): void {
  const position = Position.load(positionId(event.params.tokenId));
  if (position == null) {
    return;
  }
  const previous = position.account;
  const next = Bytes.fromHexString(event.params.to.toHexString());
  if (previous.equals(next)) {
    return;
  }
  const isOpen = position.hashClosed === null;

  const from = getOrCreateAccount(Address.fromBytes(previous)).account;
  from.positionCount -= 1;
  if (isOpen) {
    from.openPositionCount -= 1;
  } else {
    from.closedPositionCount -= 1;
  }
  from.save();

  const toResult = getOrCreateAccount(event.params.to);
  const protocol = getOrCreateProtocol();
  countUniqueUser(protocol, toResult.isNew, true);
  protocol.save();

  const to = toResult.account;
  to.positionCount += 1;
  if (isOpen) {
    to.openPositionCount += 1;
  } else {
    to.closedPositionCount += 1;
  }
  to.save();

  position.account = next;
  position.save();
}
