// Tests for the Hedera rail, offline.
//
// These pin the parts of the rail that a real payment does **not** prove.
// `scripts/hedera-paid-request.ts` proves the happy path against the real
// facilitator and the real network, and it is the only thing that can; what it
// cannot do is exercise the failures — an unreachable facilitator, a rejection
// code, a replayed transaction — without arranging for them on a live network.
// So the happy path is checked on chain and the failures are checked here.
//
// The fixtures in `./testing.ts` are copied from real responses rather than
// invented, for the reason stated there.

import test from 'node:test';
import assert from 'node:assert/strict';

import { PaymentRailError } from '../PaymentRail.ts';
import type { PaymentPayload, PaymentRequirement } from '../PaymentRail.ts';
import { HBAR_ASSET, NETWORK, toMirrorNodeTransactionId } from './config.ts';
import { toVerifyFailureReason } from './facilitator.ts';
import { HcsReceiptTopic } from './hcs.ts';
import { createHederaRail } from './index.ts';
import { FEE_PAYER, SAMPLE_TRANSACTION_ID, fakeFacilitatorFetch, offlineRailOptions } from './testing.ts';

const RESOURCE = 'https://liquidity.turnstile.eth/analyze/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640';

function railWith(options: Parameters<typeof fakeFacilitatorFetch>[0] = {}) {
  const fetch = fakeFacilitatorFetch(options);
  return { rail: createHederaRail(offlineRailOptions(fetch)), fetch };
}

function signed(requirement: PaymentRequirement, transaction = 'BASE64-PART-SIGNED-TRANSACTION'): PaymentPayload {
  return { x402Version: 2, accepted: requirement, payload: { transaction } };
}

test('the challenge carries the facilitator\'s fee payer, and prices dollars in tinybars', async () => {
  const { rail } = railWith();
  const requirement = await rail.challenge({ resource: RESOURCE, description: 'x', priceUsd: 0.07 });

  assert.equal(requirement.scheme, 'exact');
  assert.equal(requirement.network, NETWORK);
  assert.equal(requirement.asset, HBAR_ASSET);
  // Not optional garnish: the client SDK throws without it and the facilitator
  // rejects a transaction whose id names any other account.
  assert.equal(requirement.extra['feePayer'], FEE_PAYER);

  // $0.07 at 8.297 cents/HBAR = 0.84367844 HBAR. Eight decimals, not six —
  // quoting USDC's six here would underpay by a factor of 100.
  assert.equal(requirement.amount, '84367844');
  assert.equal(requirement.extra['decimals'], 8);
  assert.equal(requirement.extra['symbol'], 'HBAR');
  // The rate is stated rather than implied, so a payer can check the arithmetic.
  assert.match(String(requirement.extra['rateSource']), /exchangerate/);

  // And it no longer claims to be a placeholder, because it no longer is.
  assert.equal(requirement.extra['turnstileSettlement'], 'live');
  assert.equal(requirement.extra['turnstileNote'], undefined);
});

test('a facilitator that has stopped covering this network fails the challenge rather than quoting', async () => {
  // Minting a quote nobody can settle is worse than returning 503: the payer
  // signs, pays the round trip, and finds out at settlement.
  const { rail } = railWith({ withoutHedera: true });
  await assert.rejects(
    () => rail.challenge({ resource: RESOURCE, description: 'x', priceUsd: 0.07 }),
    (err: unknown) => {
      assert.ok(err instanceof PaymentRailError);
      assert.equal(err.reason, 'unsupported_rail');
      assert.match(err.message, /does not settle exact on hedera:testnet/);
      return true;
    },
  );
});

test('an unreachable facilitator is a rail failure, not a bad payment', async () => {
  // The distinction the service turns into 503 vs 402. Telling a payer their
  // payment was rejected when the truth is that we could not ask is how a buyer
  // ends up giving up on a payment that was fine.
  const { rail } = railWith({ unreachable: true });
  await assert.rejects(
    () => rail.challenge({ resource: RESOURCE, description: 'x', priceUsd: 0.07 }),
    (err: unknown) => {
      assert.ok(err instanceof PaymentRailError);
      assert.equal(err.reason, 'facilitator_unavailable');
      return true;
    },
  );

  const ok = railWith();
  const requirement = await ok.rail.challenge({ resource: RESOURCE, description: 'x', priceUsd: 0.07 });
  const broken = createHederaRail(offlineRailOptions(fakeFacilitatorFetch({ unreachable: true })));
  await assert.rejects(() => broken.verify(signed(requirement)), (err: unknown) => {
    assert.ok(err instanceof PaymentRailError);
    assert.equal(err.reason, 'facilitator_unavailable');
    return true;
  });
});

