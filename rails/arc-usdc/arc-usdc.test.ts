// The Arc rail, offline. Every fixture it runs against was captured from the
// real Circle Gateway on 2026-09-07 — see `./testing.ts`.
//
// What these tests are for is the half of the rail that a live payment does
// *not* exercise: the refusals. A successful payment proves the happy path and
// nothing else, and the happy path is the one that gets attention. The replay
// guard, the reason-code mapping and the "credited but not yet mined" window are
// each a place where being wrong is expensive and invisible.

import test from 'node:test';
import assert from 'node:assert/strict';

import { PaymentRailError } from '../PaymentRail.ts';
import type { PaymentPayload, PaymentRequirement } from '../PaymentRail.ts';
import { GATEWAY_WALLET, NETWORK, USDC_ASSET, isAuthorizationId, isBatchTransactionHash } from './config.ts';
import { toVerifyFailureReason } from './gateway.ts';
import { createArcRail } from './index.ts';
import { formatUsdc, sameBalance } from './wallet.ts';
import {
  PENDING_TRANSFER, SAMPLE_AUTHORIZATION_ID, SAMPLE_BATCH_TX, SETTLED_TRANSFER,
  fakeGateway, offlineRailOptions,
} from './testing.ts';

const RESOURCE = 'https://seller.example/analyze/0xpool';
const PAY_TO = '0x0Adca6e14bA956201D221feC767e4f24194bf5F2';
const PAYER = '0x0633a193017939Bb1eB242982397224c66948e2F';

function railWith(options: Parameters<typeof fakeGateway>[0] = {}) {
  const gateway = fakeGateway(options);
  return { rail: createArcRail(offlineRailOptions(gateway)), gateway };
}

/** A payer's payload for a requirement, with a distinct nonce per call. */
let nonceCounter = 0;
function signed(requirement: PaymentRequirement, over: Partial<{ nonce: string; value: string; from: string }> = {}): PaymentPayload {
  nonceCounter += 1;
  return {
    x402Version: 2,
    accepted: requirement,
    payload: {
      signature: `0x${'ab'.repeat(65)}`,
      authorization: {
        from: over.from ?? PAYER,
        to: requirement.payTo,
        value: over.value ?? requirement.amount,
        validAfter: '1788798841',
        validBefore: '1789404341',
        nonce: over.nonce ?? `0x${String(nonceCounter).padStart(64, '0')}`,
      },
    },
  };
}

test('a challenge carries the EIP-712 domain, read from the facilitator rather than hardcoded', async () => {
  // The payer cannot sign without `name`, `version` and `verifyingContract`, and
  // the verifying contract is the **GatewayWallet, not USDC** — that substitution
  // is the whole of Circle's batching scheme. Reading it off `/supported` rather
  // than restating it means a redeploy on Circle's side propagates without a
  // code change here.
  const { rail, gateway } = railWith();
  const requirement = await rail.challenge({ resource: RESOURCE, description: 'x', priceUsd: 0.07 });

  assert.equal(requirement.scheme, 'exact');
  assert.equal(requirement.network, NETWORK);
  assert.equal(requirement.asset, USDC_ASSET);
  assert.equal(requirement.payTo, PAY_TO);
  // 0.07 * 1e6 is 69999.99999999999 in IEEE 754; a payment one unit light is
  // rejected by Gateway with `amount_mismatch`.
  assert.equal(requirement.amount, '70000');

  assert.equal(requirement.extra['name'], 'GatewayWalletBatched');
  assert.equal(requirement.extra['version'], '1');
  assert.equal(requirement.extra['verifyingContract'], GATEWAY_WALLET);
  assert.notEqual(requirement.extra['verifyingContract'], USDC_ASSET);

  // It really asked, rather than answering from a constant.
  assert.ok(gateway.calls.some(c => c.method === 'getSupported'));

  // And it says on the wire that the hash arrives late, so a payer knows before
  // signing rather than after.
  assert.equal(requirement.extra['settlementTiming'], 'batched-asynchronous');
  assert.equal(requirement.extra['turnstileSettlement'], 'live');
});

