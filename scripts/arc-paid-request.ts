// The real paid request on Arc, end to end. This is the script that produces the
// ArcScan link, the zero-gas proof and the batch.
//
//   node scripts/arc-paid-request.ts                    # fixture analyst (fast)
//   node scripts/arc-paid-request.ts --live             # live analyst
//   node scripts/arc-paid-request.ts --nanopayments 8   # more sub-cent queries
//   node scripts/arc-paid-request.ts --skip-hedera      # Arc only
//
// It runs the **real** seller app (`createApp`), the **real** rail registry, the
// **real** `@x402/fetch` client through `buyer/watchdog/pay.ts`, and the **real**
// Circle Gateway against Arc testnet. Nothing here is a mock. The seller is
// started in-process rather than over a socket only so that one command produces
// one transcript; the code paths are the ones `npm run serve` uses.
//
// Five things it is trying to show, in the order a sceptic would ask for them:
//
//   1. one query, a 402 advertising **both** rails;
//   2. that query paid on Arc, and **the same query paid on Hedera** — the
//      seller does not know or care which answered;
//   3. the **zero-gas** property, as a nonce that does not move;
//   4. **nanopayments**: several sub-cent queries, each below what any chain
//      charges for a transaction;
//   5. those payments **sharing one on-chain transaction**, which is the only
//      reason (4) is possible.
//
// Run `node scripts/arc-setup.ts` first — the agent needs a Gateway balance, and
// it cannot create one itself by design.

import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from '@x402/core/http';
import type { Address } from 'viem';

import { createPaidFetch } from '../buyer/watchdog/pay.ts';
import type { SpendingLimits } from '../buyer/watchdog/pay.ts';
import { createArcSigner } from '../buyer/watchdog/arc-signer.ts';
import { createHederaSigner } from '../buyer/watchdog/hedera-signer.ts';
import { CircleGateway, createArcRail } from '../rails/arc-usdc/index.ts';
import { arcscanAddressUrl, arcscanTransactionUrl } from '../rails/arc-usdc/config.ts';
import { formatUsdc, gatewayBalance, readArcWallet, sameBalance } from '../rails/arc-usdc/wallet.ts';
import { createHederaRail } from '../rails/hedera-x402/index.ts';
import { hashscanTransactionUrl } from '../rails/hedera-x402/config.ts';
import { RailRegistry } from '../rails/registry.ts';
import { createApp } from '../seller/service/app.ts';
import { liveAnalyst } from '../seller/service/analyst-port.ts';
import { TIERS } from '../seller/service/tiers.ts';
import { fakeAnalyst, withServer } from '../seller/service/testing.ts';

const args = process.argv.slice(2);
const useLive = args.includes('--live');
const skipHedera = args.includes('--skip-hedera');
const nanoCount = Number(args.includes('--nanopayments') ? args[args.indexOf('--nanopayments') + 1] : 6);
const pool = args[args.indexOf('--pool') + 1]?.startsWith('0x')
  ? args[args.indexOf('--pool') + 1]!
  : '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640';

