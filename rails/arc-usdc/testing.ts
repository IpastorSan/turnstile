// A stand-in for Circle Gateway, so the rail's tests run offline.
//
// Every response body here was **copied from a real one**, captured on
// 2026-09-07 and reproduced in `docs/arc-nanopayments.md`:
//
//   - {@link SUPPORTED_BODY} is the `eip155:5042002` entry from
//     `GET https://gateway-api-testnet.circle.com/v1/x402/supported`;
//   - {@link SETTLED_TRANSFER} is a real completed transfer read off the public
//     transfers API, including the batch hash it shared with twelve others;
//   - the `insufficient_balance` settle response is what Gateway really answered
//     when an unfunded wallet's authorization was submitted.
//
// A fake whose shape we invented would let the rail pass its tests while
// mis-parsing the real thing, which is the failure a fake is supposed to prevent
// rather than cause.
//
// What this cannot check is whether Gateway *accepts* what we send it. Only a
// real payment proves that, which is what `scripts/arc-paid-request.ts` is for.

import { FACILITATOR_URL, GATEWAY_WALLET, NETWORK, USDC_ASSET } from './config.ts';
import type { GatewaySettleResponse, GatewayTransfer, GatewayVerifyResponse, SupportedKind } from './gateway.ts';

/** The Arc entry from the live `/supported`, verbatim. */
export const SUPPORTED_KIND = {
  x402Version: 2,
  scheme: 'exact',
  network: NETWORK,
  extra: {
    name: 'GatewayWalletBatched',
    version: '1',
    verifyingContract: GATEWAY_WALLET,
    minValiditySeconds: 604800,
    assets: [{ symbol: 'USDC', address: USDC_ASSET, decimals: 6 }],
  },
};

/** Two other chains alongside it, so `kindFor` has something to pick out of. */
export const SUPPORTED_BODY = {
  kinds: [
    { x402Version: 2, scheme: 'exact', network: 'eip155:84532', extra: { ...SUPPORTED_KIND.extra, assets: [{ symbol: 'USDC', address: '0x036cbd53842c5426634e7929541ec2318f3dcf7e', decimals: 6 }] } },
    SUPPORTED_KIND,
    { x402Version: 2, scheme: 'exact', network: 'eip155:80002', extra: { ...SUPPORTED_KIND.extra, assets: [{ symbol: 'USDC', address: '0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582', decimals: 6 }] } },
  ],
  extensions: [],
  signers: { 'eip155:*': [] },
};

export const SAMPLE_AUTHORIZATION_ID = '88639ec6-35c3-4588-90c9-2db819546cd7';
/** One real batch transaction. On 2026-09-07 it carried thirteen authorizations. */
export const SAMPLE_BATCH_TX = '0x36f4129088ce33ff33d4183acefdd207443870f6319a7766948985339c91f188';

/** A real completed transfer. Note `amount: '1308'` — $0.001308, a nanopayment. */
export const SETTLED_TRANSFER: GatewayTransfer = {
  id: SAMPLE_AUTHORIZATION_ID,
  status: 'completed',
  token: 'USDC',
  sendingNetwork: NETWORK,
  recipientNetwork: NETWORK,
  fromAddress: '0xc6e770f3f9e6c2c5aa7e53e8caed86016759eaa7',
  toAddress: '0xec3fc32431aa97d28897b571731975bdaef56e5c',
  amount: '1308',
  nonce: '0x92591b239ec5cd66d3c04f81d2bfb02837e7a07aa6e48eaf62cc976a10043b9a',
  txHash: SAMPLE_BATCH_TX,
  createdAt: '2026-09-07T16:39:06.289Z',
  updatedAt: '2026-09-07T16:41:03.146Z',
};

/** The same transfer in the window between `/settle` and the batch landing. */
export const PENDING_TRANSFER: GatewayTransfer = {
  ...SETTLED_TRANSFER,
  status: 'received',
  txHash: null,
  updatedAt: SETTLED_TRANSFER.createdAt,
};

