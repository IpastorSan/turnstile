// Tests for the seam itself, rather than for the service over it.
//
// Most of these pin a property MOV-220 and MOV-225 are about to depend on. If
// one fails after a rail lands, the rail is wrong — or the seam is, and it is
// worth finding out which before two implementations have been built on it.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createArcRail } from './arc-usdc/index.ts';
import { createHederaRail } from './hedera-x402/index.ts';
import { PaymentRailError, usdToAtomic } from './PaymentRail.ts';
import type { PaymentPayload, PaymentRail, PaymentRequirement } from './PaymentRail.ts';
import { RailRegistry } from './registry.ts';
import { createStubRail } from './stub-rail.ts';

const RESOURCE = 'https://seller.example/analyze/0xpool';

function rail(id: string, network: string, over: Partial<Parameters<typeof createStubRail>[0]> = {}): PaymentRail {
  return createStubRail({
    id, label: `${id} rail`, scheme: 'exact', network,
    asset: { id: `${id}-asset`, symbol: 'TUSD', decimals: 6 },
    ensRailToken: id, payTo: `${id}-payout`, ...over,
  });
}

function signed(requirement: PaymentRequirement): PaymentPayload {
  return { x402Version: 2, accepted: requirement, payload: { signature: 'stub', payer: 'buyer' } };
}

test('usdToAtomic scales through an integer rather than a float', () => {
  // 0.07 * 1e6 evaluates to 69999.99999999999 in IEEE 754. A price that arrives
  // one unit light is rejected by the facilitator, on a rail nobody is looking
  // at, in a demo.
  assert.equal(usdToAtomic(0.07, 6), '70000');
  assert.equal(usdToAtomic(0.35, 6), '350000');
  assert.equal(usdToAtomic(0.1, 18), '100000000000000000');
  assert.equal(usdToAtomic(0, 6), '0');

  // A rail whose asset is not a dollar converts through its own rate.
  assert.equal(usdToAtomic(1, 8, 50_000), '2000');

  assert.throws(() => usdToAtomic(-1, 6), RangeError);
  assert.throws(() => usdToAtomic(Number.NaN, 6), RangeError);
  assert.throws(() => usdToAtomic(1, 6, 0), RangeError);
});

test('a registry refuses two rails that would be unroutable', () => {
  // x402 carries only (scheme, network) back from the payer. Two rails sharing
  // that pair could not be told apart at settlement, so this has to fail at
  // construction — the alternative is money landing on the wrong rail.
  assert.throws(
    () => new RailRegistry([rail('a', 'chain:1'), rail('b', 'chain:1')]),
    /both claim scheme exact on chain:1/,
  );
  assert.throws(() => new RailRegistry([]), /at least one/);
  assert.throws(() => new RailRegistry([rail('a', 'chain:1'), rail('a', 'chain:2')]), /duplicate rail id/);
});

test('a payment routes back to the rail that issued its challenge', async () => {
  const registry = new RailRegistry([rail('a', 'chain:1'), rail('b', 'chain:2')]);
  const { accepts } = await registry.challengeAll({ resource: RESOURCE, description: 'x', priceUsd: 0.07 });

  for (const accept of accepts) {
    const routed = registry.routeOrThrow(signed(accept));
    assert.equal(routed.info.network, accept.network);
  }

  assert.throws(
    () => registry.routeOrThrow(signed({ ...accepts[0]!, network: 'chain:999' })),
    (err: unknown) => {
      assert.ok(err instanceof PaymentRailError);
      assert.equal(err.reason, 'unsupported_rail');
      // The error names what this seller does accept, so a buyer can retry
      // without fetching the challenge again.
      assert.match(err.message, /this seller accepts exact\/chain:1, exact\/chain:2/);
      return true;
    },
  );
});

test('one broken rail does not take the challenge down with it', async () => {
  const broken: PaymentRail = {
    ...rail('broken', 'chain:9'),
    async challenge() { throw new Error('facilitator unreachable'); },
  };
  const registry = new RailRegistry([rail('healthy', 'chain:1'), broken]);

  const { accepts, failed } = await registry.challengeAll({ resource: RESOURCE, description: 'x', priceUsd: 0.07 });

  // The buyer can still pay, on the rail that works.
  assert.equal(accepts.length, 1);
  assert.equal(accepts[0]!.network, 'chain:1');
  // And the failure is reported rather than swallowed — an operator has to be
  // able to see that a rail has been down all afternoon.
  assert.deepEqual(failed, [{ railId: 'broken', error: 'facilitator unreachable' }]);
});