test('a challenge names the chain both ways, because Circle and x402 disagree', async () => {
  // The failure this exists to prevent: `GatewayClient({ chain: 'eip155:5042002' })`
  // throws, and a challenge quoting `arcTestnet` as its network matches no
  // supported kind. Both names are correct in their own place, so both travel.
  const { rail } = railWith();
  const requirement = await rail.challenge({ resource: RESOURCE, description: 'x', priceUsd: 0.07 });
  assert.equal(requirement.network, 'eip155:5042002');
  assert.equal(requirement.extra['chainName'], 'arcTestnet');
  assert.equal(requirement.extra['chainDomain'], 26);
});

test('a challenge fails loudly when the facilitator cannot support it', async () => {
  // Better a 503 at the seller than a quote nobody can pay. Each of these is a
  // real way Gateway could change under us.
  const dropped = railWith({ withoutArc: true }).rail;
  await assert.rejects(
    () => dropped.challenge({ resource: RESOURCE, description: 'x', priceUsd: 0.07 }),
    (e: unknown) => e instanceof PaymentRailError && e.reason === 'unsupported_rail',
  );

  // Advertised, but without the one field a payer needs to build a signature.
  const undomained = railWith({ withoutVerifyingContract: true }).rail;
  await assert.rejects(
    () => undomained.challenge({ resource: RESOURCE, description: 'x', priceUsd: 0.07 }),
    (e: unknown) => e instanceof PaymentRailError && e.reason === 'facilitator_unavailable',
  );

  const offline = railWith({ unreachable: true }).rail;
  await assert.rejects(
    () => offline.challenge({ resource: RESOURCE, description: 'x', priceUsd: 0.07 }),
    (e: unknown) => e instanceof PaymentRailError && e.reason === 'facilitator_unavailable',
  );
});

test('verify refuses a malformed authorization before asking Gateway anything', async () => {
  const { rail, gateway } = railWith();
  const requirement = await rail.challenge({ resource: RESOURCE, description: 'x', priceUsd: 0.07 });

  for (const bad of [{}, { signature: 'x' }, { authorization: { from: PAYER } }, { signature: '', authorization: {} }]) {
    const result = await rail.verify({ x402Version: 2, accepted: requirement, payload: bad as Record<string, unknown> });
    assert.equal(result.valid, false);
    // Not a bare `false`: the buyer's next move differs between a bad signature
    // and a wrong chain, and this is the boundary where that is still knowable.
    assert.equal(result.reason, 'invalid_signature');
  }
  assert.equal(gateway.calls.filter(c => c.method === 'verify').length, 0);
});

test('verify refuses a payment diverted to another payout account', async () => {
  const { rail } = railWith();
  const requirement = await rail.challenge({ resource: RESOURCE, description: 'x', priceUsd: 0.07 });
  const result = await rail.verify(signed({ ...requirement, payTo: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }));
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'wrong_recipient');
});

test('one authorization buys exactly one answer', async () => {
  // The replay guard, keyed on the EIP-3009 nonce. Gateway would itself reject a
  // reused nonce — but only after the seller had done the work and handed over
  // the answer, which is too late to matter.
  const { rail } = railWith();
  const requirement = await rail.challenge({ resource: RESOURCE, description: 'x', priceUsd: 0.07 });
  const payment = signed(requirement);

  assert.equal((await rail.verify(payment)).valid, true);
  const receipt = await rail.settle(payment);
  assert.equal(receipt.success, true);

  const replayed = await rail.verify(payment);
  assert.equal(replayed.valid, false);
  assert.equal(replayed.reason, 'already_settled');

  // Re-serialising the same authorization differently must not slip past: the
  // guard keys on the nonce, which is what the signature commits to, not on the
  // bytes of the payload.
  const reserialized: PaymentPayload = {
    ...payment,
    payload: { ...payment.payload, signature: `0x${'cd'.repeat(65)}` },
  };
  const sneaky = await rail.verify(reserialized);
  assert.equal(sneaky.valid, false);
  assert.equal(sneaky.reason, 'already_settled');

  // A different nonce is a different payment and is allowed through.
  assert.equal((await rail.verify(signed(requirement))).valid, true);
});

