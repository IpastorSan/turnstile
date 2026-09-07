// Buying an answer from an agent, over x402, inside a mandate.
//
// The whole of this file is protocol, not product. It fetches a URL, reads the
// 402 the URL returns, decides whether the mandate allows paying it, pays, and
// hands back what came out. Nothing in it knows what is being sold, who is
// selling it, or which chain the money moved on — `buyer/watchdog/pay.ts` owns
// the mandate and the rail choice, and `@x402/fetch` owns the wire.
//
// That is the reusable-infrastructure claim in one sentence: **this pays any
// x402 seller, and there is no branch anywhere for ours.**
//
// ## Reading the challenge from two places, and paying it two ways
//
// x402 v2 carries the challenge in a `PAYMENT-REQUIRED` header *and*, by
// convention, in the response body. Our own seller sends both. A stranger's
// server may send only one, and refusing to read the body would turn "this
// seller spells the protocol slightly differently" into "this seller cannot be
// paid".
//
// That has a consequence for how the payment is sent, because
// `@x402/fetch`'s `wrapFetchWithPaymentFromConfig` re-issues the request itself
// and reads the challenge from **the header only** — a body-only 402 makes it
// throw `Failed to parse payment requirements` before any signer is consulted.
// (Verified against @x402/fetch 2.25 on 2026-09-07 by a body-only fixture; see
// `purchase.test.ts`.) So:
//
//   - challenge in the header  -> pay through `@x402/fetch`, the reference
//     client, which is also what `seller/service/x402-interop.test.ts` proves
//     our own seller against;
//   - challenge in the body only -> build the `PAYMENT-SIGNATURE` header from
//     the same signer by hand.
//
// Both paths sign the identical payload with the identical signer, and the
// result reports which was taken in `paidVia`. The fallback exists so that one
// seller's reading of the spec is not the reason a buyer cannot pay it.
//
// ## Why `dryRun` is not a toy
//
// It fetches the real 402 and runs the real mandate over it, and stops before a
// signature exists. That is the call an agent should make when it is deciding
// *whether* to buy.
//
// It does still need a signer, and that is not an oversight: the mandate's cap
// is applied to the **buyer's own** valuation of the asset, and the signer is
// what supplies that valuation. Without one, the only dollar figure available is
// the seller's, which is precisely the number a cap must not be computed from.
// With no signer at all the result is `no_signer` and carries the real quote,
// labelled as the seller's arithmetic — still useful, and honest about which
// number it is.

import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from '@x402/core/http';

import { isBlockedHost } from '../graph/sink/card.ts';
import { sellerDeclaredUsd } from './offer.ts';
import { createPaidFetch, enforceMandate, requirementCostUsd } from '../buyer/watchdog/pay.ts';
import type { Mandate, MandateDecision, RailSigner } from '../buyer/watchdog/pay.ts';
import type { PaymentRequirement } from '../rails/PaymentRail.ts';
import { loadSigners } from './signers.ts';
import type { SignerGap } from './signers.ts';

export type PurchaseStatus =
  /** Paid, settled, and the seller returned the goods. */
  | 'purchased'
  /** `dryRun`: the mandate allows it and nothing was signed. */
  | 'would_purchase'
  /** A 402 was returned and the mandate authorizes none of its `accepts[]`. */
  | 'refused'
  /** The resource answered, but not with something payable. */
  | 'unpayable'
  /** The resource is not gated: it returned the goods without asking for money. */
  | 'free'
  /** A payable 402, and this buyer holds no signer for any rail on it. */
  | 'no_signer'
  /** Settlement was attempted and did not complete. */
  | 'settlement_failed';

export interface Settlement {
  transaction: string;
  network: string;
  payer: string | null;
  /** Integer string in the asset's smallest unit — what actually moved. */
  amount: string | null;
  success: boolean;
  /** Block explorer link, when the network is one we know a URL shape for. */
  explorer: string | null;
}

export interface PurchaseResult {
  resource: string;
  status: PurchaseStatus;
  /** One sentence a calling agent can act on without parsing the rest. */
  summary: string;
  /** Everything the seller offered, verbatim from its 402. */
  accepts: PaymentRequirement[];
  challengeFrom: 'header' | 'body' | null;
  /**
   * Which client sent the payment. `x402-fetch` is the reference client;
   * `manual` is the fallback for a seller whose 402 carries no header.
   */
  paidVia: 'x402-fetch' | 'manual' | null;
  /** The entry the mandate picked, and every entry it refused, with reasons. */
  decision: (MandateDecision & { costUsd: number | null }) | null;
  mandate: Mandate;
  settlement: Settlement | null;
  /** The seller's response body, parsed as JSON when it is JSON. */
  answer: unknown;
  httpStatus: number | null;
  /** Rails this buyer could have used but has no credentials for. */
  signerGaps: SignerGap[];
  warnings: string[];
}

