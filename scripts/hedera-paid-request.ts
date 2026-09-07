// The real paid request, end to end. This is the script that produces the
// HashScan link.
//
//   node scripts/hedera-paid-request.ts                    # live analyst
//   node scripts/hedera-paid-request.ts --fixture          # fixture analyst
//   node scripts/hedera-paid-request.ts --pool 0x88e6...   # a different pool
//
// It runs the **real** seller app (`createApp`), the **real** rail registry, the
// **real** `@x402/fetch` client through `buyer/watchdog/pay.ts`, and the **real**
// Blocky402 facilitator against Hedera testnet. Nothing here is a mock. The
// seller is started in-process rather than over a socket to another machine only
// so that one command produces one transcript; the code paths are the ones
// `npm run serve` uses.
//
// What it prints is meant to be pasted into `docs/payment-flow.md` and read out
// in the demo video, so it is verbose on purpose: the 402 as it goes on the wire,
// the mandate's choice between the two advertised rails, the decoded
// `PAYMENT-RESPONSE`, the HashScan link, and the HCS receipt read back off the
// public mirror node by a path that uses none of our keys.
//
// The `--fixture` flag swaps the analyst for the test fixture. It changes what is
// *sold*, never how it is paid for — useful when the subgraph is slow and the
// point of the run is the transaction.

import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from '@x402/core/http';

import { createPaidFetch } from '../buyer/watchdog/pay.ts';
import type { Mandate } from '../buyer/watchdog/pay.ts';
import { createHederaSigner } from '../buyer/watchdog/hedera-signer.ts';
import { hashscanTopicUrl, hashscanTransactionUrl } from '../rails/hedera-x402/config.ts';
import { HcsReceiptTopic, createHederaRail } from '../rails/hedera-x402/index.ts';
import { createArcRail } from '../rails/arc-usdc/index.ts';
import { RailRegistry } from '../rails/registry.ts';
import { createApp } from '../seller/service/app.ts';
import { liveAnalyst } from '../seller/service/analyst-port.ts';
import { fakeAnalyst, withServer } from '../seller/service/testing.ts';

const args = process.argv.slice(2);
const useFixture = args.includes('--fixture');
const pool = args[args.indexOf('--pool') + 1]?.startsWith('0x')
  ? args[args.indexOf('--pool') + 1]!
  : '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640';