test('verify attaches the resource Gateway requires, and prefers the one being bought', async () => {
  // Omitting it is an HTTP 400 (`paymentPayload.resource: Required`), not a
  // payment rejection — verified against the live API on 2026-09-07. So the rail
  // has to synthesize it, and this pins that it does.
  const { rail, gateway } = railWith();
  const requirement = await rail.challenge({ resource: RESOURCE, description: 'x', priceUsd: 0.07 });
  await rail.verify(signed(requirement), { resource: RESOURCE, offered: [requirement] });

  const sent = gateway.calls.find(c => c.method === 'verify')!.payload as { resource?: { url: string } };
  assert.equal(sent.resource?.url, RESOURCE);
});

test('a challenge issued for one resource does not buy another', async () => {
  // Advisory rather than a security boundary, and the difference is worth
  // knowing: the EIP-3009 authorization commits to (from, to, value, validAfter,
  // validBefore, nonce) and to no URL at all, so a payer can edit
  // `extra.resource` in their own copy and this check will not notice. It stays
  // because it catches an honest client pointed at the wrong URL. The
  // tier-downgrade attack is blocked by the amount comparison in
  // `seller/service/x402.ts`, which is why that check lives there.
  const { rail } = railWith();
  const requirement = await rail.challenge({ resource: RESOURCE, description: 'x', priceUsd: 0.07 });
  const result = await rail.verify(signed(requirement), { resource: 'https://seller.example/analyze/0xother', offered: [requirement] });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'wrong_recipient');
});

test('a Gateway rejection becomes a code the buyer can act on', async () => {
  const { rail } = railWith({ verify: { isValid: false, invalidReason: 'amount_mismatch', payer: PAYER } });
  const requirement = await rail.challenge({ resource: RESOURCE, description: 'x', priceUsd: 0.07 });
  const result = await rail.verify(signed(requirement));
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'wrong_amount');
  assert.equal(result.payer, PAYER);
});

test('the reason table maps the codes Gateway really returns', () => {
  // `amount_mismatch` and `insufficient_balance` are quoted from live responses
  // captured on 2026-09-07. The rest are defensive; anything unrecognised must
  // become `unknown` rather than being forced into a neighbouring bucket,
  // because a buyer that retries on a misclassified code wastes a payment.
  assert.equal(toVerifyFailureReason('amount_mismatch'), 'wrong_amount');
  assert.equal(toVerifyFailureReason('insufficient_balance'), 'insufficient_funds');
  assert.equal(toVerifyFailureReason('invalid_signature'), 'invalid_signature');
  assert.equal(toVerifyFailureReason('unsupported_network'), 'unsupported_rail');
  assert.equal(toVerifyFailureReason('nonce_already_used'), 'already_settled');
  assert.equal(toVerifyFailureReason('authorization_expired'), 'expired');
  assert.equal(toVerifyFailureReason('something_new_from_circle'), 'unknown');
  assert.equal(toVerifyFailureReason(undefined), 'unknown');
});

test('an unreachable Gateway is a 503, not a rejected payment', async () => {
  // The distinction the service turns into two different HTTP statuses, because
  // they tell the buyer to do different things: retry later, or stop.
  const { rail } = railWith();
  const requirement = await rail.challenge({ resource: RESOURCE, description: 'x', priceUsd: 0.07 });

  const broken = railWith({ unreachable: true }).rail;
  await assert.rejects(
    () => broken.verify(signed(requirement)),
    (e: unknown) => e instanceof PaymentRailError && e.reason === 'facilitator_unavailable',
  );
});