test('verify posts the payer\'s own accepted requirement, because that is what the facilitator compares', async () => {
  // Blocky402 checks parity between `paymentPayload.accepted` and the
  // `paymentRequirements` we post, on asset, amount, payTo, maxTimeoutSeconds
  // and extra.feePayer. Posting a freshly issued requirement instead would fail
  // that check the moment the exchange rate ticked, on an honest payment.
  const { rail, fetch } = railWith();
  const requirement = await rail.challenge({ resource: RESOURCE, description: 'x', priceUsd: 0.07 });
  const payload = signed(requirement);

  const result = await rail.verify(payload, { resource: RESOURCE, offered: [requirement] });
  assert.equal(result.valid, true);
  assert.equal(result.payer, '0.0.10408012');

  const call = fetch.calls.find(c => c.url.endsWith('/verify'))!;
  const body = call.body as { x402Version: number; paymentPayload: PaymentPayload; paymentRequirements: PaymentRequirement };
  assert.equal(body.x402Version, 2);
  assert.deepEqual(body.paymentRequirements, payload.accepted);
});

test('the same signed transaction cannot buy a second answer', async () => {
  // The replay guard. Hedera would eventually reject a duplicate transaction id
  // itself — but only after we had done the work and handed over the answer,
  // which is exactly the outcome the guard exists to prevent.
  const { rail } = railWith();
  const requirement = await rail.challenge({ resource: RESOURCE, description: 'x', priceUsd: 0.07 });
  const payload = signed(requirement);

  assert.equal((await rail.verify(payload)).valid, true);
  const receipt = await rail.settle(payload);
  assert.equal(receipt.success, true);
  assert.equal(receipt.transaction, SAMPLE_TRANSACTION_ID);

  const replay = await rail.verify(payload);
  assert.equal(replay.valid, false);
  assert.equal(replay.reason, 'already_settled');
});

test('a payment is checked against this seller before the facilitator is asked', async () => {
  const { rail, fetch } = railWith();
  const requirement = await rail.challenge({ resource: RESOURCE, description: 'x', priceUsd: 0.07 });

  const diverted = await rail.verify(signed({ ...requirement, payTo: '0.0.999999' }));
  assert.equal(diverted.valid, false);
  assert.equal(diverted.reason, 'wrong_recipient');

  const empty = await rail.verify({ x402Version: 2, accepted: requirement, payload: {} });
  assert.equal(empty.valid, false);
  assert.equal(empty.reason, 'invalid_signature');

  // Advisory rather than load-bearing — see the header of index.ts — but it
  // catches an honest client pointed at the wrong URL.
  const wrongResource = await rail.verify(signed(requirement), {
    resource: 'https://liquidity.turnstile.eth/analyze/0xother',
    offered: [requirement],
  });
  assert.equal(wrongResource.valid, false);
  assert.match(wrongResource.detail ?? '', /issued for/);

  // None of the three cost a round trip.
  assert.deepEqual(fetch.calls.filter(c => c.url.endsWith('/verify')), []);
});

test('a facilitator rejection is translated into a code the buyer can act on', async () => {
  const { rail } = railWith({
    verify: { isValid: false, invalidReason: 'invalid_exact_hedera_payload_preflight_failed', invalidMessage: 'insufficient balance', payer: '0.0.10408012' },
  });
  const requirement = await rail.challenge({ resource: RESOURCE, description: 'x', priceUsd: 0.07 });
  const result = await rail.verify(signed(requirement));

  assert.equal(result.valid, false);
  assert.equal(result.reason, 'insufficient_funds');
  assert.equal(result.payer, '0.0.10408012');
  // The raw code survives into `detail`, so an operator reading a log is not
  // limited to our translation of it.
  assert.match(result.detail ?? '', /preflight_failed/);
});

test('the reason table maps the codes @x402/hedera actually emits', () => {
  // Written against the codes read out of @x402/hedera's facilitator scheme, not
  // guessed. A buyer that retries on a misclassified code wastes a payment.
  assert.equal(toVerifyFailureReason('invalid_exact_hedera_payload_signature_invalid'), 'invalid_signature');
  assert.equal(toVerifyFailureReason('invalid_exact_hedera_payload_amount_mismatch'), 'wrong_amount');
  assert.equal(toVerifyFailureReason('invalid_exact_hedera_payload_pay_to'), 'wrong_recipient');
  assert.equal(toVerifyFailureReason('network_mismatch'), 'unsupported_rail');
  assert.equal(toVerifyFailureReason('unsupported_scheme'), 'unsupported_rail');
  assert.equal(toVerifyFailureReason('fee_payer_not_managed_by_facilitator'), 'unsupported_rail');
  assert.equal(toVerifyFailureReason('accepted_payment_requirements_mismatch'), 'wrong_amount');
  // The balance case only ever surfaces in prose from the preflight hook, so the
  // code alone is not enough to classify it.
  assert.equal(toVerifyFailureReason('invalid_exact_hedera_payload_preflight_failed', 'insufficient balance'), 'insufficient_funds');
  assert.equal(toVerifyFailureReason('transaction_failed', 'TRANSACTION_EXPIRED'), 'expired');
  // Anything unrecognised stays unknown rather than being forced into a
  // neighbouring bucket a buyer would act on.
  assert.equal(toVerifyFailureReason('some_code_added_next_release'), 'unknown');
  assert.equal(toVerifyFailureReason(undefined), 'unknown');
});

