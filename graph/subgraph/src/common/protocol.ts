import { BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import { DexAmmProtocol } from "../../generated/schema";
import {
  FACTORY_ADDRESS,
  PROTOCOL_METHODOLOGY_VERSION,
  PROTOCOL_NAME,
  PROTOCOL_NETWORK,
  PROTOCOL_SCHEMA_VERSION,
  PROTOCOL_SLUG,
  PROTOCOL_SUBGRAPH_VERSION,
  PROTOCOL_TYPE,
  ZERO_BD,
  ZERO_BI,
} from "./constants";

/**
 * The single DexAmmProtocol row. Its id is the factory address, which is what
 * the Messari standard prescribes -- a consumer that wants "the protocol" of
 * any conformant DEX subgraph queries `dexAmmProtocols(first: 1)` and gets
 * this shape back regardless of which DEX it hit.
 */
export function getOrCreateProtocol(): DexAmmProtocol {
  const id = Bytes.fromHexString(FACTORY_ADDRESS.toHexString());
  let protocol = DexAmmProtocol.load(id);
  if (protocol != null) {
    return protocol;
  }

  protocol = new DexAmmProtocol(id);
  protocol.name = PROTOCOL_NAME;
  protocol.slug = PROTOCOL_SLUG;
  protocol.schemaVersion = PROTOCOL_SCHEMA_VERSION;
  protocol.subgraphVersion = PROTOCOL_SUBGRAPH_VERSION;
  protocol.methodologyVersion = PROTOCOL_METHODOLOGY_VERSION;
  protocol.network = PROTOCOL_NETWORK;
  protocol.type = PROTOCOL_TYPE;

  protocol.totalValueLockedUSD = ZERO_BD;
  protocol.totalLiquidityUSD = ZERO_BD;
  protocol.activeLiquidityUSD = ZERO_BD;
  protocol.uncollectedProtocolSideValueUSD = ZERO_BD;
  protocol.uncollectedSupplySideValueUSD = ZERO_BD;
  protocol.cumulativeVolumeUSD = ZERO_BD;
  protocol.cumulativeSupplySideRevenueUSD = ZERO_BD;
  protocol.cumulativeProtocolSideRevenueUSD = ZERO_BD;
  protocol.cumulativeTotalRevenueUSD = ZERO_BD;

  protocol.cumulativeUniqueUsers = 0;
  protocol.cumulativeUniqueLPs = 0;
  protocol.cumulativeUniqueTraders = 0;
  protocol.totalPoolCount = 0;
  protocol.openPositionCount = 0;
  protocol.cumulativePositionCount = 0;

  protocol.lastSnapshotDayID = 0;
  protocol.lastUpdateTimestamp = ZERO_BI;
  protocol.lastUpdateBlockNumber = ZERO_BI;
  protocol._regenesis = false;
  protocol.save();

  return protocol;
}

export function touchProtocol(
  protocol: DexAmmProtocol,
  event: ethereum.Event
): void {
  protocol.lastUpdateTimestamp = event.block.timestamp;
  protocol.lastUpdateBlockNumber = event.block.number;
}