test('settle returns an authorization id and no transaction hash yet', async () => {
  // The asynchronous-settlement contract, and the thing most likely to be
  // mis-read by someone porting this from an on-chain rail: `transaction` here
  // is a **UUID**, and `extra.batchTransaction` is null until Circle's batcher
  // mines it minutes later. A caller treating `transaction` as a hash builds a
  // broken explorer link.
  const { rail, gateway } = railWith();
  const requirement = await rail.challenge({ resource: RESOURCE, description: 'x', priceUsd: 0.07 });
  const payment = signed(requirement);
  const receipt = await rail.settle(payment);

  assert.equal(receipt.success, true);
  assert.equal(receipt.transaction, SAMPLE_AUTHORIZATION_ID);
  assert.ok(isAuthorizationId(receipt.transaction));
  assert.ok(!isBatchTransactionHash(receipt.transaction));
  assert.equal(receipt.extra!['batchTransaction'], null);
  assert.equal(receipt.extra!['batchSettled'], false);
  assert.equal(receipt.amount, '70000');

  // It settles the payer's chosen entry, not a freshly issued one — the two can
  // differ, and Gateway compares the payload against what it is sent.
  const sent = gateway.calls.find(c => c.method === 'settle')!.requirements as PaymentRequirement;
  assert.equal(sent.amount, payment.accepted.amount);
  assert.equal(sent.payTo, payment.accepted.payTo);
});

test('an empty wallet fails at settle, not at verify, and does not throw', async () => {
  // The asymmetry with Blocky402 that will bite whoever reads `verify()` as a
  // funds check. Gateway's /verify does not look at the balance: verified
  // 2026-09-07, an authorization from a zero-balance wallet came back
  // `{"isValid":true}` and then failed settlement with `insufficient_balance`.
  //
  // And the failure returns rather than throws, because by this point the seller
  // has already done the work: an unpaid answer is an accounting problem, not a
  // crash.
  const { rail } = railWith({
    verify: { isValid: true, payer: PAYER },
    settle: { success: false, errorReason: 'insufficient_balance', transaction: '', network: NETWORK },
  });
  const requirement = await rail.challenge({ resource: RESOURCE, description: 'x', priceUsd: 0.07 });
  const payment = signed(requirement);

  assert.equal((await rail.verify(payment)).valid, true, 'Gateway verifies an unfunded authorization');

  const receipt = await rail.settle(payment);
  assert.equal(receipt.success, false);
  assert.equal(receipt.error, 'insufficient_balance');
  assert.equal(receipt.transaction, '');

  // A failed settlement must not burn the nonce: the payer can fund the wallet
  // and present the same authorization again.
  const retry = await rail.verify(payment);
  assert.equal(retry.valid, true, 'a failed settlement must not consume the authorization');
});

test('receipt turns an authorization id into a batch transaction once it lands', async () => {
  // The point of the whole rail. `settle()` knows only a UUID; the hash exists a
  // couple of minutes later and `receipt()` is what goes and gets it.
  const { rail } = railWith();
  const requirement = await rail.challenge({ resource: RESOURCE, description: 'x', priceUsd: 0.07 });
  await rail.settle(signed(requirement));

  const resolved = await rail.receipt(SAMPLE_AUTHORIZATION_ID);
  assert.ok(resolved);
  assert.equal(resolved.extra!['batchTransaction'], SAMPLE_BATCH_TX);
  assert.equal(resolved.extra!['batchSettled'], true);
  assert.equal(resolved.extra!['status'], 'completed');
  assert.match(String(resolved.extra!['arcscan']), /testnet\.arcscan\.app\/tx\/0x36f41290/);
  assert.equal(resolved.amount, SETTLED_TRANSFER.amount);
});

