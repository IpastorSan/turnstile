// Tests for the seam itself, rather than for the service over it.
//
// Most of these pin a property MOV-220 and MOV-225 are about to depend on. If
// one fails after a rail lands, the rail is wrong — or the seam is, and it is
// worth finding out which before two implementations have been built on it.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createArcRail } from './arc-usdc/index.ts';
import { createBaseMainnetRail, createBaseRail } from './base-usdc/index.ts';
import { createHederaRail } from './hedera-x402/index.ts';
// The Hedera rail reads its facilitator and its exchange rate over HTTP. A unit
// suite that hit the network for that would be slow, offline-hostile, and would
// go red when Blocky402 has a bad afternoon rather than when we broke something.
import { fakeFacilitatorFetch, offlineRailOptions } from './hedera-x402/testing.ts';
// Same reason for the Arc rail: it reads Circle Gateway's `/supported` on every
// challenge, because the EIP-712 domain a payer signs against lives there.
import { fakeGateway, offlineRailOptions as offlineArcOptions } from './arc-usdc/testing.ts';
// And the same again for Base: its `/supported` is what says the network is
// settleable at all.
import { offlineMainnetOptions, offlineOptions as offlineBaseOptions } from './base-usdc/testing.ts';
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

test('a rail that settles nothing says so, and one that settles says that instead', async () => {
  // **Correction (2026-09-07, MOV-220):** this test used to assert that *both*
  // rails were placeholders. `hedera-x402` now settles for real, so the property
  // worth pinning is no longer "everything is a stub" but the one that was
  // underneath it all along: **what a rail says on the wire matches what it
  // does.** A service that advertises a rail and settles nothing, without saying
  // so, looks identical from outside to one that works — and a live rail that
  // still calls itself a stub is the same failure pointed the other way.
  //
  // **Correction (2026-09-07, MOV-225):** and this test then said "`arc-usdc` is
  // still MOV-225's placeholder and is checked as one". It is not. Both rails
  // settle real value now, so what is left to pin is the invariant itself,
  // across every rail rather than one at a time: `info.live` and
  // `extra.turnstileSettlement` agree, and a live rail carries no PLACEHOLDER
  // note. Written as a loop so a third rail is covered the day it is added
  // rather than the day someone remembers to extend this.
  const rails = [
    createHederaRail(offlineRailOptions(fakeFacilitatorFetch())),
    createArcRail(offlineArcOptions(fakeGateway())),
    createBaseRail(offlineBaseOptions()), createBaseMainnetRail(offlineMainnetOptions()),
  ];

  for (const r of rails) {
    const requirement = await r.challenge({ resource: RESOURCE, description: 'x', priceUsd: 0.07 });
    assert.equal(
      requirement.extra['turnstileSettlement'],
      r.info.live ? 'live' : 'stub',
      `${r.id} says live=${r.info.live} in info but ${String(requirement.extra['turnstileSettlement'])} on the wire`,
    );
    if (r.info.live) {
      assert.equal(requirement.extra['turnstileNote'], undefined, `${r.id} is live and still carries a placeholder note`);
    } else {
      assert.match(String(requirement.extra['turnstileNote']), /PLACEHOLDER/);
    }
  }

  // All three shipped rails are live as of 2026-09-11 (Base joined the other
  // two). Asserted rather than assumed, so that a rail silently regressing to a
  // stub fails here.
  assert.deepEqual(rails.map(r => `${r.id}=${r.info.live}`).sort(), ['arc-usdc=true', 'base-usdc-mainnet=true', 'base-usdc=true', 'hedera-x402=true']);

  // And the stub rail still tells the truth in the other direction.
  const stub = rail('placeholder', 'chain:9');
  assert.equal(stub.info.live, false);
  const stubbed = await stub.challenge({ resource: RESOURCE, description: 'x', priceUsd: 0.07 });
  assert.equal(stubbed.extra['turnstileSettlement'], 'stub');
  assert.match(String(stubbed.extra['turnstileNote']), /PLACEHOLDER/);
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
  //
  // **The Base rail (added 2026-09-11) reuses `x402` deliberately.** It is an
  // x402 rail, and the record has not been rewritten to name it: that costs a
  // cold-key transaction. So the token SET still matches the chain — what the
  // record slightly undersells is how many rails sit behind `x402`. If the
  // record is ever rewritten to distinguish them, this test is where it fails,
  // which is the point of pinning it.
  const ON_CHAIN = 'x402,usdc-arc';

  const registry = new RailRegistry([createHederaRail(offlineRailOptions(fakeFacilitatorFetch())), createArcRail(offlineArcOptions(fakeGateway())), createBaseRail(offlineBaseOptions()), createBaseMainnetRail(offlineMainnetOptions())]);
  const advertised = registry.describe().map(info => info.ensRailToken).sort();
  assert.deepEqual([...new Set(advertised)], ON_CHAIN.split(',').sort());

  // And the ids stay the directory names, so a reader of either can find the other.
  assert.deepEqual(registry.describe().map(info => info.id).sort(), ['arc-usdc', 'base-usdc', 'base-usdc-mainnet', 'hedera-x402']);
});

test('the three shipped rails are routable against each other', async () => {
  // The property MOV-220, MOV-225 and the Base rail all rely on: distinct
  // (scheme, network), so a payment can be attributed. If any rail changes its
  // network to another's, this fails rather than the money going astray.
  const registry = new RailRegistry([createHederaRail(offlineRailOptions(fakeFacilitatorFetch())), createArcRail(offlineArcOptions(fakeGateway())), createBaseRail(offlineBaseOptions()), createBaseMainnetRail(offlineMainnetOptions())]);
  const { accepts, failed } = await registry.challengeAll({ resource: RESOURCE, description: 'x', priceUsd: 0.07 });
  assert.deepEqual(failed, []);
  assert.equal(accepts.length, 4);
  assert.equal(new Set(accepts.map(a => `${a.scheme} ${a.network}`)).size, 4);
});
