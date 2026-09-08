// A receipt on an unkeyed topic is a claim. These tests are about the machinery
// that turns it into evidence, and about not overstating what it has turned.

import test from 'node:test';
import assert from 'node:assert/strict';

import { readReceipts, toMirrorTransactionId, verifyReceipt } from './receipts.ts';
import type { HcsReceiptMessage } from '../rails/hedera-x402/hcs.ts';

const MIRROR = 'https://mirror.example';

const message = (over: Partial<HcsReceiptMessage> = {}): HcsReceiptMessage => ({
  v: 1,
  kind: 'turnstile.settlement',
  railId: 'hedera-x402',
  network: 'hedera:testnet',
  transaction: '0.0.7162784@1788791871.396045089',
  payer: '0.0.10408012',
  payTo: '0.0.10403961',
  amount: '84367844',
  asset: '0.0.0',
  priceUsd: 0.07,
  resource: 'http://seller.example/analyze/0xpool',
  settledAt: 1_788_791_876_671,
  ...over,
});

const b64 = (m: unknown): string => Buffer.from(JSON.stringify(m), 'utf8').toString('base64');

/** A mirror node that answers the two routes this module uses. */
function mirror(options: {
  submitKey?: { key: string } | null;
  messages?: { message: string; sequence_number: number; consensus_timestamp: string }[];
  transaction?: unknown;
  transactionStatus?: number;
} = {}): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/v1/topics/') && url.includes('/messages')) {
      return new Response(JSON.stringify({ messages: options.messages ?? [] }), { status: 200 });
    }
    if (url.includes('/api/v1/topics/')) {
      return new Response(JSON.stringify({ submit_key: options.submitKey ?? null }), { status: 200 });
    }
    if (url.includes('/api/v1/transactions/')) {
      if (options.transactionStatus && options.transactionStatus !== 200) {
        return new Response('{}', { status: options.transactionStatus });
      }
      return new Response(JSON.stringify({ transactions: options.transaction ? [options.transaction] : [] }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as typeof globalThis.fetch;
}

const ledgerTransfer = (over: Record<string, unknown> = {}) => ({
  result: 'SUCCESS',
  charged_tx_fee: 241050,
  transfers: [
    { account: '0.0.802', amount: 241050 },
    { account: '0.0.7162784', amount: -241050 },
    { account: '0.0.10403961', amount: 84367844 },
    { account: '0.0.10408012', amount: -84367844 },
  ],
  ...over,
});

test('a Hedera transaction id is rewritten into the form the REST paths use', () => {
  // Getting this wrong produces a 404 that reads exactly like "that payment
  // never happened", which is the worst possible way to be wrong here.
  assert.equal(
    toMirrorTransactionId('0.0.7162784@1788791871.396045089'),
    '0.0.7162784-1788791871-396045089',
  );
});

test('a receipt the ledger confirms names the fee payer, which is not the buyer', async () => {
  const v = await verifyReceipt(message(), mirror({ transaction: ledgerTransfer() }), MIRROR);
  assert.equal(v.status, 'confirmed');
  assert.equal(v.ledgerAmount, '84367844');
  // The facilitator paid the gas. That is what lets the buyer's hot wallet hold
  // no native token at all.
  assert.equal(v.feePayer, '0.0.7162784');
});

test('a receipt claiming more than the ledger moved is a mismatch, not a pass', async () => {
  const v = await verifyReceipt(message({ amount: '999999999' }), mirror({ transaction: ledgerTransfer() }), MIRROR);
  assert.equal(v.status, 'mismatch');
  assert.match(v.detail, /claims 999999999/);
});

test('a receipt naming a payee the ledger never credited is a mismatch', async () => {
  const v = await verifyReceipt(message({ payTo: '0.0.4242' }), mirror({ transaction: ledgerTransfer() }), MIRROR);
  assert.equal(v.status, 'mismatch');
  assert.match(v.detail, /credited nothing to 0.0.4242/);
});

test('a transaction that exists and failed is not a confirmation', async () => {
  const v = await verifyReceipt(message(), mirror({ transaction: ledgerTransfer({ result: 'INSUFFICIENT_ACCOUNT_BALANCE' }) }), MIRROR);
  assert.equal(v.status, 'mismatch');
  assert.equal(v.ledgerResult, 'INSUFFICIENT_ACCOUNT_BALANCE');
});

test('a forged receipt naming a transaction that does not exist is caught', async () => {
  const v = await verifyReceipt(message(), mirror({ transaction: null }), MIRROR);
  assert.equal(v.status, 'not_found');
});

test("another rail's settlement id is unverifiable here, and says so rather than failing", async () => {
  const v = await verifyReceipt(message({ railId: 'arc-usdc', transaction: '0xdeadbeef' }), mirror(), MIRROR);
  assert.equal(v.status, 'unverifiable');
  assert.match(v.detail, /only reads the Hedera mirror node/);
});

test('an unkeyed topic is reported as one, in words a caller cannot skim past', async () => {
  const result = await readReceipts({
    topic: '0.0.1', mirrorNodeUrl: MIRROR,
    fetch: mirror({ submitKey: null, messages: [{ message: b64(message()), sequence_number: 1, consensus_timestamp: '1.2' }] }),
  });
  assert.equal(result.submitKey, null);
  assert.match(result.notes.join(' '), /anyone can append to it. A receipt read from it is a CLAIM/);
  // And the gap that no tool can close from inside.
  assert.match(result.notes.join(' '), /No on-chain record binds a seller to a receipt topic/);
});

test('a topic with a submit key is described differently', async () => {
  const result = await readReceipts({
    topic: '0.0.1', mirrorNodeUrl: MIRROR, fetch: mirror({ submitKey: { key: '02abc' } }),
  });
  assert.equal(result.submitKey, '02abc');
  assert.match(result.notes.join(' '), /only its holder can append/);
});

test("someone else's messages on the topic are skipped and counted", async () => {
  const result = await readReceipts({
    topic: '0.0.1', mirrorNodeUrl: MIRROR,
    fetch: mirror({
      messages: [
        { message: b64(message()), sequence_number: 1, consensus_timestamp: '1.0' },
        { message: b64({ kind: 'someone.else' }), sequence_number: 2, consensus_timestamp: '2.0' },
        { message: Buffer.from('not json', 'utf8').toString('base64'), sequence_number: 3, consensus_timestamp: '3.0' },
      ],
    }),
  });
  assert.equal(result.totals.receipts, 1);
  assert.match(result.notes.join(' '), /2 message\(s\) on the topic were not turnstile.settlement records/);
});

test('totals are in dollars, per payee, and a receipt with no price adds nothing', async () => {
  const result = await readReceipts({
    topic: '0.0.1', mirrorNodeUrl: MIRROR,
    fetch: mirror({
      messages: [
        { message: b64(message({ priceUsd: 0.07 })), sequence_number: 1, consensus_timestamp: '1.0' },
        { message: b64(message({ priceUsd: 0.02, payTo: '0.0.55', transaction: '0.0.1@2.3' })), sequence_number: 2, consensus_timestamp: '2.0' },
        { message: b64(message({ priceUsd: null, transaction: '0.0.1@4.5' })), sequence_number: 3, consensus_timestamp: '3.0' },
      ],
    }),
  });
  assert.equal(result.totals.receipts, 3);
  assert.equal(result.totals.settledUsd, 0.09);
  assert.deepEqual(result.totals.byPayee, [
    { payTo: '0.0.10403961', count: 2, usd: 0.07 },
    { payTo: '0.0.55', count: 1, usd: 0.02 },
  ]);
  assert.deepEqual(result.window, { firstConsensus: '1.0', lastConsensus: '3.0' });
});

test('with no topic it reads nothing and says why, rather than returning zero', async () => {
  const result = await readReceipts({ topic: undefined, mirrorNodeUrl: MIRROR, fetch: mirror() });
  const wasSet = process.env['HEDERA_RECEIPT_TOPIC_ID'];
  if (wasSet) {
    assert.equal(result.topic, wasSet);
  } else {
    assert.equal(result.topic, null);
    assert.match(result.notes.join(' '), /No topic was given and HEDERA_RECEIPT_TOPIC_ID is unset/);
  }
});

test('an unreachable mirror node is an empty result with a reason, not a throw', async () => {
  const result = await readReceipts({
    topic: '0.0.1', mirrorNodeUrl: MIRROR,
    fetch: (async () => { throw new Error('ECONNREFUSED'); }) as typeof globalThis.fetch,
  });
  assert.equal(result.totals.receipts, 0);
  assert.match(result.notes.join(' '), /could not be reached: ECONNREFUSED/);
});