test('a credited payment with no hash yet is a receipt, not a null', async () => {
  // The window between `/settle` and the batch landing is a real state: the
  // money is credited and the transaction does not exist. Reporting `null` there
  // would tell a buyer their payment had vanished.
  const { rail } = railWith({ transfer: PENDING_TRANSFER });
  const requirement = await rail.challenge({ resource: RESOURCE, description: 'x', priceUsd: 0.07 });
  await rail.settle(signed(requirement));

  const pending = await rail.receipt(SAMPLE_AUTHORIZATION_ID);
  assert.ok(pending);
  assert.equal(pending.success, true);
  assert.equal(pending.extra!['batchTransaction'], null);
  assert.equal(pending.extra!['batchSettled'], false);
  assert.equal(pending.extra!['status'], 'received');
});

test('receipt says null for a payment this rail has never seen', async () => {
  // Absence is an ordinary answer here — a buyer polling early is not an error —
  // which is why it is in the return type rather than an exception.
  const { rail } = railWith({ transfer: null });
  assert.equal(await rail.receipt('11111111-2222-3333-4444-555555555555'), null);

  // And a stub id from another rail is not looked up as though it might be real.
  const { rail: quiet, gateway } = railWith({ transfer: null });
  assert.equal(await quiet.receipt('stub:arc-usdc:000001'), null);
  assert.equal(gateway.calls.filter(c => c.method === 'fetch').length, 0);
});

test('the two identifiers this rail hands around are distinguishable by shape', () => {
  // `receipt()` is given one string and has to know which endpoint can answer
  // for it. Getting this wrong produces a 404 that reads exactly like "your
  // payment does not exist".
  assert.ok(isAuthorizationId(SAMPLE_AUTHORIZATION_ID));
  assert.ok(!isBatchTransactionHash(SAMPLE_AUTHORIZATION_ID));
  assert.ok(isBatchTransactionHash(SAMPLE_BATCH_TX));
  assert.ok(!isAuthorizationId(SAMPLE_BATCH_TX));
  assert.ok(!isAuthorizationId('stub:arc-usdc:000001'));
  assert.ok(!isBatchTransactionHash('0xnothex'));
});

test('the native and ERC-20 views of an Arc balance are one balance, truncated', () => {
  // This is the arithmetic behind the correction in `CLAUDE.md`, `README.md` and
  // `docs/architecture.md`. Pinned as a test because it is the claim those three
  // files now rest on, and "USDC is the gas token" is exactly the kind of thing
  // that gets re-asserted from memory by the next reader.
  //
  // The measured pair, from a live Arc address on 2026-09-07.
  assert.equal(sameBalance({ native: 285144556003000000n, usdc: 285144n }), true);

  // The ERC-20 view truncates rather than rounds. One nanopayment's worth, less
  // one wei: 0.000999999999999 USDC shows as 0.000999, not 0.001000. A
  // `sameBalance` written with rounding would pass the case above and fail here,
  // which is why both are present.
  assert.equal(sameBalance({ native: 999_999_999_999n, usdc: 0n }), true);
  assert.equal(sameBalance({ native: 999_999_999_999n, usdc: 1n }), false);
  assert.equal(sameBalance({ native: 1_000_000_000_000n, usdc: 1n }), true);

  // The state the zero-gas proof depends on: nothing on chain, either way.
  assert.equal(sameBalance({ native: 0n, usdc: 0n }), true);

  // And a wallet that holds native but no USDC is not a state this chain has.
  // If this ever passes, USDC has stopped being the gas token and the three
  // corrected documents need revisiting.
  assert.equal(sameBalance({ native: 5_000_000_000_000_000_000n, usdc: 0n }), false);
});

test('formatUsdc prints atomic units without going through a float', () => {
  // A nanopayment is 500 atomic units. `500 / 1e6` is fine in IEEE 754 and
  // `1308 / 1e6` is not exactly 0.001308, so this formats through integers —
  // the same reason `usdToAtomic` exists on the other side.
  assert.equal(formatUsdc(500n), '0.000500');
  assert.equal(formatUsdc('1308'), '0.001308');
  assert.equal(formatUsdc(70000n), '0.070000');
  assert.equal(formatUsdc(250000n), '0.250000');
  assert.equal(formatUsdc(0n), '0.000000');
  assert.equal(formatUsdc(1n), '0.000001');
});
