// Entrypoint: `npm run serve`.
//
// This is the only file in `seller/service/` that names a rail, and it names
// both of them together, as a list. That is the point — the app below it is
// written against `RailRegistry`, so adding a third rail is a line here and
// nothing else. `no-chain-code.test.ts` allows this file the imports it forbids
// everywhere else in the directory, and fails if the list grows a branch.

import { createArcRail } from '../../rails/arc-usdc/index.ts';
import { createBaseRail } from '../../rails/base-usdc/index.ts';
import { createHederaRail } from '../../rails/hedera-x402/index.ts';
import { RailRegistry } from '../../rails/registry.ts';
import { liveAnalyst } from './analyst-port.ts';
import { createApp } from './app.ts';

const port = Number(process.env['PORT'] ?? 4021);

const registry = new RailRegistry([createHederaRail(), createArcRail(), createBaseRail()]);
const app = createApp({ registry, analyst: liveAnalyst() });

app.listen(port, () => {
  const live = registry.rails.filter(rail => rail.info.live);
  console.log(`turnstile seller service on :${port}`);
  for (const rail of registry.describe()) {
    console.log(`  rail ${rail.id.padEnd(12)} ${rail.scheme}/${rail.network}  ${rail.live ? 'LIVE' : 'PLACEHOLDER — settles nothing'}`);
  }
  if (live.length === 0) {
    // Loud on purpose. A service that takes payment headers and settles nothing
    // looks identical to a working one from the outside, and that is exactly the
    // failure a demo must not walk into.
    console.warn('  WARNING: every rail is a placeholder. The 402 flow is real; no value will move.');
    console.warn('  MOV-220 lands Hedera/Blocky402; MOV-225 lands Arc.');
  }
});
