import { PoolCreated } from "../../generated/Factory/UniswapV3Factory";
import { getOrCreatePool } from "../common/liquidityPool";
import { getOrCreateProtocol } from "../common/protocol";

/**
 * Pools created from the start block onward. The eight deepest pools predate it
 * and are declared statically in the manifest, so this handler only ever sees
 * genuinely new ones -- and spawns a Pool template so their swaps, mints and
 * burns are indexed by exactly the same code.
 */
export function handlePoolCreated(event: PoolCreated): void {
  getOrCreateProtocol();
  getOrCreatePool(event.params.pool, event, true);
}