export interface PurchaseOptions {
  resource: string;
  /** Hard per-payment ceiling in decimal US dollars. Required: there is no default cap. */
  maxPriceUsd: number;
  /** Rail preference, best first. Defaults to every rail this buyer can sign for. */
  rails?: readonly string[];
  method?: 'GET' | 'POST';
  body?: unknown;
  headers?: Record<string, string>;
  /** Fetch the 402 and apply the mandate, then stop. Signs nothing. */
  dryRun?: boolean;
  timeoutMs?: number;
  /**
   * Allow a loopback or private address. Set only when the CALLER named the URL,
   * never for one resolved out of the directory — see `assertFetchable`.
   */
  allowPrivateHosts?: boolean;
  /** Injected in tests, so the whole flow runs with no network. */
  signers?: readonly RailSigner[];
  fetch?: typeof globalThis.fetch;
}

/**
 * Refuse a URL that this call has no business fetching.
 *
 * The threat is concrete rather than theoretical: `purchase({ agent })` resolves
 * its URL out of a registration document a stranger wrote on chain, and an
 * agent driving this tool would fetch `http://169.254.169.254/latest/meta-data/`
 * as readily as anything else. So a URL that came from the directory may not
 * name a private address, and one the caller typed may — which is what lets a
 * seller running on `127.0.0.1` be bought from during a demo.
 */
async function assertFetchable(resource: string, allowPrivateHosts: boolean): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(resource);
  } catch {
    return `'${resource}' is not a URL`;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `refusing to fetch ${parsed.protocol}// — only http and https are payable`;
  }
  if (!allowPrivateHosts && await isBlockedHost(parsed.hostname)) {
    return (
      `refusing to fetch the private address ${parsed.hostname}, because this URL came from a ` +
      'registration document rather than from you. Pass it as `resource` if you meant it.'
    );
  }
  return null;
}

/**
 * Explorer URL shapes, keyed by CAIP-2 network.
 *
 * Deliberately a lookup that can miss: a settlement on a network not in this
 * table gets `explorer: null` rather than a guessed URL, because a link that
 * 404s is worse than no link when the thing it is supposed to evidence is a
 * payment.
 */
const EXPLORERS: Record<string, (transaction: string) => string> = {
  'hedera:testnet': (t) => `https://hashscan.io/testnet/transaction/${t}`,
  'hedera:mainnet': (t) => `https://hashscan.io/mainnet/transaction/${t}`,
  'eip155:8453': (t) => `https://basescan.org/tx/${t}`,
  'eip155:84532': (t) => `https://sepolia.basescan.org/tx/${t}`,
  'eip155:1': (t) => `https://etherscan.io/tx/${t}`,
  'eip155:11155111': (t) => `https://sepolia.etherscan.io/tx/${t}`,
};

export function explorerUrl(network: string, transaction: string): string | null {
  return EXPLORERS[network]?.(transaction) ?? null;
}

interface Challenge {
  accepts: PaymentRequirement[];
  from: 'header' | 'body';
}

/**
 * Read the `accepts[]` out of a 402, from the header or the body.
 *
 * Returns `null` when neither carries one — which is a real outcome: plenty of
 * things answer 402 without speaking x402 at all.
 */
export function readChallenge(headerValue: string | null, bodyText: string): Challenge | null {
  if (headerValue) {
    try {
      const decoded = decodePaymentRequiredHeader(headerValue) as unknown as { accepts?: PaymentRequirement[] };
      if (Array.isArray(decoded.accepts) && decoded.accepts.length > 0) {
        return { accepts: decoded.accepts, from: 'header' };
      }
    } catch {
      // Fall through to the body. A malformed header on a response whose body
      // is a perfectly good challenge should not stop the purchase.
    }
  }
  try {
    const body = JSON.parse(bodyText) as { accepts?: PaymentRequirement[] };
    if (Array.isArray(body.accepts) && body.accepts.length > 0) {
      return { accepts: body.accepts, from: 'body' };
    }
  } catch { /* not JSON */ }
  return null;
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text.length > 4096 ? `${text.slice(0, 4096)}… (${text.length} bytes truncated)` : text;
  }
}

