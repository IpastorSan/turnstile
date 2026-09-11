// Offline doubles for the Base rail: a facilitator that answers, and the rail
// options that point at it.
//
// Same reason the other two rails have this file: `challenge()` reads the
// facilitator's `/supported` on every call, because a quote for a network the
// facilitator will not settle is a quote nobody can pay. A suite that hit the
// real one would be slow, offline-hostile, and would go red when the x402
// Foundation has a bad afternoon rather than when we broke something.

import type { BaseRailOptions } from './index.ts';

const PAYOUT = '0x0Adca6e14bA956201D221feC767e4f24194bf5F2';

/** The `(scheme, network)` pairs the real facilitator advertises, subset only. */
export const SUPPORTED_KINDS = {
  kinds: [
    { x402Version: 2, scheme: 'exact', network: 'eip155:84532' },
    { x402Version: 2, scheme: 'exact', network: 'eip155:8453' },
    { x402Version: 2, scheme: 'exact', network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' },
  ],
};

export interface FakeFacilitatorOptions {
  supported?: unknown;
  verify?: unknown;
  settle?: unknown;
}

/**
 * A fetch that answers `/supported`, `/verify` and `/settle`.
 *
 * Defaults are the happy path, so a test that only cares about `challenge()`
 * does not have to think about the other two endpoints.
 */
export function fakeBaseFacilitatorFetch(options: FakeFacilitatorOptions = {}): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/supported')) {
      return new Response(JSON.stringify(options.supported ?? SUPPORTED_KINDS), { status: 200 });
    }
    if (url.endsWith('/verify')) {
      return new Response(JSON.stringify(options.verify ?? { isValid: true, payer: '0xpayer' }), { status: 200 });
    }
    if (url.endsWith('/settle')) {
      return new Response(
        JSON.stringify(
          options.settle ?? { success: true, transaction: `0x${'ab'.repeat(32)}`, network: 'eip155:84532', payer: '0xpayer' },
        ),
        { status: 200 },
      );
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof globalThis.fetch;
}

/** Rail options that never touch the network. `over` wins, so a test can inject a broken facilitator. */
export function offlineOptions(over: Partial<BaseRailOptions> = {}): BaseRailOptions {
  return {
    payTo: PAYOUT,
    facilitatorOptions: { fetch: fakeBaseFacilitatorFetch() },
    rpcFetch: (async () => new Response(JSON.stringify({ result: null }), { status: 200 })) as unknown as typeof globalThis.fetch,
    ...over,
  };
}

/** The mainnet instance, offline: PayAI's kind list and the same happy-path fakes. */
export function offlineMainnetOptions(over: Partial<BaseRailOptions> = {}): BaseRailOptions {
  return {
    payTo: PAYOUT,
    facilitatorOptions: {
      fetch: fakeBaseFacilitatorFetch({
        supported: { kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453' }] },
      }),
    },
    rpcFetch: (async () => new Response(JSON.stringify({ result: null }), { status: 200 })) as unknown as typeof globalThis.fetch,
    ...over,
  };
}
