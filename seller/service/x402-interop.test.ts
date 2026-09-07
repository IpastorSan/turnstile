// Proof that the wire format is the specification's and not our reading of it.
//
// `x402.ts` is our own middleware rather than the SDK's, for the reason given in
// its header. That trade is only safe if the bytes it emits are the ones a real
// x402 client expects, so this file checks it the way that actually counts:
//
//   1. the 402 body parses under `@x402/core`'s own zod schema;
//   2. an unmodified `@x402/fetch` client — the SDK's, not ours — walks the whole
//      flow against our server and comes back with a 200.
//
// If the SDK moves, these fail. That is the point: better a red test than a
// service that has quietly stopped speaking x402 to anybody but itself.

import test from 'node:test';
import assert from 'node:assert/strict';

import { decodePaymentResponseHeader } from '@x402/core/http';
// `validateX` throws on anything the specification does not allow; `parseX`
// returns a zod result instead. A test wants the throw.
import { validatePaymentPayload, validatePaymentRequired } from '@x402/core/schemas';

import { createPaidFetch, enforceMandate } from '../../buyer/watchdog/pay.ts';
import type { SpendingLimits } from '../../buyer/watchdog/pay.ts';
import { createStubSigner } from '../../buyer/watchdog/stub-signer.ts';
import type { PaymentRequirement } from '../../rails/PaymentRail.ts';
import { createApp } from './app.ts';
import { fakeAnalyst, testRegistry, withServer } from './testing.ts';

const POOL = '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640';

function app() {
  return createApp({ registry: testRegistry(), analyst: fakeAnalyst() });
}

const signers = [
  createStubSigner({ railId: 'rail-one', scheme: 'exact', network: 'testnamespace:one', payer: 'buyer-account' }),
  createStubSigner({ railId: 'rail-two', scheme: 'exact', network: 'testnamespace:two', payer: 'buyer-account' }),
];

test('the 402 body validates against the x402 SDK schema', async () => {
  await withServer(app(), async baseUrl => {
    const res = await fetch(`${baseUrl}/analyze/${POOL}`);
    const body = await res.json();

    const parsed = validatePaymentRequired(body);
    assert.equal(parsed.x402Version, 2);
    assert.ok(parsed.accepts.length >= 2);
  });
});

test('an unmodified @x402/fetch client can pay this server', async () => {
  await withServer(app(), async baseUrl => {
    const mandate: SpendingLimits = { preferredRails: ['rail-one', 'rail-two'], maxPerPaymentUsd: 0.1 };
    const pay = createPaidFetch({ mandate, signers });

    const res = await pay(`${baseUrl}/analyze/${POOL}`);
    assert.equal(res.status, 200);

    const settle = decodePaymentResponseHeader(res.headers.get('payment-response')!);
    assert.equal(settle.success, true);
    assert.equal(settle.payer, 'buyer-account');

    const body = await res.json() as { tier: string; verdict: { rating: string } };
    assert.equal(body.tier, 'standard');
    assert.equal(body.verdict.rating, 'ACCEPTABLE');
  });
});

test('the mandate, not the seller, decides which advertised rail is paid', async () => {
  await withServer(app(), async baseUrl => {
    // The seller lists rail-one first. The buyer prefers rail-two, and the
    // buyer's preference is the one that must win — that is the entire reason a
    // 402 carries more than one option.
    const pay = createPaidFetch({
      mandate: { preferredRails: ['rail-two', 'rail-one'], maxPerPaymentUsd: 0.1 },
      signers,
    });

    const res = await pay(`${baseUrl}/analyze/${POOL}`);
    assert.equal(res.status, 200);
    const settle = decodePaymentResponseHeader(res.headers.get('payment-response')!);
    assert.equal(settle.network, 'testnamespace:two');
  });
});

test('a price above the mandate cap stops the agent rather than being paid', async () => {
  await withServer(app(), async baseUrl => {
    // The premium tier is $0.35. This mandate authorizes $0.10.
    const pay = createPaidFetch({
      mandate: { preferredRails: ['rail-one', 'rail-two'], maxPerPaymentUsd: 0.1 },
      signers,
    });

    // The hot key cannot widen its own limit, so the only correct outcome is a
    // refusal — never a payment, and never a silent downgrade to the cheap tier.
    await assert.rejects(
      () => pay(`${baseUrl}/analyze/${POOL}/attested`),
      (err: Error) => {
        assert.match(err.message, /exceeds the mandate cap|authorizes none/);
        return true;
      },
    );
  });
});

test('the same client pays the premium tier when the mandate allows it', async () => {
  await withServer(app(), async baseUrl => {
    const pay = createPaidFetch({
      mandate: { preferredRails: ['rail-one', 'rail-two'], maxPerPaymentUsd: 0.5 },
      signers,
    });

    const res = await pay(`${baseUrl}/analyze/${POOL}/attested`);
    assert.equal(res.status, 200);
    const body = await res.json() as { tier: string; analystInput: unknown };
    assert.equal(body.tier, 'premium');
    assert.ok(body.analystInput);
  });
});

test('a PaymentRequirement is structurally an x402 PaymentRequirements', () => {
  // The one place our types and the SDK's meet is a cast in `x402.ts`. If the
  // SDK ever adds a required field or renames one, this fails here rather than
  // at a payer's client.
  const requirement: PaymentRequirement = {
    scheme: 'exact',
    network: 'testnamespace:one',
    asset: 'test-asset-one',
    amount: '70000',
    payTo: 'payout-account-one',
    maxTimeoutSeconds: 300,
    extra: { anything: 'the service never reads this' },
  };

  const payload = validatePaymentPayload({
    x402Version: 2,
    accepted: requirement,
    payload: { signature: 'stub' },
  });
  // The SDK's `PaymentPayload` is a v1 | v2 union — v1 carries `scheme`/`network`
  // at the top level and no `accepted` at all. Narrowing on the version is how
  // you get at the v2 shape, and it is worth knowing before a rail author trips
  // over it.
  assert.equal(payload.x402Version, 2);
  assert.ok('accepted' in payload);
  assert.deepEqual(payload.accepted, requirement);
});

test('enforceMandate refuses rather than improvising when nothing qualifies', () => {
  const offer: PaymentRequirement = {
    scheme: 'exact', network: 'unknown:chain', asset: 'x', amount: '1000',
    payTo: 'someone', maxTimeoutSeconds: 300, extra: {},
  };
  const decision = enforceMandate([offer], { preferredRails: ['rail-one'], maxPerPaymentUsd: 1 }, signers);
  assert.equal(decision.chosen, null);
  // The refusal has to say which option failed and why, or an operator cannot
  // tell "the seller is too expensive" from "we hold no key for that chain".
  assert.equal(decision.rejected.length, 1);
  assert.match(decision.rejected[0]!.reason, /no signer for exact on unknown:chain/);
});
