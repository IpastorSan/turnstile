// The Base rail, offline: no facilitator, no chain, every network call injected.
//
// Two things are load-bearing and neither is visible by reading the rail alone:
//
//  1. **The challenge has to satisfy a foreign client.** Bazantic's `baz curl`
//     refuses a 402 unless the entry is `exact` on a network it knows, the asset
//     is exactly that network's USDC, and `extra.name`/`extra.version` carry the
//     token's EIP-712 domain. That is a claim about someone else's parser, so it
//     is pinned here — including the amount, because `0.07 * 1e6` is
//     69999.99999999999 in IEEE 754 and the facilitator rejects a payment one
//     unit light.
//  2. **The local refusals have to happen before the facilitator round-trip.** A
//     replayed authorization is refused here, not discovered by the chain after
//     we have already handed over the answer.
//
// The facilitator's vocabulary is pinned too. Its codes come from `@x402/evm`;
// mapping an unknown one to something safe rather than to `false` is the
// difference between a buyer stopping and a buyer paying twice.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PaymentPayload, PaymentRequirement } from '../PaymentRail.ts';
import { createBaseMainnetRail, createBaseRail } from './index.ts';
import { toVerifyFailureReason } from './facilitator.ts';

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const PAYOUT = '0x0Adca6e14bA956201D221feC767e4f24194bf5F2';
const RESOURCE = 'https://turnstile.moveseventyeight.com/analyze/0xabc';

const SUPPORTED = {
  kinds: [
    { x402Version: 2, scheme: 'exact', network: 'eip155:84532' },
    { x402Version: 2, scheme: 'exact', network: 'eip155:8453' },
  ],
};

interface FakeOptions {
  supported?: unknown;
  supportedStatus?: number;
  verify?: unknown;
  settle?: unknown;
  /** Fail /supported at the transport level, as an unreachable host does. */
  supportedUnreachable?: boolean;
}

