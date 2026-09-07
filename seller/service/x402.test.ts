// The x402 flow, end to end over real HTTP, with stub rails.
//
// These are the acceptance criteria for MOV-219 written down as assertions:
// an unpaid request is challenged, the challenge offers more than one rail, a
// paid request is served with a settlement receipt on it, and a payment issued
// for the cheap tier cannot buy the expensive one.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from '@x402/core/http';

import type { PaymentPayload, PaymentRequirement } from '../../rails/PaymentRail.ts';
import { createApp } from './app.ts';
import { TIERS } from './tiers.ts';
import type { PaymentRequiredBody } from './x402.ts';
import { fakeAnalyst, testRegistry, withServer } from './testing.ts';

const POOL = '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640';

function app() {
  return createApp({ registry: testRegistry(), analyst: fakeAnalyst() });
}

/** Sign an offer the way the stub rails' `verify()` expects. */
function sign(chosen: PaymentRequirement): string {
  const payload: PaymentPayload = {
    x402Version: 2,
    accepted: chosen,
    payload: { signature: 'stub-signature', payer: 'stub-buyer' },
  };
  return encodePaymentSignatureHeader(payload as never);
}

async function challengeFor(baseUrl: string, path: string): Promise<{ res: Response; body: PaymentRequiredBody }> {
  const res = await fetch(`${baseUrl}${path}`);
  return { res, body: await res.json() as PaymentRequiredBody };
}

test('an unpaid request is answered with 402 and a well-formed PAYMENT-REQUIRED', async () => {
  await withServer(app(), async baseUrl => {
    const { res, body } = await challengeFor(baseUrl, `/analyze/${POOL}`);

    assert.equal(res.status, 402);

    // The header is where the protocol reads the challenge. The body carries the
    // same object so a human with curl can see it too; both must be present and
    // must agree.
    const header = res.headers.get('payment-required');
    assert.ok(header, 'PAYMENT-REQUIRED header is missing');
    assert.deepEqual(decodePaymentRequiredHeader(header), body);

    assert.equal(body.x402Version, 2);
    assert.equal(body.resource.url, `${baseUrl}/analyze/${POOL}`);
    assert.ok(body.error);

    for (const accept of body.accepts) {
      assert.equal(typeof accept.scheme, 'string');
      assert.match(accept.network, /^[^:]+:.+$/, 'network must be a CAIP-2 identifier');
      assert.match(accept.amount, /^\d+$/, 'amount must be an integer string in the smallest unit');
      assert.ok(accept.payTo.length > 0);
      assert.ok(accept.maxTimeoutSeconds > 0);
    }

    // A challenge is priced for one moment and one buyer.
    assert.match(res.headers.get('cache-control') ?? '', /no-store/);
  });
});

test('the challenge advertises more than one rail, on distinct networks', async () => {
  await withServer(app(), async baseUrl => {
    const { body } = await challengeFor(baseUrl, `/analyze/${POOL}`);
    assert.ok(body.accepts.length >= 2, `expected >= 2 rails, got ${body.accepts.length}`);
    const networks = new Set(body.accepts.map(a => a.network));
    assert.equal(networks.size, body.accepts.length, 'each rail must be routable, so networks must be distinct');
  });
});

test('a paid request returns 200 with a PAYMENT-RESPONSE receipt', async () => {
  await withServer(app(), async baseUrl => {
    const { body: challenge } = await challengeFor(baseUrl, `/analyze/${POOL}`);
    const chosen = challenge.accepts[0]!;

    const res = await fetch(`${baseUrl}/analyze/${POOL}`, { headers: { 'PAYMENT-SIGNATURE': sign(chosen) } });
    assert.equal(res.status, 200);

    const header = res.headers.get('payment-response');
    assert.ok(header, 'PAYMENT-RESPONSE header is missing from the paid 200');
    const settle = decodePaymentResponseHeader(header);
    assert.equal(settle.success, true);
    assert.equal(settle.network, chosen.network);
    assert.ok(settle.transaction.length > 0);

    const payload = await res.json() as { tier: string; verdict: { rating: string } };
    assert.equal(payload.tier, 'standard');
    assert.equal(payload.verdict.rating, 'ACCEPTABLE');
  });
});

