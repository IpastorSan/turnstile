// Resolve Arc authorizations into the batch transaction that settled them.
//
//   node scripts/arc-receipts.ts <authorization-id> [...]   # specific payments
//   node scripts/arc-receipts.ts --ours                     # everything we paid
//   node scripts/arc-receipts.ts --ours --watch             # poll until mined
//
// This exists because settlement on this rail is **asynchronous**, and a script
// that only ever ran once could not show the half that happens later. Circle
// Gateway credits the seller the moment `/settle` returns an authorization id;
// the batcher redeems many authorizations in one transaction some minutes after
// that. Between the two there is a real, correct state — paid, credited, not yet
// mined — and `scripts/arc-paid-request.ts` can exit inside it.
//
// So this is the other half of that script, runnable at any later time, and it
// is also the honest answer to "where is the transaction?": it is here, when the
// batcher gets to it.
//
// **The batcher's latency is Circle's, not ours, and it varies.** Measured on Arc
// testnet 2026-09-07: one window ran ~2 minutes from `received` to `completed`
// with 12-13 authorizations per transaction; a later window stalled for over ten
// minutes across *every* Gateway user on the chain, not only us. Neither number
// is a service level and neither should be quoted as one.

import { CircleGateway } from '../rails/arc-usdc/index.ts';
import { NETWORK, arcscanTransactionUrl } from '../rails/arc-usdc/config.ts';
import { formatUsdc } from '../rails/arc-usdc/wallet.ts';
import type { GatewayTransfer } from '../rails/arc-usdc/gateway.ts';

const args = process.argv.slice(2);
const watch = args.includes('--watch');
const ours = args.includes('--ours');
const ids = args.filter(a => !a.startsWith('--'));

const agent = process.env['ARC_AGENT_ADDRESS'];
if (!ours && ids.length === 0) {
  console.error('usage: node scripts/arc-receipts.ts <authorization-id>... | --ours [--watch]');
  process.exit(1);
}
if (ours && !agent) throw new Error('--ours needs ARC_AGENT_ADDRESS');

const gateway = new CircleGateway();

async function load(): Promise<GatewayTransfer[]> {
  if (ours) return gateway.searchTransfers({ from: agent, network: NETWORK, pageSize: 200 });
  const found = await Promise.all(ids.map(id => gateway.transfer(id)));
  return found.filter((t): t is GatewayTransfer => t !== null);
}

function render(transfers: GatewayTransfer[]): number {
  const mined = transfers.filter(t => t.txHash);
  console.log(`\n${transfers.length} authorization(s), ${mined.length} mined:`);
  for (const t of transfers) {
    console.log(`  ${t.id}  ${formatUsdc(t.amount).padStart(10)} USDC  ${t.status.padEnd(9)} ${t.txHash ?? '(not mined yet)'}`);
  }

  const batches = new Map<string, GatewayTransfer[]>();
  for (const t of mined) batches.set(t.txHash!, [...(batches.get(t.txHash!) ?? []), t]);
  if (batches.size > 0) {
    console.log(`\n${mined.length} payment(s) settled in ${batches.size} on-chain transaction(s):`);
    for (const [hash, group] of batches) {
      const total = group.reduce((sum, t) => sum + BigInt(t.amount), 0n);
      console.log(`  ${hash}`);
      console.log(`    ${group.length} of these payments, ${formatUsdc(total)} USDC`);
      console.log(`    ${arcscanTransactionUrl(hash)}`);
    }
  }
  return mined.length;
}

if (!watch) {
  render(await load());
  process.exit(0);
}

// Poll. The batcher is Circle's and its cadence is not ours to promise, so this
// waits generously and says plainly when it gives up rather than implying the
// payments failed — they did not, they are credited.
const deadline = Date.now() + Number(process.env['ARC_WATCH_MINUTES'] ?? 45) * 60_000;
let transfers = await load();
while (Date.now() < deadline) {
  const mined = transfers.filter(t => t.txHash).length;
  console.log(`${new Date().toISOString().slice(11, 19)}  ${mined}/${transfers.length} mined  [${transfers.map(t => t.status).join(' ')}]`);
  if (transfers.length > 0 && mined === transfers.length) break;
  await new Promise(r => setTimeout(r, 20_000));
  transfers = await load();
}
const mined = render(transfers);
if (mined < transfers.length) {
  console.log('\nStill unmined. These payments are credited and settled from the seller\'s point of');
  console.log('view; the batch transaction is Circle\'s to submit. Re-run this script later.');
}
process.exit(0);