const rule = (title: string) => console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`);

// Both rails, as the seller really advertises them.
//
// **Correction (2026-09-07, MOV-225):** this comment used to say "Hedera is live,
// Arc is still MOV-225's placeholder", and that the buyer held a signer for one
// of them so the mandate had "a genuine choice to make rather than a foregone
// one". Arc is live now, so the choice here is genuinely foregone in the other
// direction: this script deliberately carries only the Hedera signer, so the
// mandate rules Arc out for want of a signer rather than for want of a rail.
// `scripts/arc-paid-request.ts` is the one that pays the same query over both.
const registry = new RailRegistry([createHederaRail(), createArcRail()]);
const app = createApp({ registry, analyst: useFixture ? fakeAnalyst() : liveAnalyst() });

const signer = await createHederaSigner();
const mandate: Mandate = {
  preferredRails: ['hedera-x402'],
  maxPerPaymentUsd: Number(process.env['BUYER_MAX_PER_PAYMENT_USD'] ?? 0.5),
};

rule('SETUP');
console.log(`seller payout   ${process.env['HEDERA_PAYOUT_ACCOUNT'] ?? process.env['HEDERA_OPERATOR_ID']}`);
console.log(`buyer agent     ${signer.accountId}`);
console.log(`facilitator     ${process.env['BLOCKY402_URL'] ?? 'https://api.testnet.blocky402.com'}`);
console.log(`receipt topic   ${process.env['HEDERA_RECEIPT_TOPIC_ID'] ?? '(unset — receipts will be skipped)'}`);
console.log(`buyer rate      ${signer.usdPerUnit} USD/HBAR (read by the buyer, not taken from the seller)`);
console.log(`mandate         max $${mandate.maxPerPaymentUsd} per payment, rails ${mandate.preferredRails.join(', ')}`);
console.log(`analyst         ${useFixture ? 'FIXTURE (--fixture)' : 'live'}`);

let exitCode = 0;
try {
  await withServer(app, async baseUrl => {
    const resource = `${baseUrl}/analyze/${pool}`;

    rule('1. UNPAID REQUEST -> 402');
    const unpaid = await fetch(resource);
    console.log(`HTTP ${unpaid.status}`);
    const challenge = decodePaymentRequiredHeader(unpaid.headers.get('payment-required')!);
    console.log(JSON.stringify(challenge, null, 2));

    rule('2. PAID REQUEST');
    const pay = createPaidFetch({ mandate, signers: [signer] });
    const started = Date.now();
    const paid = await pay(resource);
    console.log(`HTTP ${paid.status} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    if (!paid.ok) {
      console.log(await paid.text());
      throw new Error(`the paid request did not return 200 (got ${paid.status})`);
    }

    const header = paid.headers.get('payment-response')!;
    const settlement = decodePaymentResponseHeader(header) as unknown as { transaction: string; network: string; payer?: string; amount?: string; success: boolean };
    console.log(`\nPAYMENT-RESPONSE (raw base64): ${header}`);
    console.log(`PAYMENT-RESPONSE (decoded):    ${JSON.stringify(settlement, null, 2)}`);

    const body = await paid.json() as { tier: string; verdict: { rating: string; confidence: number; pool: string } };
    console.log(`\nbought: tier=${body.tier} rating=${body.verdict.rating} confidence=${body.verdict.confidence}`);

    rule('3. ON CHAIN');
    console.log(`transaction id  ${settlement.transaction}`);
    console.log(`HashScan        ${hashscanTransactionUrl(settlement.transaction)}`);
    console.log(`payer           ${settlement.payer}`);
    console.log(`amount          ${settlement.amount} tinybars`);

    rule('4. RECEIPT LOOKUP (the seller\'s own audit trail)');
    const lookup = await fetch(`${baseUrl}/receipts/${encodeURIComponent(settlement.transaction)}`);
    console.log(`GET /receipts/${settlement.transaction} -> ${lookup.status}`);
    console.log(JSON.stringify(await lookup.json(), null, 2));

    rule('5. HCS RECEIPT, READ BACK OFF THE PUBLIC MIRROR NODE');
    const topic = new HcsReceiptTopic();
    if (!topic.topicId) {
      console.log('HEDERA_RECEIPT_TOPIC_ID is unset; nothing was written.');
    } else {
      console.log(`topic ${topic.topicId}  ${hashscanTopicUrl(topic.topicId)}`);
      // Consensus is immediate but the mirror node ingests a beat later.
      await new Promise(r => setTimeout(r, 6000));
      const messages = await topic.read();
      console.log(`${messages.length} receipt(s) on the topic; last:`);
      console.log(JSON.stringify(messages.at(-1) ?? null, null, 2));
    }

    rule('6. REPLAY: one payment buys exactly one answer');
    // A second real payment, built by hand so the same `PAYMENT-SIGNATURE`
    // header can be sent twice. The first send must settle; the second must be
    // refused before any work is done. `@x402/fetch` cannot demonstrate this —
    // it mints a fresh transaction per call, which is the correct client
    // behaviour and the reason the guard has to live on the seller.
    const offer = challenge.accepts.find(a => a.network === signer.network && a.scheme === signer.scheme)!;
    const header2 = encodePaymentSignatureHeader({
      x402Version: 2,
      accepted: offer,
      payload: await signer.sign(offer as never),
    } as never);

    const first = await fetch(resource, { headers: { 'PAYMENT-SIGNATURE': header2 } });
    const firstSettlement = first.ok ? decodePaymentResponseHeader(first.headers.get('payment-response')!) as unknown as { transaction: string } : null;
    console.log(`first send  -> HTTP ${first.status}${firstSettlement ? `  ${firstSettlement.transaction}` : ''}`);
    if (firstSettlement) console.log(`               ${hashscanTransactionUrl(firstSettlement.transaction)}`);

    const second = await fetch(resource, { headers: { 'PAYMENT-SIGNATURE': header2 } });
    console.log(`second send -> HTTP ${second.status} (402 expected)`);
    const refusal = await second.json() as { error?: string };
    console.log(`               ${refusal.error ?? '(no error field)'}`);
  });
} catch (cause) {
  exitCode = 1;
  console.error('\nFAILED:', cause instanceof Error ? cause.stack : cause);
} finally {
  signer.close();
}

process.exit(exitCode);
