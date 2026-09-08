// A stand-in for Blocky402 and the mirror node, so the rail's tests run offline.
//
// Every response body here was **copied from a real one** — `/supported` from
// `GET https://api.testnet.blocky402.com/supported` on 2026-09-07, the settle
// response from the transaction in `docs/payment-flow.md`. That matters more
// than it sounds: a fake whose shape we invented would let the rail pass its
// tests while mis-parsing the real thing, which is the failure a fake is
// supposed to prevent rather than cause.
//
// The one thing this cannot check is whether the *facilitator* accepts what we
// send it. Only a real payment proves that, which is what
// `scripts/hedera-paid-request.ts` is for.

import { FACILITATOR_URL, HBAR_ASSET, NETWORK } from './config.ts';

export const FEE_PAYER = '0.0.7162784';

/** Verbatim from the live facilitator, 2026-09-07. */
export const SUPPORTED_BODY = {
  kinds: [
    { x402Version: 2, scheme: 'exact', network: 'eip155:80002' },
    { x402Version: 2, scheme: 'exact', network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', extra: { feePayer: '7B6Q2MvcJvNcy1A13wHmAzmmdo3L8DVriaXML7bvkojm' } },
    { x402Version: 2, scheme: 'exact', network: NETWORK, extra: { feePayer: FEE_PAYER } },
  ],
  extensions: [],
  signers: { 'eip155:*': ['0xDCF7D72C2eE049DE4269ac6AAf925F33efdA18de'], 'solana:*': ['7B6Q2MvcJvNcy1A13wHmAzmmdo3L8DVriaXML7bvkojm'], 'hedera:*': [FEE_PAYER] },
};

export interface FakeFacilitatorOptions {
  /** Answer `/verify` with this instead of `{ isValid: true }`. */
  verify?: { isValid: boolean; invalidReason?: string; invalidMessage?: string; payer?: string };
  settle?: { success: boolean; transaction?: string; payer?: string; errorReason?: string; errorMessage?: string };
  /** Drop `hedera:testnet` from `/supported`, as if Blocky402 had stopped covering it. */
  withoutHedera?: boolean;
  /** Every request throws, as if the facilitator were unreachable. */
  unreachable?: boolean;
  /** Reply with this HTTP status and body instead of a JSON verdict. */
  httpError?: { status: number; body: string };
}

export const SAMPLE_TRANSACTION_ID = '0.0.7162784@1788791330.918068236';

/**
 * A `fetch` that answers the facilitator and the mirror node.
 *
 * Records every request so a test can assert *what was sent* — the parity rules
 * are strict enough that "we posted `payload.accepted` and not a freshly issued
 * requirement" is a property worth pinning.
 */
export function fakeFacilitatorFetch(options: FakeFacilitatorOptions = {}): typeof globalThis.fetch & { calls: { url: string; body: unknown }[] } {
  const calls: { url: string; body: unknown }[] = [];

  const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : null;
    calls.push({ url, body });

    if (options.unreachable) throw new TypeError('fetch failed');
    if (options.httpError) {
      return new Response(options.httpError.body, { status: options.httpError.status });
    }

    if (url.endsWith('/supported')) {
      const kinds = options.withoutHedera ? SUPPORTED_BODY.kinds.filter(k => k.network !== NETWORK) : SUPPORTED_BODY.kinds;
      return Response.json({ ...SUPPORTED_BODY, kinds });
    }
    if (url.endsWith('/verify')) {
      return Response.json(options.verify ?? { isValid: true, payer: '0.0.10408012' });
    }
    if (url.endsWith('/settle')) {
      const settle = options.settle ?? { success: true, transaction: SAMPLE_TRANSACTION_ID, payer: '0.0.10408012' };
      return Response.json({ network: NETWORK, transaction: '', ...settle });
    }
    if (url.includes('/api/v1/network/exchangerate')) {
      // 8.297 cents per HBAR — the live rate on 2026-09-07.
      return Response.json({ current_rate: { cent_equivalent: 248910, hbar_equivalent: 30000, expiration_time: 0 }, timestamp: '0' });
    }
    if (url.includes('/api/v1/transactions/')) {
      return Response.json({
        transactions: [{
          transaction_id: '0.0.7162784-1788791330-918068236',
          result: 'SUCCESS',
          consensus_timestamp: '1788791337.285420104',
          transfers: [
            { account: '0.0.802', amount: 241050 },
            { account: FEE_PAYER, amount: -241050 },
            { account: '0.0.10403961', amount: 84367844 },
            { account: '0.0.10408012', amount: -84367844 },
          ],
        }],
      });
    }
    if (url.includes('/api/v1/topics/')) {
      return Response.json({ messages: [] });
    }
    throw new Error(`the fake facilitator was asked for an unexpected URL: ${url}`);
  }) as typeof globalThis.fetch & { calls: { url: string; body: unknown }[] };

  doFetch.calls = calls;
  return doFetch;
}

/** The options that make `createHederaRail` offline and deterministic. */
export function offlineRailOptions(fetch: typeof globalThis.fetch) {
  return {
    payTo: '0.0.10403961',
    facilitatorOptions: { baseUrl: FACILITATOR_URL, fetch },
    rateOptions: { fetch, ttlMs: 0 },
    // No topic id, so `submit()` short-circuits and no key is ever needed.
    receiptTopicOptions: { topicId: null, fetch },
    mirrorNodeFetch: fetch,
    asset: HBAR_ASSET,
  };
}