const rule = (title: string) => console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`);

const agentAddress = process.env['ARC_AGENT_ADDRESS'] as Address | undefined;
if (!agentAddress) throw new Error('set ARC_AGENT_ADDRESS (see .env.example)');
const gateway = new CircleGateway();

// **Correction (2026-09-07, MOV-228):** this script used to require
// `ARC_ORG_PRIVATE_KEY`, purely to construct a `GatewayClient` that could read
// the agent's Gateway balance — the SDK's constructor demands a private key even
// for a read. After MOV-228 the org *has* no private key here (the warm tier is
// a Privy server wallet whose secret lives in an enclave), so that requirement
// would have made the demo take depend on a key the design had just removed.
//
// `gatewayBalance()` reads Circle's `/v1/balances` directly. It needs no key and
// no auth header — verified 2026-09-07 — and it keeps the property the old
// comment here was protecting: the agent still never gets a client that could
// send anything, because no such object is constructed anywhere in this file.
async function agentState() {
  const [chain, balance] = await Promise.all([
    readArcWallet(agentAddress!),
    gatewayBalance(agentAddress!).catch(() => null),
  ]);
  return { chain, gatewayAvailable: balance?.available ?? '(none)' };
}

const arcSigner = await createArcSigner();
const hederaSigner = skipHedera ? null : await createHederaSigner().catch((cause: unknown) => {
  console.warn(`hedera signer unavailable, continuing on Arc alone: ${cause instanceof Error ? cause.message : String(cause)}`);
  return null;
});
const signers = [arcSigner, ...(hederaSigner ? [hederaSigner] : [])];

// Both rails, as the seller really advertises them. Both are live as of MOV-225.
const registry = new RailRegistry([createHederaRail(), createArcRail()]);
const analyst = useLive ? liveAnalyst() : fakeAnalyst();
const app = createApp({ registry, analyst });

rule('SETUP');
const before = await agentState();
console.log(`seller payout    ${process.env['ARC_PAYOUT_ADDRESS']}`);
console.log(`buyer agent      ${arcSigner.address}   (the hot tier)`);
console.log(`facilitator      ${gateway.baseUrl}`);
console.log(`analyst          ${useLive ? 'live' : 'FIXTURE (pass --live for the real subgraph)'}`);
console.log(`rails            ${registry.describe().map(r => `${r.id}=${r.live ? 'live' : 'stub'}`).join('  ')}`);
console.log(`\nagent, before any payment:`);
console.log(`  nonce          ${before.chain.nonce}`);
console.log(`  on chain       ${formatUsdc(before.chain.usdc)} USDC  (native ${before.chain.native} wei)`);
console.log(`  gateway        ${before.gatewayAvailable} USDC available  <-- the mandate allowance`);
console.log(`  ${arcscanAddressUrl(arcSigner.address)}`);
if (before.gatewayAvailable === '0' || before.gatewayAvailable === '(none)') {
  console.error('\nThe agent has no Gateway balance. Run: node scripts/arc-setup.ts');
  process.exit(1);
}

let exitCode = 0;
const settledOnArc: { label: string; authorizationId: string }[] = [];

try {
  await withServer(app, async baseUrl => {
    const resource = `${baseUrl}/analyze/${pool}`;

    rule('1. ONE QUERY, A 402 THAT ADVERTISES BOTH RAILS');
    const unpaid = await fetch(resource);
    console.log(`GET ${resource} -> HTTP ${unpaid.status}`);
    const challenge = decodePaymentRequiredHeader(unpaid.headers.get('payment-required')!);
    for (const accept of challenge.accepts) {
      const extra = accept.extra as Record<string, unknown>;
      console.log(`  ${String(accept.scheme).padEnd(6)} ${String(accept.network).padEnd(18)} ${accept.amount.padEnd(10)} ${String(extra['symbol'])}  -> ${accept.payTo}`);
    }
    console.log('\nthe Arc entry in full (note verifyingContract is the GatewayWallet, not USDC):');
    console.log(JSON.stringify(challenge.accepts.find(a => a.network === arcSigner.network), null, 2));

    rule('2. THE SAME QUERY, PAID ON ARC');
    const arcMandate: SpendingLimits = { preferredRails: ['arc-usdc'], maxPerPaymentUsd: 0.5 };
    const started = Date.now();
    const paid = await createPaidFetch({ mandate: arcMandate, signers })(resource);
    console.log(`HTTP ${paid.status} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    if (!paid.ok) { console.log(await paid.text()); throw new Error(`the paid request did not return 200 (got ${paid.status})`); }

    const arcSettlement = decodePaymentResponseHeader(paid.headers.get('payment-response')!) as unknown as { transaction: string; network: string; payer?: string; success: boolean };
    console.log(`PAYMENT-RESPONSE: ${JSON.stringify(arcSettlement, null, 2)}`);
    const arcBody = await paid.json() as { tier: string; verdict: { rating: string; pool: string } };
    console.log(`\nbought: tier=${arcBody.tier} rating=${arcBody.verdict.rating}`);
    console.log(`\nnote the shape of 'transaction': it is a Gateway authorization id (a UUID),`);
    console.log(`NOT a transaction hash. The hash does not exist yet. See section 6.`);
    settledOnArc.push({ label: `$${TIERS.standard.priceUsd} standard tier`, authorizationId: arcSettlement.transaction });

    if (hederaSigner) {
      rule('3. THE SAME QUERY, PAID ON HEDERA — the seller cannot tell the difference');
      // Same URL, same seller, same code path. Only the mandate changed, which is
      // the buyer's decision and not the seller's. `seller/service/` contains no
      // branch on either chain: `no-chain-code.test.ts` fails the build if it does.
      const hederaMandate: SpendingLimits = { preferredRails: ['hedera-x402'], maxPerPaymentUsd: 0.5 };
      const hederaPaid = await createPaidFetch({ mandate: hederaMandate, signers })(resource);
      console.log(`HTTP ${hederaPaid.status}`);
      if (hederaPaid.ok) {
        const s = decodePaymentResponseHeader(hederaPaid.headers.get('payment-response')!) as unknown as { transaction: string; network: string };
        const hederaBody = await hederaPaid.json() as { tier: string; verdict: { rating: string } };
        console.log(`  transaction  ${s.transaction}`);
        console.log(`  network      ${s.network}`);
        console.log(`  HashScan     ${hashscanTransactionUrl(s.transaction)}`);
        console.log(`  bought       tier=${hederaBody.tier} rating=${hederaBody.verdict.rating}`);
        console.log(`\nsame query, same answer, two chains, one seller with no chain code in it.`);
        console.log(`Arc settled to  ${arcSettlement.transaction}  (an authorization id)`);
        console.log(`Hedera settled to ${s.transaction}  (a consensus transaction id)`);
        console.log(`Both travelled back through PaymentRail.settle() and the service read neither.`);
      } else {
        console.log(`  the Hedera leg did not settle: ${(await hederaPaid.text()).slice(0, 300)}`);
      }
    }

    rule('4. ZERO GAS — the agent has spent money and never sent a transaction');
    const mid = await agentState();
    console.log(`agent ${arcSigner.address}`);
    console.log(`  nonce          ${before.chain.nonce} -> ${mid.chain.nonce}`);
    console.log(`  on chain       ${formatUsdc(before.chain.usdc)} -> ${formatUsdc(mid.chain.usdc)} USDC`);
    console.log(`  native         ${before.chain.native} -> ${mid.chain.native} wei`);
    console.log(`  gateway        ${before.gatewayAvailable} -> ${mid.gatewayAvailable} USDC`);
    console.log(`\n  USDC is Arc's native gas token, so those two balance lines are ONE balance`);
    console.log(`  at two precisions (18 dp and 6 dp). eth_getBalance/1e12 == balanceOf: ${sameBalance(mid.chain)}`);
    console.log(`\n  The nonce is the proof. It is ${mid.chain.nonce}, so this wallet has never submitted a`);
    console.log(`  transaction, so it has never paid a wei of gas — while its Gateway balance fell.`);
    console.log(`  Circle's batcher pays, and section 6 shows the transaction it paid for.`);
    if (mid.chain.nonce !== 0) console.warn('  WARNING: the nonce moved. The zero-gas claim is void for this run.');

    rule(`5. NANOPAYMENTS — ${nanoCount} sub-cent queries`);
    // A separate app instance at a nanopayment price. Same rails, same registry,
    // same 402 machinery — only the tier price differs, because the service's own
    // cheapest tier is $0.07 (pinned to the `turnstile:price` record on
    // liquidity.turnstile.eth) and a sub-cent tier would make that record a lie.
    const nanoPrice = 0.0005;
    const nanoApp = createApp({
      registry,
      analyst,
      tiers: {
        standard: { ...TIERS.standard, priceUsd: nanoPrice, description: `Nanopayment demo tier at $${nanoPrice}` },
        premium: TIERS.premium,
      },
    });

    await withServer(nanoApp, async nanoUrl => {
      const nanoResource = `${nanoUrl}/analyze/${pool}`;
      const nanoMandate: SpendingLimits = { preferredRails: ['arc-usdc'], maxPerPaymentUsd: 0.01 };
      const pay = createPaidFetch({ mandate: nanoMandate, signers });

      console.log(`$${nanoPrice.toFixed(6)} each = ${nanoPrice * 1e6} USDC atomic units per query.`);
      console.log(`No chain settles a payment that size on its own: on Arc the deposit that funded`);
      console.log(`this mandate cost ~0.0019 USDC in gas, four times one query's price.\n`);

      for (let i = 1; i <= nanoCount; i += 1) {
        const res = await pay(nanoResource);
        if (!res.ok) { console.log(`  ${i}. HTTP ${res.status} ${(await res.text()).slice(0, 200)}`); continue; }
        const s = decodePaymentResponseHeader(res.headers.get('payment-response')!) as unknown as { transaction: string };
        await res.json();
        console.log(`  ${String(i).padStart(2)}. paid $${nanoPrice.toFixed(6)} -> authorization ${s.transaction}`);
        settledOnArc.push({ label: `$${nanoPrice.toFixed(6)} nanopayment #${i}`, authorizationId: s.transaction });
      }
    });

    const after = await agentState();
    console.log(`\nagent gateway balance: ${before.gatewayAvailable} -> ${after.gatewayAvailable} USDC`);
    console.log(`agent nonce:           ${after.chain.nonce}   (still zero, after ${settledOnArc.length} payments)`);

    rule('6. THE BATCH — many authorizations, one transaction');
    // The point of the whole rail, and the reason section 5 is possible at all.
    // `settle()` returned authorization ids; Circle's batcher redeems them
    // together minutes later. Observed on Arc testnet 2026-09-07: ~2 minutes,
    // 12-13 authorizations per transaction.
    // Six minutes by default, and **that is often not enough** — measured twice on
    // 2026-09-07, Circle's batcher was running roughly every 13-15 minutes and
    // both runs exited before it fired. That is not a failure and the script says
    // so; `npm run arc:receipts -- --ours --watch` is the second step. The window
    // is short by default because a demo should not block for a quarter of an
    // hour, not because the batch usually lands inside it.
    const watchMinutes = Number(process.env['ARC_WATCH_MINUTES'] ?? 6);
    console.log(`polling ${settledOnArc.length} authorizations for up to ${watchMinutes} minutes...`);
    console.log(`(Circle's batcher fires on its own schedule -- 2 to 15 minutes observed. If this`);
    console.log(` window closes first, the payments are still settled: run 'npm run arc:receipts -- --ours'.)`);
    const deadline = Date.now() + watchMinutes * 60_000;
    const resolved = new Map<string, string>();

    while (Date.now() < deadline && resolved.size < settledOnArc.length) {
      await new Promise(r => setTimeout(r, 15_000));
      for (const { authorizationId } of settledOnArc) {
        if (resolved.has(authorizationId)) continue;
        const transfer = await gateway.transfer(authorizationId).catch(() => null);
        if (transfer?.txHash) resolved.set(authorizationId, transfer.txHash);
      }
      const statuses = await Promise.all(settledOnArc.map(s => gateway.transfer(s.authorizationId).catch(() => null)));
      console.log(`  ${new Date().toISOString().slice(11, 19)}  ${statuses.map(t => t?.status ?? '?').join(' ')}  (${resolved.size}/${settledOnArc.length} mined)`);
    }

    console.log('');
    for (const { label, authorizationId } of settledOnArc) {
      const hash = resolved.get(authorizationId);
      console.log(`  ${label.padEnd(30)} ${authorizationId}  ->  ${hash ?? 'not mined yet'}`);
    }

    const batches = new Map<string, number>();
    for (const hash of resolved.values()) batches.set(hash, (batches.get(hash) ?? 0) + 1);
    console.log(`\n${resolved.size} authorizations settled in ${batches.size} on-chain transaction(s):`);
    for (const [hash, count] of batches) {
      console.log(`  ${hash}`);
      console.log(`    ${count} of our payments in this batch`);
      console.log(`    ${arcscanTransactionUrl(hash)}`);
      // How many payments were in it in total, ours and everyone else's.
      const all = await gateway.searchTransfers({ network: arcSigner.network, pageSize: 200 }).catch(() => []);
      const inBatch = all.filter(t => t.txHash === hash);
      if (inBatch.length) {
        const total = inBatch.reduce((sum, t) => sum + BigInt(t.amount), 0n);
        console.log(`    ${inBatch.length} payments in total (ours and other Gateway users'), ${formatUsdc(total)} USDC moved`);
      }
    }
    if (batches.size === 0) {
      console.log('  Not mined inside the polling window -- which is ordinary, not a failure.');
      console.log('  Every payment above is settled: Gateway returned success, credited the seller');
      console.log('  and debited the payer. Only the batch transaction is outstanding, and it is');
      console.log("  Circle's to submit. Resolve it whenever it lands:");
      console.log('');
      console.log('    npm run arc:receipts -- --ours --watch');
    }

    rule('7. RECEIPT LOOKUP — the seller\'s own audit trail, across both rails');
    // `/receipts/:transaction` asks every rail. It is the same route that answers
    // for a Hedera consensus timestamp, and it does not know which rail will.
    const first = settledOnArc[0]!;
    const lookup = await fetch(`${baseUrl}/receipts/${encodeURIComponent(first.authorizationId)}`);
    console.log(`GET /receipts/${first.authorizationId} -> ${lookup.status}`);
    console.log(JSON.stringify(await lookup.json(), null, 2));
  });
} catch (cause) {
  exitCode = 1;
  console.error('\nFAILED:', cause instanceof Error ? cause.stack : cause);
} finally {
  arcSigner.close();
  hederaSigner?.close();
}

process.exit(exitCode);
