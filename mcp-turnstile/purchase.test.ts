// `purchase` is the tool that spends money, so what is tested here is mostly
// what it REFUSES to do, and whether it says why in terms a calling agent can
// act on. Every case runs with an injected fetch and a stub signer: no network,
// no facilitator, no funded key.

import test from 'node:test';
import assert from 'node:assert/strict';

import { encodePaymentRequiredHeader } from '@x402/core/http';

import { createStubSigner } from '../buyer/watchdog/stub-signer.ts';
import { explorerUrl, purchase, readChallenge } from './purchase.ts';

const signer = createStubSigner({ railId: 'test-rail', scheme: 'exact', network: 'testns:one', payer: 'buyer-1' });

const requirement = (over: Record<string, unknown> = {}) => ({
  scheme: 'exact', network: 'testns:one', asset: 'tusd', amount: '70000',
  payTo: 'seller-1', maxTimeoutSeconds: 300, extra: {}, ...over,
});

const challenge = (accepts: unknown[] = [requirement()]) =>
  JSON.stringify({ x402Version: 2, error: 'Payment required', accepts });

/**
 * The PAYMENT-SIGNATURE header, from wherever the client put it.
 *
 * `@x402/fetch` re-issues the request as a `Request` object rather than as
 * `(url, init)`, so a fixture that only looked at `init.headers` would see no
 * payment and 402 forever — a test failure that looks exactly like a broken
 * payment path and is not one.
 */
function paymentHeader(input: RequestInfo | URL, init?: RequestInit): string | null {
  const fromInit = new Headers(init?.headers).get('PAYMENT-SIGNATURE');
  if (fromInit) return fromInit;
  return input instanceof Request ? input.headers.get('PAYMENT-SIGNATURE') : null;
}

/** A seller that 402s once and then pays out, without the SDK in the way. */
function sellerFetch(options: {
  accepts?: unknown[];
  paidStatus?: number;
  paidBody?: unknown;
  paymentResponse?: string;
} = {}): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!paymentHeader(input, init)) {
      return new Response(challenge(options.accepts), { status: 402, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify(options.paidBody ?? { ok: true }), {
      status: options.paidStatus ?? 200,
      headers: {
        'content-type': 'application/json',
        ...(options.paymentResponse ? { 'PAYMENT-RESPONSE': options.paymentResponse } : {}),
      },
    });
  }) as typeof globalThis.fetch;
}

test('a challenge is read from the header, and from the body when there is none', () => {
  assert.equal(readChallenge(null, challenge())?.from, 'body');
  assert.equal(readChallenge(null, 'not json'), null);
  // A malformed header does not stop a perfectly good body being used.
  assert.equal(readChallenge('!!!not base64!!!', challenge())?.from, 'body');
});

test('an explorer link is omitted rather than guessed', () => {
  assert.equal(explorerUrl('hedera:testnet', '0.0.1@2.3'), 'https://hashscan.io/testnet/transaction/0.0.1@2.3');
  assert.equal(explorerUrl('some:chain-we-do-not-know', '0xabc'), null);
});

test('an endpoint that serves without asking for money is `free`, not an error', async () => {
  const result = await purchase({
    resource: 'https://open.example/x', maxPriceUsd: 1, signers: [signer],
    fetch: (async () => new Response(JSON.stringify({ data: 1 }), { status: 200 })) as typeof globalThis.fetch,
  });
  assert.equal(result.status, 'free');
  assert.deepEqual(result.answer, { data: 1 });
});

test('a 402 in some other protocol is unpayable rather than crashing', async () => {
  const result = await purchase({
    resource: 'https://weird.example/x', maxPriceUsd: 1, signers: [signer],
    fetch: (async () => new Response('pay me somehow', { status: 402 })) as typeof globalThis.fetch,
  });
  assert.equal(result.status, 'unpayable');
  assert.match(result.summary, /carried no x402 accepts/);
});

test('a price over the cap is refused, with the arithmetic shown', async () => {
  const result = await purchase({
    resource: 'https://pricey.example/x', maxPriceUsd: 0.05, signers: [signer],
    fetch: sellerFetch(),
  });
  assert.equal(result.status, 'refused');
  assert.equal(result.decision?.chosen, null);
  assert.match(result.decision!.rejected[0]!.reason, /exceeds the mandate cap/);
});

test('a rail outside the mandate is refused even when the price fits', async () => {
  const result = await purchase({
    resource: 'https://x.example/x', maxPriceUsd: 10, rails: ['some-other-rail'], signers: [signer],
    fetch: sellerFetch(),
  });
  assert.equal(result.status, 'refused');
  assert.match(result.decision!.rejected[0]!.reason, /not in the mandate/);
});

test('an offer on a rail we cannot sign for is refused, and says which', async () => {
  const result = await purchase({
    resource: 'https://x.example/x', maxPriceUsd: 10, signers: [signer],
    fetch: sellerFetch({ accepts: [requirement({ network: 'testns:elsewhere' })] }),
  });
  assert.equal(result.status, 'refused');
  assert.match(result.decision!.rejected[0]!.reason, /no signer for exact on testns:elsewhere/);
});