test('either advertised rail can be the one that pays', async () => {
  await withServer(app(), async baseUrl => {
    const { body: challenge } = await challengeFor(baseUrl, `/analyze/${POOL}`);
    for (const chosen of challenge.accepts) {
      const res = await fetch(`${baseUrl}/analyze/${POOL}`, { headers: { 'PAYMENT-SIGNATURE': sign(chosen) } });
      assert.equal(res.status, 200, `paying on ${chosen.network} failed`);
      const settle = decodePaymentResponseHeader(res.headers.get('payment-response')!);
      // The receipt names the rail that actually took the money, so the audit
      // trail can tell two settlements apart.
      assert.equal(settle.network, chosen.network);
    }
  });
});

test('the receipt from a paid request is retrievable from the audit trail', async () => {
  await withServer(app(), async baseUrl => {
    const { body: challenge } = await challengeFor(baseUrl, `/analyze/${POOL}`);
    const paid = await fetch(`${baseUrl}/analyze/${POOL}`, { headers: { 'PAYMENT-SIGNATURE': sign(challenge.accepts[0]!) } });
    const settle = decodePaymentResponseHeader(paid.headers.get('payment-response')!);

    const looked = await fetch(`${baseUrl}/receipts/${encodeURIComponent(settle.transaction)}`);
    assert.equal(looked.status, 200);
    const receipt = await looked.json() as { transaction: string; success: boolean; railId: string };
    assert.equal(receipt.transaction, settle.transaction);
    assert.equal(receipt.success, true);
    assert.ok(receipt.railId);

    assert.equal((await fetch(`${baseUrl}/receipts/never-happened`)).status, 404);
  });
});

test('a payment issued for the cheap tier cannot buy the premium one', async () => {
  await withServer(app(), async baseUrl => {
    const { body: cheap } = await challengeFor(baseUrl, `/analyze/${POOL}`);
    const res = await fetch(`${baseUrl}/analyze/${POOL}/attested`, {
      headers: { 'PAYMENT-SIGNATURE': sign(cheap.accepts[0]!) },
    });

    // Refused, and re-challenged at the right price rather than merely rejected:
    // the buyer is told what it would cost to succeed.
    assert.equal(res.status, 402);
    const body = await res.json() as PaymentRequiredBody;
    assert.match(body.error ?? '', /below the .* quoted for this resource/);
    assert.ok(BigInt(body.accepts[0]!.amount) > BigInt(cheap.accepts[0]!.amount));
  });
});

test('the two tiers are priced differently, and the premium one buys more', async () => {
  const analyst = fakeAnalyst();
  await withServer(createApp({ registry: testRegistry(), analyst }), async baseUrl => {
    const { body: premium } = await challengeFor(baseUrl, `/analyze/${POOL}/attested`);
    const { body: standard } = await challengeFor(baseUrl, `/analyze/${POOL}`);
    assert.ok(BigInt(premium.accepts[0]!.amount) > BigInt(standard.accepts[0]!.amount));
    assert.equal(premium.extensions?.['turnstileTier'], 'premium');
    assert.equal(standard.extensions?.['turnstileTier'], 'standard');

    const res = await fetch(`${baseUrl}/analyze/${POOL}/attested`, {
      headers: { 'PAYMENT-SIGNATURE': sign(premium.accepts[0]!) },
    });
    assert.equal(res.status, 200);
    const payload = await res.json() as { tier: string; analystInput?: { pool: unknown; now: number }; attestation: { status: string } };
    assert.equal(payload.tier, 'premium');

    // The premium tier's actual deliverable, and the MOV-227 seam: the exact
    // argument `assess()` was called with, so the buyer can re-derive the verdict.
    assert.ok(payload.analystInput, 'premium tier must return the AnalystInput');
    assert.ok(payload.analystInput.pool);
    assert.equal(typeof payload.analystInput.now, 'number');
    assert.equal(payload.attestation.status, 'unattested');

    // Two unpaid challenges preceded this and the analyst was not called for
    // either: no work happens before payment, so an unpaid request costs the
    // seller an ENS-priced quote and nothing else.
    assert.equal(analyst.calls.length, 1);

    // The price difference has to buy something. It buys the live quote.
    assert.deepEqual(analyst.calls.map(c => c.liveDepth), [true]);

    const cheap = await fetch(`${baseUrl}/analyze/${POOL}`, {
      headers: { 'PAYMENT-SIGNATURE': sign(standard.accepts[0]!) },
    });
    assert.equal(cheap.status, 200);
    assert.deepEqual(analyst.calls.map(c => c.liveDepth), [true, false]);

    // And the cheap tier does not leak the premium tier's deliverable.
    const cheapBody = await cheap.json() as Record<string, unknown>;
    assert.equal(cheapBody['analystInput'], undefined);
  });
});