export interface FakeGatewayOptions {
  verify?: GatewayVerifyResponse;
  settle?: GatewaySettleResponse;
  /** What `/v1/x402/transfers/:id` answers. `null` for a 404. */
  transfer?: GatewayTransfer | null;
  /** Drop Arc from `/supported`, as if Gateway had stopped covering it. */
  withoutArc?: boolean;
  /** Publish Arc without a `verifyingContract`, so no payer could sign. */
  withoutVerifyingContract?: boolean;
  /** Every call throws, as if Gateway were unreachable. */
  unreachable?: boolean;
}

/**
 * A fake `BatchFacilitatorClient` plus a fake `fetch` for the transfers API.
 *
 * They are separate because the real ones are: the SDK owns `/verify`,
 * `/settle` and `/supported`, and the transfers API is plain HTTP that the
 * server-side SDK does not cover.
 *
 * Records every call so a test can assert *what was sent* — that `settle` posts
 * `payload.accepted` rather than a freshly issued requirement, and that a
 * `resource` was attached at all, are both properties worth pinning.
 */
export function fakeGateway(options: FakeGatewayOptions = {}) {
  const calls: { method: string; payload?: unknown; requirements?: unknown; url?: string }[] = [];

  const facilitator = {
    async getSupported() {
      calls.push({ method: 'getSupported' });
      if (options.unreachable) throw new TypeError('fetch failed');
      let kinds: SupportedKind[] = SUPPORTED_BODY.kinds;
      if (options.withoutArc) kinds = kinds.filter(k => k.network !== NETWORK);
      if (options.withoutVerifyingContract) {
        kinds = kinds.map(k => (k.network === NETWORK ? { ...k, extra: { name: 'GatewayWalletBatched', version: '1' } } : k));
      }
      return { ...SUPPORTED_BODY, kinds } as never;
    },
    async verify(payload: unknown, requirements: unknown) {
      calls.push({ method: 'verify', payload, requirements });
      if (options.unreachable) throw new TypeError('fetch failed');
      return (options.verify ?? { isValid: true, payer: '0x0633a193017939bb1eb242982397224c66948e2f' }) as never;
    },
    async settle(payload: unknown, requirements: unknown) {
      calls.push({ method: 'settle', payload, requirements });
      if (options.unreachable) throw new TypeError('fetch failed');
      return (options.settle ?? {
        success: true,
        transaction: SAMPLE_AUTHORIZATION_ID,
        network: NETWORK,
        payer: '0x0633a193017939bb1eb242982397224c66948e2f',
      }) as never;
    },
  };

  const doFetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push({ method: 'fetch', url });
    if (options.unreachable) throw new TypeError('fetch failed');
    if (url.includes('/v1/x402/transfers/')) {
      const transfer = options.transfer === undefined ? SETTLED_TRANSFER : options.transfer;
      return transfer ? Response.json(transfer) : new Response('not found', { status: 404 });
    }
    if (url.includes('/v1/x402/transfers')) {
      const transfer = options.transfer === undefined ? SETTLED_TRANSFER : options.transfer;
      return Response.json({ transfers: transfer ? [transfer] : [] });
    }
    throw new Error(`the fake Gateway was asked for an unexpected URL: ${url}`);
  }) as typeof globalThis.fetch;

  return { facilitator, fetch: doFetch, calls };
}

/** The options that make `createArcRail` offline and deterministic. */
export function offlineRailOptions(gateway: ReturnType<typeof fakeGateway>) {
  return {
    payTo: '0x0Adca6e14bA956201D221feC767e4f24194bf5F2',
    gatewayOptions: {
      baseUrl: FACILITATOR_URL,
      facilitator: gateway.facilitator,
      fetch: gateway.fetch,
      supportedTtlMs: 0,
    },
  };
}