test('dryRun applies the real mandate to the real quote and signs nothing', async () => {
  let paidRequests = 0;
  const watcher: typeof globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (paymentHeader(input, init)) paidRequests += 1;
    return sellerFetch()(input, init);
  }) as typeof globalThis.fetch;

  const result = await purchase({
    resource: 'https://x.example/x', maxPriceUsd: 1, dryRun: true, signers: [signer], fetch: watcher,
  });
  assert.equal(result.status, 'would_purchase');
  assert.equal(result.decision?.costUsd, 0.07);
  assert.equal(paidRequests, 0, 'a dry run must not send a payment');
  assert.equal(result.settlement, null);
});

test('with no signer at all the quote still comes back, labelled', async () => {
  const result = await purchase({
    resource: 'https://x.example/x', maxPriceUsd: 1, signers: [],
    fetch: sellerFetch({ accepts: [requirement({ extra: { priceUsd: 0.07 } })] }),
  });
  assert.equal(result.status, 'no_signer');
  assert.equal(result.accepts.length, 1, 'the real quote is reported without a wallet');
  assert.match(result.summary, /the seller's own arithmetic/);
});

test('a stub rail advertised as settling nothing is passed through as a warning', async () => {
  const result = await purchase({
    resource: 'https://x.example/x', maxPriceUsd: 1, signers: [signer],
    fetch: sellerFetch({ accepts: [requirement({ extra: { turnstileSettlement: 'stub' } })] }),
  });
  assert.match(result.warnings.join(' '), /placeholder that settles nothing/);
});

test('a 402 on the paid request means nothing charged and nothing delivered', async () => {
  const result = await purchase({
    resource: 'https://x.example/x', maxPriceUsd: 1, signers: [signer],
    fetch: sellerFetch({ paidStatus: 402, paidBody: { error: 'settlement failed' } }),
  });
  assert.equal(result.status, 'settlement_failed');
  assert.match(result.summary, /nothing was charged and nothing was delivered/);
});

test('a 200 with no PAYMENT-RESPONSE is delivered, and the missing receipt is said out loud', async () => {
  const result = await purchase({
    resource: 'https://x.example/x', maxPriceUsd: 1, signers: [signer],
    fetch: sellerFetch({ paidBody: { verdict: 'fine' } }),
  });
  assert.equal(result.status, 'purchased');
  assert.deepEqual(result.answer, { verdict: 'fine' });
  assert.equal(result.settlement, null);
  assert.match(result.warnings.join(' '), /no PAYMENT-RESPONSE header, so there is no settlement id/);
});

test('a private address reached through the directory is refused; one the caller named is not', async () => {
  // The SSRF the tool would otherwise have: `purchase({ agent })` resolves its
  // URL out of a registration document a stranger wrote on chain.
  const fromDirectory = await purchase({
    resource: 'http://169.254.169.254/latest/meta-data/', maxPriceUsd: 1, signers: [signer], fetch: sellerFetch(),
  });
  assert.equal(fromDirectory.status, 'unpayable');
  assert.match(fromDirectory.summary, /refusing to fetch the private address/);

  const fromCaller = await purchase({
    resource: 'http://127.0.0.1:1/x', maxPriceUsd: 1, allowPrivateHosts: true, signers: [signer], fetch: sellerFetch(),
  });
  assert.notEqual(fromCaller.status, 'unpayable');
});

test('a non-http scheme is never fetched', async () => {
  const result = await purchase({
    resource: 'file:///etc/passwd', maxPriceUsd: 1, allowPrivateHosts: true, signers: [signer], fetch: sellerFetch(),
  });
  assert.equal(result.status, 'unpayable');
  assert.match(result.summary, /only http and https are payable/);
});

test('a header challenge is paid through @x402/fetch; a body-only one by hand', async () => {
  // Both are real x402 sellers. Only one of them sets the header, and
  // `wrapFetchWithPaymentFromConfig` reads the challenge from the header only —
  // so without the fallback the second seller would be unpayable through us.
  const body = { x402Version: 2, error: 'Payment required', accepts: [requirement()] };

  const withHeader = await purchase({
    resource: 'https://a.example/x', maxPriceUsd: 1, signers: [signer],
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (paymentHeader(input, init)) return new Response('{"ok":1}', { status: 200 });
      return new Response(JSON.stringify(body), {
        status: 402,
        headers: { 'content-type': 'application/json', 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(body as never) },
      });
    }) as typeof globalThis.fetch,
  });
  assert.equal(withHeader.status, 'purchased');
  assert.equal(withHeader.challengeFrom, 'header');
  assert.equal(withHeader.paidVia, 'x402-fetch');

  const bodyOnly = await purchase({
    resource: 'https://b.example/x', maxPriceUsd: 1, signers: [signer], fetch: sellerFetch(),
  });
  assert.equal(bodyOnly.status, 'purchased');
  assert.equal(bodyOnly.challengeFrom, 'body');
  assert.equal(bodyOnly.paidVia, 'manual');
  assert.match(bodyOnly.warnings.join(' '), /no PAYMENT-REQUIRED header/);
});
