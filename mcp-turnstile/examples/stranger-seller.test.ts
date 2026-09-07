// The reusable-infrastructure claim, mechanized.
//
// A seller that shares no code with Turnstile's own service, on a URL shape
// Turnstile does not use, at a price Turnstile does not charge — quoted and
// bought by `get_offer` and `purchase` with nothing configured about it. If this
// ever fails, the MCP server has grown a dependency on our seller and stops
// qualifying as infrastructure.
//
// Offline: a stub rail and a stub signer, so this runs in CI with no testnet, no
// facilitator and no funded key. The live version of exactly this flow is
// `discover-pay-reason.ts`, which settles real HBAR.

import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../../graph/sink/db.ts';
import { createStubRail } from '../../rails/stub-rail.ts';
import { createStubSigner } from '../../buyer/watchdog/stub-signer.ts';
import { getOffer } from '../offer.ts';
import { purchase } from '../purchase.ts';
import { STRANGER_PRICE_USD, startStrangerSeller } from './stranger-seller.ts';

const rail = () => createStubRail({
  id: 'stranger-rail', label: 'A rail the buyer happens to hold a signer for',
  scheme: 'exact', network: 'testnamespace:stranger',
  asset: { id: 'test-usd', symbol: 'USDC', decimals: 6 },
  ensRailToken: 'stranger', payTo: 'stranger-payout-account',
  // `extra.name` is where x402 puts the asset's EIP-712 domain name, and it is
  // the only thing in a challenge that says what unit `amount` is in. Without
  // it a buyer can only take the seller's own dollar figure on trust — which is
  // exactly what `basis: 'seller_declared'` reports elsewhere in these tests.
  extra: { name: 'USDC' },
});

const signer = () => createStubSigner({
  railId: 'stranger-rail', scheme: 'exact', network: 'testnamespace:stranger',
  decimals: 6, usdPerUnit: 1, payer: 'buyer-account',
});

test('a stranger with a bare URL is quoted, with nothing configured about it', async () => {
  const seller = await startStrangerSeller({ rail: rail() });
  const db = openDb(':memory:');
  try {
    const offer = await getOffer(db, `${seller.baseUrl}/v1/gas-window/base`);
    assert.equal(offer.refKind, 'url');
    assert.equal(offer.agent, null, 'the directory was not consulted and did not need to be');
    assert.equal(offer.purchasable.ok, true);
    assert.equal(offer.offer.priceUsd, STRANGER_PRICE_USD, "the price came off the stranger's own 402");
    assert.equal(offer.offer.payTo, 'stranger-payout-account', 'and so did the payout account');
    assert.equal(offer.offer.basis, 'stablecoin_unit');
  } finally {
    db.close();
    await seller.close();
  }
});

test('and bought, by the same purchase path that buys from our own seller', async () => {
  const seller = await startStrangerSeller({ rail: rail() });
  try {
    const result = await purchase({
      resource: `${seller.baseUrl}/v1/gas-window/optimism`,
      maxPriceUsd: 0.5,
      signers: [signer()],
      allowPrivateHosts: true,
    });
    assert.equal(result.status, 'purchased');
    assert.equal((result.answer as { chain: string }).chain, 'optimism');
    assert.equal(result.settlement?.success, true);
    // A network nothing knows an explorer for gets no link rather than a guess.
    assert.equal(result.settlement?.explorer, null);
  } finally {
    await seller.close();
  }
});

test('the stranger refuses a payment below its own price', async () => {
  const seller = await startStrangerSeller({ rail: rail(), priceUsd: 0.5 });
  try {
    const result = await purchase({
      resource: `${seller.baseUrl}/v1/gas-window/base`,
      maxPriceUsd: 0.1,
      signers: [signer()],
      allowPrivateHosts: true,
    });
    // Refused by the BUYER's mandate, before a signature exists. The seller's
    // own floor check is the second line of defence, not the first.
    assert.equal(result.status, 'refused');
    assert.match(result.decision!.rejected[0]!.reason, /exceeds the mandate cap/);
  } finally {
    await seller.close();
  }
});

test('the stranger writes no receipt to anyone else\'s audit trail', async () => {
  // `topicId: null` disables it outright, as against omitting it — which would
  // fall back to HEDERA_RECEIPT_TOPIC_ID and file a stranger's sales under ours.
  const seller = await startStrangerSeller({ rail: rail() });
  try {
    const result = await purchase({
      resource: `${seller.baseUrl}/v1/gas-window/base`,
      maxPriceUsd: 0.5, signers: [signer()], allowPrivateHosts: true,
    });
    assert.equal(result.status, 'purchased');
    assert.equal((result.settlement as { transaction: string }).transaction.startsWith('stub:'), true);
  } finally {
    await seller.close();
  }
});