/** A fetch that answers the three facilitator endpoints and records the calls. */
function fakeFacilitator(options: FakeOptions = {}) {
  const calls: { url: string; body?: unknown }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    if (url.endsWith('/supported')) {
      if (options.supportedUnreachable) throw new Error('ENOTFOUND');
      const status = options.supportedStatus ?? 200;
      return new Response(JSON.stringify(options.supported ?? SUPPORTED), { status });
    }
    if (url.endsWith('/verify')) return new Response(JSON.stringify(options.verify ?? { isValid: true, payer: '0xpayer' }));
    if (url.endsWith('/settle')) return new Response(JSON.stringify(options.settle ?? { success: true, transaction: `0x${'ab'.repeat(32)}`, network: 'eip155:84532', payer: '0xpayer' }));
    return new Response('not found', { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

function railWith(options: FakeOptions = {}) {
  const fake = fakeFacilitator(options);
  const rail = createBaseRail({ payTo: PAYOUT, facilitatorOptions: { fetch: fake.fetchImpl } });
  return { rail, ...fake };
}

/** A well-formed EIP-3009 payload against a given requirement. */
function paymentFor(requirement: PaymentRequirement, over: Partial<{ to: string; from: string; nonce: string; resource: string }> = {}): PaymentPayload {
  return {
    x402Version: 2,
    accepted: {
      ...requirement,
      extra: { ...requirement.extra, resource: over.resource ?? requirement.extra['resource'] },
    },
    payload: {
      signature: `0x${'cd'.repeat(65)}`,
      authorization: {
        from: over.from ?? '0x1111111111111111111111111111111111111111',
        to: over.to ?? PAYOUT,
        value: requirement.amount,
        validAfter: '0',
        validBefore: String(Math.floor(Date.now() / 1000) + 300),
        nonce: over.nonce ?? `0x${'ef'.repeat(32)}`,
      },
    },
  };
}

test('the challenge is the shape a foreign x402 client requires', async () => {
  const { rail } = railWith();
  const challenge = await rail.challenge({ resource: RESOURCE, description: 'a verdict', priceUsd: 0.07 });

  assert.equal(challenge.scheme, 'exact');
  assert.equal(challenge.network, 'eip155:84532');
  assert.equal(challenge.asset, USDC, 'the asset must be that network USDC exactly: a client checks it');
  assert.equal(challenge.payTo, PAYOUT);
  assert.equal(challenge.amount, '70000', '0.07 in USDC base units — float math gives 69999.99999999999');
  assert.equal(challenge.extra['name'], 'USDC', 'EIP-712 domain name, or the client refuses the challenge');
  assert.equal(challenge.extra['version'], '2', 'EIP-712 domain version, checked by the facilitator against the token');
  assert.equal(challenge.extra['decimals'], 6);
  assert.equal(challenge.extra['turnstileSettlement'], 'live');
});

test('the challenge fails loudly when the facilitator does not settle this network', async () => {
  const fake = fakeFacilitator({ supported: { kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453' }] } });
  const rail = createBaseRail({ payTo: PAYOUT, facilitatorOptions: { fetch: fake.fetchImpl } });
  await assert.rejects(
    () => rail.challenge({ resource: RESOURCE, description: 'x', priceUsd: 0.07 }),
    /does not settle exact on eip155:84532/,
  );
});

test('an unreachable facilitator is a 503, not a quote', async () => {
  const fake = fakeFacilitator({ supportedUnreachable: true });
  const rail = createBaseRail({ payTo: PAYOUT, facilitatorOptions: { fetch: fake.fetchImpl } });
  await assert.rejects(
    () => rail.challenge({ resource: RESOURCE, description: 'x', priceUsd: 0.07 }),
    /could not read .*\/supported/,
  );
});

test('a replayed authorization is refused before the facilitator is asked', async () => {
  const { rail, calls } = railWith();
  const requirement = await rail.challenge({ resource: RESOURCE, description: 'x', priceUsd: 0.07 });
  const payment = paymentFor(requirement);

  const first = await rail.verify(payment, { resource: RESOURCE, offered: [requirement] });
  assert.equal(first.valid, true);

  // Settle it, which is what spends the nonce.
  const receipt = await rail.settle(payment);
  assert.equal(receipt.success, true);

  const callsBefore = calls.filter(c => c.url.endsWith('/verify')).length;
  const replay = await rail.verify(payment, { resource: RESOURCE, offered: [requirement] });
  assert.equal(replay.valid, false);
  assert.equal(replay.reason, 'already_settled');
  assert.equal(calls.filter(c => c.url.endsWith('/verify')).length, callsBefore, 'a replay must cost zero upstream calls');
});

test('a payment addressed to somebody else is refused', async () => {
  const { rail } = railWith();
  const requirement = await rail.challenge({ resource: RESOURCE, description: 'x', priceUsd: 0.07 });
  const wrong = paymentFor(requirement, { to: '0x2222222222222222222222222222222222222222' });
  const result = await rail.verify(wrong, { resource: RESOURCE, offered: [requirement] });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'wrong_recipient');
});

test('a payment issued for another URL is refused', async () => {
  const { rail } = railWith();
  const requirement = await rail.challenge({ resource: RESOURCE, description: 'x', priceUsd: 0.07 });
  const payment = paymentFor(requirement, { resource: 'https://elsewhere.example/analyze/0xabc' });
  const result = await rail.verify(payment, { resource: RESOURCE, offered: [requirement] });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'wrong_recipient');
});

test('a malformed payload is an invalid signature, not a crash', async () => {
  const { rail } = railWith();
  const requirement = await rail.challenge({ resource: RESOURCE, description: 'x', priceUsd: 0.07 });
  const result = await rail.verify({ x402Version: 2, accepted: requirement, payload: {} }, { resource: RESOURCE, offered: [requirement] });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'invalid_signature');
});

test('facilitator verdicts map to the codes a buyer branches on', () => {
  assert.equal(toVerifyFailureReason('invalid_exact_evm_signature'), 'invalid_signature');
  assert.equal(toVerifyFailureReason('invalid_exact_evm_insufficient_balance'), 'insufficient_funds');
  assert.equal(toVerifyFailureReason('invalid_exact_evm_payload_authorization_value_mismatch'), 'wrong_amount');
  assert.equal(toVerifyFailureReason('invalid_exact_evm_recipient_mismatch'), 'wrong_recipient');
  assert.equal(toVerifyFailureReason('invalid_exact_evm_nonce_already_used'), 'already_settled');
  assert.equal(toVerifyFailureReason('invalid_exact_evm_payload_authorization_valid_before'), 'expired');
  assert.equal(toVerifyFailureReason('invalid_exact_evm_network_mismatch'), 'unsupported_rail');
  assert.equal(toVerifyFailureReason('invalid_exact_evm_token_version_mismatch'), 'unsupported_rail');
  // Unrecognised stays unrecognised: forcing it into a neighbour would make a
  // buyer retry something that cannot succeed.
  assert.equal(toVerifyFailureReason('something_new_from_a_future_facilitator'), 'unknown');
});

test('a facilitator verdict surfaces with its reason and payer', async () => {
  const { rail } = railWith({ verify: { isValid: false, invalidReason: 'invalid_exact_evm_signature', invalidMessage: 'bad sig', payer: '0xpayer' } });
  const requirement = await rail.challenge({ resource: RESOURCE, description: 'x', priceUsd: 0.07 });
  const result = await rail.verify(paymentFor(requirement), { resource: RESOURCE, offered: [requirement] });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'invalid_signature');
  assert.equal(result.payer, '0xpayer');
});

test('settlement failure returns a receipt rather than throwing', async () => {
  const { rail } = railWith({ settle: { success: false, transaction: '', network: 'eip155:84532', errorReason: 'invalid_exact_evm_transaction_failed' } });
  const requirement = await rail.challenge({ resource: RESOURCE, description: 'x', priceUsd: 0.07 });
  const receipt = await rail.settle(paymentFor(requirement));
  assert.equal(receipt.success, false);
  assert.match(String(receipt.error), /invalid_exact_evm_transaction_failed/);
});

test('a settled payment carries a transaction and an explorer link', async () => {
  const { rail } = railWith();
  const requirement = await rail.challenge({ resource: RESOURCE, description: 'x', priceUsd: 0.07 });
  const receipt = await rail.settle(paymentFor(requirement));
  assert.equal(receipt.success, true);
  assert.equal(receipt.railId, 'base-usdc');
  assert.equal(receipt.amount, '70000');
  assert.match(String(receipt.extra?.['basescan']), /^https:\/\/sepolia\.basescan\.org\/tx\/0x[0-9a-f]{64}$/);
});

test('receipt() reads a settled transfer back off the chain, and refuses anything else', async () => {
  const hash = `0x${'11'.repeat(32)}`;
  const paddedTo = PAYOUT.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const paddedFrom = '0'.repeat(24) + '1'.repeat(40);
  const rpcFetch = (async () =>
    new Response(
      JSON.stringify({
        result: {
          status: '0x1',
          logs: [
            // A log from another contract, to prove the token address is checked.
            { address: '0x9999999999999999999999999999999999999999', topics: [`0xddf252ad`, `0x${paddedFrom}`, `0x${paddedTo}`], data: '0x' },
            {
              address: USDC,
              topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', `0x${paddedFrom}`, `0x${paddedTo}`],
              data: '0x11170', // 70000
            },
          ],
        },
      }),
      { status: 200 },
    )) as unknown as typeof globalThis.fetch;

  const rail = createBaseRail({ payTo: PAYOUT, rpcFetch });
  const receipt = await rail.receipt(hash);
  assert.ok(receipt, 'a real USDC transfer to us must resolve');
  assert.equal(receipt.success, true);
  assert.equal(receipt.amount, '70000');
  assert.equal(receipt.payer, `0x${'1'.repeat(40)}`);

  // A stub id, a hash with no transfer to us, and a nonsense string are all
  // ordinary nulls — never a fabricated receipt.
  assert.equal(await rail.receipt('stub:base-usdc:000001'), null);
  const empty = createBaseRail({ payTo: PAYOUT, rpcFetch: (async () => new Response(JSON.stringify({ result: { status: '0x1', logs: [] } }), { status: 200 })) as unknown as typeof globalThis.fetch });
  assert.equal(await empty.receipt(hash), null);
});

// ---------------------------------------------------------------------------
// The mainnet instance — same implementation, the other chain
//
// What is pinned here is the part that is silently wrong when it is wrong: the
// EIP-712 domain. Circle's mainnet token is named "USD Coin" and the testnet one
// "USDC", and a payment signed against the wrong name is refused by the
// facilitator only after the payer has signed it. The rest — network, asset,
// explorer — is a constant that a reader could check by eye, but a test is
// cheaper than an eye.

const MAINNET_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

function mainnetRail(options: FakeOptions = {}) {
  const fake = fakeFacilitator({
    supported: { kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453' }] },
    ...options,
  });
  const rail = createBaseMainnetRail({ payTo: PAYOUT, facilitatorOptions: { fetch: fake.fetchImpl } });
  return { rail, ...fake };
}

test('the mainnet challenge carries mainnet USDC and its own EIP-712 name', async () => {
  const { rail } = mainnetRail();
  const challenge = await rail.challenge({ resource: RESOURCE, description: 'x', priceUsd: 0.07 });
  assert.equal(rail.info.id, 'base-usdc-mainnet');
  assert.match(rail.info.label, /^Base USDC/, 'the label must not say Sepolia on a mainnet rail');
  assert.equal(challenge.network, 'eip155:8453');
  assert.equal(challenge.asset, MAINNET_USDC);
  assert.equal(challenge.extra['name'], 'USD Coin', 'mainnet USDC is named "USD Coin"; testnet is "USDC"');
  assert.equal(challenge.extra['version'], '2');
  assert.equal(challenge.extra['chainId'], 8453);
  assert.equal(challenge.amount, '70000');
});

test('a mainnet settlement links to basescan.org, never the testnet explorer', async () => {
  const { rail } = mainnetRail();
  const requirement = await rail.challenge({ resource: RESOURCE, description: 'x', priceUsd: 0.07 });
  const receipt = await rail.settle(paymentFor(requirement));
  assert.equal(receipt.success, true);
  assert.match(String(receipt.extra?.['basescan']), /^https:\/\/basescan\.org\/tx\//);
  assert.doesNotMatch(String(receipt.extra?.['basescan']), /sepolia/);
});

test('the two instances declare different rails, which is what lets both be registered', async () => {
  const { rail: testnet } = railWith();
  const { rail: mainnet } = mainnetRail();
  assert.notEqual(testnet.info.id, mainnet.info.id);
  assert.notEqual(testnet.info.network, mainnet.info.network);
  // Same seller payout address: two chains, one seller.
  const a = await testnet.challenge({ resource: RESOURCE, description: 'x', priceUsd: 0.07 });
  const b = await mainnet.challenge({ resource: RESOURCE, description: 'x', priceUsd: 0.07 });
  assert.equal(a.payTo, b.payTo);
});