function requestInit(options: PurchaseOptions): RequestInit {
  const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
  return {
    method,
    headers: {
      accept: 'application/json',
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
  };
}

/**
 * Buy from `resource`, or explain precisely why not.
 *
 * Never throws for an ordinary refusal — a seller that will not quote, a price
 * over the cap, a rail we cannot sign for are all outcomes a calling agent has
 * to reason about, so they come back as a `status` rather than an exception.
 */
export async function purchase(options: PurchaseOptions): Promise<PurchaseResult> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const warnings: string[] = [];

  const loaded = options.signers ? { signers: [...options.signers], gaps: [] as SignerGap[] } : await loadSigners();
  const signers = loaded.signers;
  const mandate: Mandate = {
    preferredRails: options.rails ? [...options.rails] : signers.map((s) => s.railId),
    maxPerPaymentUsd: options.maxPriceUsd,
  };

  const base: Omit<PurchaseResult, 'status' | 'summary'> = {
    resource: options.resource,
    accepts: [],
    challengeFrom: null,
    paidVia: null,
    decision: null,
    mandate,
    settlement: null,
    answer: null,
    httpStatus: null,
    signerGaps: loaded.gaps,
    warnings,
  };

  const refusal = await assertFetchable(options.resource, options.allowPrivateHosts === true);
  if (refusal) {
    return { ...base, status: 'unpayable', summary: refusal };
  }

  // 1. Ask, without paying. This is also how we learn the price: under x402 the
  //    quote does not exist anywhere until the buyer asks for it.
  let unpaid: Response;
  try {
    unpaid = await doFetch(options.resource, requestInit(options));
  } catch (cause) {
    return {
      ...base,
      status: 'unpayable',
      summary: `${options.resource} could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }

  base.httpStatus = unpaid.status;
  const text = await unpaid.text();

  if (unpaid.status !== 402) {
    if (unpaid.ok) {
      return {
        ...base,
        status: 'free',
        answer: parseBody(text),
        summary:
          `${options.resource} returned HTTP ${unpaid.status} without asking for payment. ` +
          'Nothing was paid. An agent that advertises x402 support and then serves its endpoint ' +
          'free is common in the ERC-8004 directory; it is not an error.',
      };
    }
    return {
      ...base,
      status: 'unpayable',
      answer: parseBody(text),
      summary: `${options.resource} returned HTTP ${unpaid.status}, not a 402. There is nothing to pay.`,
    };
  }

  // 2. Read what it wants.
  const challenge = readChallenge(unpaid.headers.get('payment-required'), text);
  if (!challenge) {
    return {
      ...base,
      status: 'unpayable',
      answer: parseBody(text),
      summary:
        `${options.resource} answered 402 but carried no x402 accepts[] in either the ` +
        'PAYMENT-REQUIRED header or the body. It is asking for payment in some other protocol.',
    };
  }
  base.accepts = challenge.accepts;
  base.challengeFrom = challenge.from;

  // A seller advertising a rail that settles nothing is allowed to, as long as
  // it says so. Ours does, in `extra.turnstileSettlement`. Pass it on.
  for (const accept of challenge.accepts) {
    if (accept.extra?.['turnstileSettlement'] === 'stub') {
      warnings.push(`${accept.scheme} on ${accept.network} is advertised as a placeholder that settles nothing`);
    }
  }

  if (signers.length === 0) {
    // The mandate cannot be applied without a signer, and the reason is not a
    // missing feature: the cap is denominated in the BUYER's valuation of the
    // asset, and a signer is what supplies that valuation. Reporting the
    // seller's own figure here is useful and is labelled as what it is.
    const quoted = challenge.accepts.map((a) => {
      const declared = sellerDeclaredUsd(text, a.amount);
      return `${a.scheme}/${a.network} ${a.amount} ${a.asset}` + (declared !== null ? ` (~$${declared} by the seller's own arithmetic)` : '');
    });
    return {
      ...base,
      status: 'no_signer',
      summary:
        `${options.resource} quoted ${quoted.join(' | ')}, and this buyer holds no signer for any of them. ` +
        `${loaded.gaps.map((g) => `${g.railId}: ${g.why} — set ${g.needs.join(' and ')}`).join('; ') || 'No rails are configured.'}. ` +
        'The quote above is real and was fetched just now with no credential; only the payment needs a wallet. ' +
        "The mandate cannot be checked without one, because the cap is applied to the buyer's own valuation " +
        "of the asset rather than the seller's.",
    };
  }

  // 3. Would the mandate allow it? Run this before `createPaidFetch` so a
  //    refusal is a reported decision rather than a thrown MandateViolation.
  const decision = enforceMandate(challenge.accepts, mandate, signers);
  const chosenSigner = decision.chosen
    ? signers.find((s) => s.scheme === decision.chosen!.scheme && s.network === decision.chosen!.network)
    : undefined;
  const costUsd = decision.chosen && chosenSigner ? requirementCostUsd(decision.chosen, chosenSigner) : null;
  base.decision = { ...decision, costUsd };

  if (!decision.chosen) {
    return {
      ...base,
      status: 'refused',
      summary:
        `the mandate (max $${mandate.maxPerPaymentUsd}, rails ${mandate.preferredRails.join(', ') || 'none'}) ` +
        `authorizes none of the ${challenge.accepts.length} option(s) offered: ` +
        decision.rejected.map((r) => `${r.requirement.scheme}/${r.requirement.network} — ${r.reason}`).join('; '),
    };
  }

  if (options.dryRun) {
    return {
      ...base,
      status: 'would_purchase',
      summary:
        `would pay ${decision.chosen.amount} of ${decision.chosen.asset} on ${decision.chosen.network} ` +
        `(~$${costUsd?.toFixed(4) ?? '?'}) to ${decision.chosen.payTo}, within the $${mandate.maxPerPaymentUsd} cap. ` +
        'Nothing was signed and no value moved.',
    };
  }

  // 4. Pay. The seller verifies, does the work, settles, and returns 200.
  let paid: Response;
  try {
    if (challenge.from === 'header') {
      // The reference client re-issues the request itself, applying the same
      // mandate through the selector it was configured with.
      base.paidVia = 'x402-fetch';
      paid = await createPaidFetch({ mandate, signers, fetch: doFetch })(options.resource, requestInit(options));
    } else {
      base.paidVia = 'manual';
      warnings.push(
        'the 402 carried no PAYMENT-REQUIRED header, so the payment was assembled directly rather ' +
        'than through @x402/fetch, which reads the challenge from the header only. Same signer, ' +
        'same payload, same bytes on the wire.',
      );
      const header = encodePaymentSignatureHeader({
        x402Version: 2,
        accepted: decision.chosen,
        payload: await chosenSigner!.sign(decision.chosen),
      } as never);
      const init = requestInit(options);
      paid = await doFetch(options.resource, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), 'PAYMENT-SIGNATURE': header },
      });
    }
  } catch (cause) {
    return {
      ...base,
      status: 'settlement_failed',
      summary: `payment failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }

  base.httpStatus = paid.status;
  const paidText = await paid.text();
  base.answer = parseBody(paidText);

  if (!paid.ok) {
    return {
      ...base,
      status: 'settlement_failed',
      summary:
        `the paid request returned HTTP ${paid.status}. The seller verifies, does the work, then settles: ` +
        'a 402 here means settlement failed after the work was done, so nothing was charged and nothing was delivered.',
    };
  }

  const responseHeader = paid.headers.get('payment-response');
  if (responseHeader) {
    try {
      const settled = decodePaymentResponseHeader(responseHeader) as unknown as {
        transaction: string; network: string; payer?: string; amount?: string; success: boolean;
      };
      base.settlement = {
        transaction: settled.transaction,
        network: settled.network,
        payer: settled.payer ?? null,
        amount: settled.amount ?? null,
        success: settled.success,
        explorer: explorerUrl(settled.network, settled.transaction),
      };
    } catch (cause) {
      warnings.push(`PAYMENT-RESPONSE could not be decoded: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  } else {
    warnings.push('the seller returned 200 with no PAYMENT-RESPONSE header, so there is no settlement id to audit.');
  }

  return {
    ...base,
    status: 'purchased',
    summary:
      `paid ~$${costUsd?.toFixed(4) ?? '?'} on ${decision.chosen.network} and received HTTP 200` +
      (base.settlement ? `. Settlement ${base.settlement.transaction}${base.settlement.explorer ? ` — ${base.settlement.explorer}` : ''}` : '.'),
  };
}