test('the standard tier is priced at the turnstile:price record, and neither tier exceeds the ceiling', async () => {
  // 0.07 and 0.50 were read off liquidity.turnstile.eth on Sepolia, 2026-09-07.
  // Discovery reports that record as an exact price, so a service charging
  // something else would make the discovery layer a liar.
  assert.equal(TIERS.standard.priceUsd, 0.07);
  assert.ok(TIERS.premium.priceUsd <= 0.5);

  await withServer(app(), async baseUrl => {
    const { body } = await challengeFor(baseUrl, `/analyze/${POOL}`);
    // 0.07 USD at 6 decimals. Pinned as an integer because 0.07 * 1e6 in
    // floating point is 69999.99999999999.
    assert.equal(body.accepts[0]!.amount, '70000');
  });
});

test('a malformed or missing signature is re-challenged rather than crashing', async () => {
  await withServer(app(), async baseUrl => {
    const garbage = await fetch(`${baseUrl}/analyze/${POOL}`, { headers: { 'PAYMENT-SIGNATURE': 'not-base64-json' } });
    assert.equal(garbage.status, 402);
    assert.match((await garbage.json() as PaymentRequiredBody).error ?? '', /could not be decoded/);

    const { body: challenge } = await challengeFor(baseUrl, `/analyze/${POOL}`);
    const unsigned: PaymentPayload = { x402Version: 2, accepted: challenge.accepts[0]!, payload: {} };
    const res = await fetch(`${baseUrl}/analyze/${POOL}`, {
      headers: { 'PAYMENT-SIGNATURE': encodePaymentSignatureHeader(unsigned as never) },
    });
    assert.equal(res.status, 402);
    assert.match((await res.json() as PaymentRequiredBody).error ?? '', /invalid_signature/);
  });
});

test('a payment naming a rail this seller does not run is refused', async () => {
  await withServer(app(), async baseUrl => {
    const { body: challenge } = await challengeFor(baseUrl, `/analyze/${POOL}`);
    const foreign = { ...challenge.accepts[0]!, network: 'somechain:999' };
    const res = await fetch(`${baseUrl}/analyze/${POOL}`, { headers: { 'PAYMENT-SIGNATURE': sign(foreign) } });
    assert.equal(res.status, 402);
    assert.match((await res.json() as PaymentRequiredBody).error ?? '', /not offered for this resource/);
  });
});

test('a payer diverting the payout to their own account is refused', async () => {
  await withServer(app(), async baseUrl => {
    const { body: challenge } = await challengeFor(baseUrl, `/analyze/${POOL}`);
    const diverted = { ...challenge.accepts[0]!, payTo: 'attacker-account' };
    const res = await fetch(`${baseUrl}/analyze/${POOL}`, { headers: { 'PAYMENT-SIGNATURE': sign(diverted) } });
    assert.equal(res.status, 402);
    assert.match((await res.json() as PaymentRequiredBody).error ?? '', /payTo does not match|not offered/);
  });
});

test('health says which rails settle for real, and does not overstate', async () => {
  await withServer(app(), async baseUrl => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const body = await res.json() as {
      settlementLive: boolean;
      rails: { id: string; live: boolean }[];
      tiers: { id: string; priceUsd: number }[];
    };
    assert.equal(body.rails.length, 2);
    assert.equal(body.tiers.length, 2);
    // Every rail here is a stub, so the service must say settlement is not live.
    assert.equal(body.settlementLive, false);
    assert.ok(body.rails.every(rail => rail.live === false));
  });
});

test('a bad pool address is rejected before any payment is taken', async () => {
  await withServer(app(), async baseUrl => {
    const { body: challenge } = await challengeFor(baseUrl, '/analyze/not-a-pool');
    const res = await fetch(`${baseUrl}/analyze/not-a-pool`, {
      headers: { 'PAYMENT-SIGNATURE': sign(challenge.accepts[0]!) },
    });
    assert.equal(res.status, 400);
    // No settlement happened, so no receipt was issued.
    assert.equal(res.headers.get('payment-response'), null);
  });
});