test('a settlement failure is a receipt, not a throw', async () => {
  // The service has an answer in hand by the time settle() runs. A throw there
  // is an accounting problem dressed as a crash.
  const { rail } = railWith({ settle: { success: false, errorReason: 'transaction_failed', errorMessage: 'INSUFFICIENT_ACCOUNT_BALANCE' } });
  const requirement = await rail.challenge({ resource: RESOURCE, description: 'x', priceUsd: 0.07 });
  const receipt = await rail.settle(signed(requirement));

  assert.equal(receipt.success, false);
  assert.equal(receipt.railId, 'hedera-x402');
  assert.match(receipt.error ?? '', /INSUFFICIENT_ACCOUNT_BALANCE/);

  // And a failed settlement must not burn the payment: the payer can retry.
  assert.equal((await rail.verify(signed(requirement))).valid, true);

  const unreachable = createHederaRail(offlineRailOptions(fakeFacilitatorFetch({ unreachable: true })));
  const noThrow = await unreachable.settle(signed(requirement));
  assert.equal(noThrow.success, false);
  assert.equal(noThrow.transaction, '');
});

test('a settled receipt carries the links an auditor needs', async () => {
  const { rail } = railWith();
  const requirement = await rail.challenge({ resource: RESOURCE, description: 'x', priceUsd: 0.07 });
  const receipt = await rail.settle(signed(requirement));

  assert.equal(receipt.success, true);
  assert.equal(receipt.payer, '0.0.10408012');
  assert.equal(receipt.amount, '84367844');
  assert.equal(receipt.extra?.['feePayer'], FEE_PAYER);
  assert.equal(receipt.extra?.['hashscan'], `https://hashscan.io/testnet/transaction/${SAMPLE_TRANSACTION_ID}`);
  // No topic configured in tests, and that is reported rather than left blank.
  assert.deepEqual(receipt.extra?.['hcs'], { skipped: 'no HEDERA_RECEIPT_TOPIC_ID configured' });

  assert.deepEqual(await rail.receipt(receipt.transaction), receipt);
});

test('a receipt this process never saw is read back off the public mirror node', async () => {
  // So a restarted seller can still answer for a payment it took last week. The
  // mirror node needs the dashed form of the id; the `@` form 404s in a way
  // indistinguishable from "no such transaction".
  assert.equal(toMirrorNodeTransactionId('0.0.7162784@1788791330.918068236'), '0.0.7162784-1788791330-918068236');

  const { rail } = railWith();
  const found = await rail.receipt(SAMPLE_TRANSACTION_ID);
  assert.ok(found);
  assert.equal(found.success, true);
  // The payer is the debited account, and the fee payer's own debit must not be
  // mistaken for it — Blocky402 pays the gas, so it appears in the transfer list.
  assert.equal(found.payer, '0.0.10408012');
  assert.equal(found.amount, '84367844');
  assert.equal(found.extra?.['settlement'], 'mirror-node');

  assert.equal(await rail.receipt('not-a-transaction-id'), null);
});

test('an HCS receipt records what was bought, never what was sold', async () => {
  // The topic is public. Writing the verdict into it would give away, to
  // everyone and permanently, the thing the buyer just paid for.
  const message = HcsReceiptTopic.messageFor(
    {
      railId: 'hedera-x402', transaction: SAMPLE_TRANSACTION_ID, success: true, network: NETWORK,
      payer: '0.0.10408012', amount: '84367844', asset: HBAR_ASSET, settledAt: 1788791339313, error: null,
    },
    { payTo: '0.0.10403961', priceUsd: 0.07, resource: RESOURCE },
  );

  assert.deepEqual(message, {
    v: 1,
    kind: 'turnstile.settlement',
    railId: 'hedera-x402',
    network: NETWORK,
    transaction: SAMPLE_TRANSACTION_ID,
    payer: '0.0.10408012',
    payTo: '0.0.10403961',
    amount: '84367844',
    asset: HBAR_ASSET,
    priceUsd: 0.07,
    resource: RESOURCE,
    settledAt: 1788791339313,
  });
  assert.ok(!JSON.stringify(message).includes('verdict'));

  // A topic id of `null` disables writing outright. Omitting it would fall back
  // to HEDERA_RECEIPT_TOPIC_ID and a test run with .env sourced would post to
  // the real topic.
  const disabled = new HcsReceiptTopic({ topicId: null });
  assert.equal(disabled.canWrite, false);
  assert.deepEqual(await disabled.submit(message), null);
  assert.deepEqual(await disabled.read(), []);
});