test('the receipt lookup spans every rail, because the audit trail is rail-agnostic', async () => {
  const registry = new RailRegistry([rail('a', 'chain:1'), rail('b', 'chain:2')]);
  const { accepts } = await registry.challengeAll({ resource: RESOURCE, description: 'x', priceUsd: 0.07 });

  const receipts = [];
  for (const accept of accepts) {
    receipts.push(await registry.routeOrThrow(signed(accept)).settle(signed(accept)));
  }

  for (const receipt of receipts) {
    const found = await registry.findReceipt(receipt.transaction);
    assert.deepEqual(found, receipt);
  }
  assert.equal(await registry.findReceipt('never-settled'), null);
});

test('a challenge is bound to the resource it was issued for', async () => {
  const one = rail('a', 'chain:1');
  const cheap = await one.challenge({ resource: 'https://seller.example/cheap', description: 'x', priceUsd: 0.07 });

  const wrongResource = await one.verify(signed(cheap), {
    resource: 'https://seller.example/expensive',
    offered: [cheap],
  });
  assert.equal(wrongResource.valid, false);
  assert.match(wrongResource.detail ?? '', /issued for/);

  const rightResource = await one.verify(signed(cheap), {
    resource: 'https://seller.example/cheap',
    offered: [cheap],
  });
  assert.equal(rightResource.valid, true);
  assert.equal(rightResource.reason, null);
});

test('verify says why it refused, not merely that it did', async () => {
  const one = rail('a', 'chain:1');
  const requirement = await one.challenge({ resource: RESOURCE, description: 'x', priceUsd: 0.07 });

  const unsigned = await one.verify({ x402Version: 2, accepted: requirement, payload: {} });
  assert.equal(unsigned.valid, false);
  // A bare `false` here would be indistinguishable from "wrong chain", and the
  // buyer's next move differs: one is give up, the other is retry elsewhere.
  assert.equal(unsigned.reason, 'invalid_signature');

  const diverted = await one.verify(signed({ ...requirement, payTo: 'attacker' }));
  assert.equal(diverted.valid, false);
  assert.equal(diverted.reason, 'wrong_recipient');
});

test('every advertised rail says out loud that it settles nothing yet', async () => {
  // MOV-219 ships two placeholders. A service that advertises a rail and settles
  // nothing, without saying so, looks identical from outside to one that works —
  // which is exactly the failure a demo must not walk into.
  for (const make of [createHederaRail, createArcRail]) {
    const placeholder = make();
    assert.equal(placeholder.info.live, false, `${placeholder.id} claims to be live`);

    const requirement = await placeholder.challenge({ resource: RESOURCE, description: 'x', priceUsd: 0.07 });
    assert.equal(requirement.extra['turnstileSettlement'], 'stub');
    assert.match(String(requirement.extra['turnstileNote']), /PLACEHOLDER/);
  }
});

test('the advertised rails reconcile with the on-chain turnstile:rails record', async () => {
  // `turnstile:rails` on liquidity.turnstile.eth reads "x402,usdc-arc", read live
  // off Sepolia on 2026-09-07. It is cold-key-written, so the code has to match
  // the record rather than the other way round: a buyer that discovered us
  // through ENS filters on those tokens, and would not recognise a seller
  // advertising anything else.
  //
  // The tokens are NOT the rail ids — see docs/ens-offer-records.md, and
  // RailInfo.ensRailToken.
  const ON_CHAIN = 'x402,usdc-arc';

  const registry = new RailRegistry([createHederaRail(), createArcRail()]);
  const advertised = registry.describe().map(info => info.ensRailToken).sort();
  assert.deepEqual(advertised, ON_CHAIN.split(',').sort());

  // And the ids stay the directory names, so a reader of either can find the other.
  assert.deepEqual(registry.describe().map(info => info.id).sort(), ['arc-usdc', 'hedera-x402']);
});

test('the two placeholder rails are routable against each other', async () => {
  // The property MOV-220 and MOV-225 both rely on: distinct (scheme, network),
  // so a payment can be attributed. If either issue changes its network to the
  // other's, this fails rather than the money going astray.
  const registry = new RailRegistry([createHederaRail(), createArcRail()]);
  const { accepts, failed } = await registry.challengeAll({ resource: RESOURCE, description: 'x', priceUsd: 0.07 });
  assert.deepEqual(failed, []);
  assert.equal(accepts.length, 2);
  assert.equal(new Set(accepts.map(a => `${a.scheme} ${a.network}`)).size, 2);
});
