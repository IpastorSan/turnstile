// The buyer's half: a `fetch` that pays a 402 instead of failing on it.
//
// This is `@x402/fetch`'s `wrapFetchWithPaymentFromConfig`, with the two
// decisions that are ours rather than the SDK's wired in:
//
//   1. **Which rail to pay on.** The seller advertises several ways to pay; the
//      mandate picks one. That choice is the whole reason the 402 carries more
//      than one `accepts[]` entry.
//   2. **Whether to pay at all.** The mandate's per-payment cap is enforced here,
//      before a signature exists.
//
// ## The invariant this file defends
//
// From `CLAUDE.md`: **the key that spends can never raise its own limit.** The
// mandate is issued by the warm tier (the buyer organization's Privy wallet) and
// this agent — the hot tier — only spends inside it. So `Mandate` is an argument,
// never something constructed from the agent's own state, and nothing below
// widens it. `enforceMandate` is a pure function of `(mandate, accepts)` for
// exactly that reason: it is the piece a reviewer has to be able to read in one
// sitting and be sure of.
//
// The SDK's own `spendControls` are switched off rather than configured, because
// they are denominated through a default-asset table that only recognises
// mainstream stablecoins on mainstream chains — a rail whose asset it does not
// know would be silently uncapped. Doing the cap ourselves means an unrecognised
// asset is *rejected* rather than waved through, which is the right direction to
// fail in.

import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';

import type { PaymentRequirement } from '../../rails/PaymentRail.ts';

/**
 * What the buyer organization has authorized this agent to do.
 *
 * Issued by the warm tier. The hot tier reads it and cannot change it.
 */
export interface Mandate {
  /**
   * Rail ids or ENS rail tokens, best first. A seller's `accepts[]` entry is
   * matched on `(scheme, network)` via {@link RailSigner}, so this is a
   * preference order over the signers this agent holds, not over strings on the
   * wire.
   */
  preferredRails: string[];
  /** Hard per-payment ceiling, in decimal US dollars. */
  maxPerPaymentUsd: number;
}

/**
 * The buyer-side mirror of one `PaymentRail`: it can sign for one
 * `(scheme, network)` pair.
 *
 * Kept as small as the seller's rail interface and for the same reason — MOV-220
 * and MOV-225 each add one of these next to their seller rail, and neither
 * should have to touch this file to do it.
 */
export interface RailSigner {
  /** Matches the seller rail's `id`, and what `Mandate.preferredRails` names. */
  railId: string;
  scheme: string;
  network: string;
  /** Decimals of the asset this signer pays in, for the USD cap. */
  decimals: number;
  /** USD per whole unit. `1` for a dollar stablecoin. */
  usdPerUnit?: number;
  /**
   * Produce the rail-private authorization: a signature, an authorization
   * object, a partially-signed transaction. Whatever the seller rail's
   * `verify()` expects in `PaymentPayload.payload`.
   */
  sign(requirement: PaymentRequirement): Promise<Record<string, unknown>>;
}

export interface MandateDecision {
  chosen: PaymentRequirement | null;
  /** Every offer that was ruled out, and why. The audit trail for a refusal. */
  rejected: { requirement: PaymentRequirement; reason: string }[];
}

/** What one `accepts[]` entry costs, in dollars, according to the signer for it. */
export function requirementCostUsd(requirement: PaymentRequirement, signer: RailSigner): number {
  return (Number(requirement.amount) / 10 ** signer.decimals) * (signer.usdPerUnit ?? 1);
}

/**
 * Pick the offer to pay, or refuse.
 *
 * Pure, and separated from the fetch wrapper so it can be tested and read on its
 * own — it is the function that decides how the buyer's money moves.
 *
 * An offer survives only if this agent holds a signer for its `(scheme, network)`
 * pair *and* its cost is within the mandate. Among survivors, `preferredRails`
 * order wins; ties fall to the cheaper offer.
 */
export function enforceMandate(
  accepts: readonly PaymentRequirement[],
  mandate: Mandate,
  signers: readonly RailSigner[],
): MandateDecision {
  const rejected: { requirement: PaymentRequirement; reason: string }[] = [];
  const viable: { requirement: PaymentRequirement; signer: RailSigner; costUsd: number }[] = [];

  for (const requirement of accepts) {
    const signer = signers.find(s => s.scheme === requirement.scheme && s.network === requirement.network);
    if (!signer) {
      rejected.push({ requirement, reason: `no signer for ${requirement.scheme} on ${requirement.network}` });
      continue;
    }
    if (!mandate.preferredRails.includes(signer.railId)) {
      rejected.push({ requirement, reason: `rail '${signer.railId}' is not in the mandate` });
      continue;
    }
    const costUsd = requirementCostUsd(requirement, signer);
    if (!Number.isFinite(costUsd)) {
      rejected.push({ requirement, reason: `amount '${requirement.amount}' is not a number` });
      continue;
    }
    if (costUsd > mandate.maxPerPaymentUsd) {
      rejected.push({ requirement, reason: `$${costUsd.toFixed(4)} exceeds the mandate cap of $${mandate.maxPerPaymentUsd.toFixed(4)}` });
      continue;
    }
    viable.push({ requirement, signer, costUsd });
  }

  viable.sort((a, b) => {
    const rank = mandate.preferredRails.indexOf(a.signer.railId) - mandate.preferredRails.indexOf(b.signer.railId);
    return rank !== 0 ? rank : a.costUsd - b.costUsd;
  });

  return { chosen: viable[0]?.requirement ?? null, rejected };
}

export class MandateViolation extends Error {
  readonly rejected: MandateDecision['rejected'];
  constructor(decision: MandateDecision) {
    const detail = decision.rejected.map(r => `${r.requirement.scheme}/${r.requirement.network}: ${r.reason}`).join('; ');
    super(`the mandate authorizes none of the seller's payment options — ${detail || 'the seller offered none'}`);
    this.name = 'MandateViolation';
    this.rejected = decision.rejected;
  }
}

export interface PaidFetchOptions {
  mandate: Mandate;
  signers: readonly RailSigner[];
  /** Defaults to the global `fetch`. Injectable for tests. */
  fetch?: typeof globalThis.fetch;
}

/**
 * A `fetch` that answers a 402 by paying it, within the mandate.
 *
 * ```ts
 * const pay = createPaidFetch({ mandate, signers: [hederaSigner] });
 * const res = await pay('https://seller.example/analyze/0x88e6...');
 * const verdict = await res.json();
 * ```
 *
 * Throws {@link MandateViolation} when the seller's price or rails are outside
 * what the organization authorized — the agent stops rather than improvising.
 */
export function createPaidFetch(options: PaidFetchOptions): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const { mandate, signers } = options;

  return wrapFetchWithPaymentFromConfig(options.fetch ?? globalThis.fetch, {
    schemes: signers.map(signer => ({
      network: signer.network as `${string}:${string}`,
      client: {
        scheme: signer.scheme,
        async createPaymentPayload(x402Version: number, requirements: unknown) {
          return { x402Version, payload: await signer.sign(requirements as PaymentRequirement) };
        },
      },
    })),
    // Ours instead, and stricter — see the header comment.
    spendControls: false,
    // Named `paymentRequirementsSelector` in the config even though the type it
    // takes is exported as `SelectPaymentRequirements`.
    paymentRequirementsSelector: (_version: number, accepts: unknown[]) => {
      const decision = enforceMandate(accepts as PaymentRequirement[], mandate, signers);
      if (!decision.chosen) throw new MandateViolation(decision);
      return decision.chosen as never;
    },
  });
}
