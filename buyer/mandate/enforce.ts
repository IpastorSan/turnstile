// Enforcement: turning the issued mandate into a refusal the agent actually
// hits.
//
// The mandate is five fields. This file is the one place that decides what each
// of them *does* to a 402 challenge, and it is deliberately small enough to read
// in one sitting, because it is the function that decides how the buyer's money
// moves.
//
// ## Where each field is enforced, and why not all in one place
//
// | Field | Enforced | By |
// |---|---|---|
// | `railPreference` | per offer | `enforceMandate` in `buyer/watchdog/pay.ts` |
// | `sellerAllowlist` | per offer | same |
// | `maxPerQueryUsd` | per offer | same |
// | `spendCapUsd` | per offer, against the ledger's remainder | same |
// | `spendCapUsd` | **again**, on the org's deposit | a **Privy policy**, in `policy.ts` |
// | `verifiedOperatorOnly` | before any offer is considered | {@link mandateSpendingLimits} |
//
// The spend cap appearing twice is not duplication. The first is the agent
// declining to overspend; the second is Privy's enclave declining to *hand the
// agent the money* in the first place. The first is code we could delete; the
// second is not, and that asymmetry is the whole point of the warm tier.

import { enforceMandate, type MandateDecision, type PaidFetchOptions, type RailSigner, type SpendingLimits } from '../watchdog/pay.ts';
import { createPaidFetch } from '../watchdog/pay.ts';
import type { PaymentRequirement } from '../../rails/PaymentRail.ts';
import { MandateLedger, verifiedOperatorGate, type Mandate, type Refusal } from './mandate.ts';

/**
 * Project a mandate onto one 402 challenge.
 *
 * The per-offer ceiling is the **tighter** of the per-query ceiling and what is
 * left of the spend cap, because both are real and a payment has to satisfy
 * both. They stay separate fields rather than being pre-minimised so the
 * refusal message can say which one bit.
 *
 * Throws when `verified_operator_only` is set, because that flag is a seam for
 * MOV-223 and is not wired to anything yet — see {@link verifiedOperatorGate}.
 * Refusing loudly at projection time is better than a mandate that silently
 * enforces four of its five fields.
 */
export function mandateSpendingLimits(mandate: Mandate, ledger?: MandateLedger, operatorIsVerified = false): SpendingLimits {
  const gate = verifiedOperatorGate(mandate, operatorIsVerified);
  if (gate) throw new MandateRefused([gate]);

  return {
    preferredRails: [...mandate.railPreference],
    maxPerPaymentUsd: mandate.maxPerQueryUsd,
    sellerAllowlist: [...mandate.sellerAllowlist],
    remainingSpendUsd: (ledger ?? new MandateLedger(mandate)).remainingUsd,
  };
}

/**
 * The agent stopped, with the reasons.
 *
 * Distinct from `pay.ts`'s `MandateViolation` because they answer different
 * questions: `MandateViolation` says "none of the seller's offers qualified",
 * this says "the mandate would not even let me look". Both are refusals; only
 * the second is answered by a human doing something.
 */
export class MandateRefused extends Error {
  readonly refusals: readonly Refusal[];
  constructor(refusals: readonly Refusal[]) {
    super(`the mandate refuses this request — ${refusals.map(r => `${r.code}: ${r.detail}`).join('; ')}`);
    this.name = 'MandateRefused';
    this.refusals = refusals;
  }
}

/**
 * Decide what this mandate does with a seller's `accepts[]`, without paying.
 *
 * The dry run behind the operator-facing workflow: `scripts/privy-mandate.ts`
 * calls this to show the refusal *before* asking a second operator to approve
 * raising the cap. A treasury control nobody can preview is a treasury control
 * nobody uses.
 */
export function decide(
  accepts: readonly PaymentRequirement[],
  mandate: Mandate,
  signers: readonly RailSigner[],
  options: { ledger?: MandateLedger; operatorIsVerified?: boolean } = {},
): MandateDecision {
  const limits = mandateSpendingLimits(mandate, options.ledger, options.operatorIsVerified ?? false);
  return enforceMandate(accepts, limits, signers);
}

/**
 * A `fetch` that pays 402s inside this mandate.
 *
 * The one call an agent author should need. `ledger` is threaded through so the
 * cumulative cap is live rather than a snapshot taken at construction.
 */
export function paidFetchForMandate(
  mandate: Mandate,
  signers: readonly RailSigner[],
  options: { ledger?: MandateLedger; operatorIsVerified?: boolean; fetch?: typeof globalThis.fetch } = {},
): ReturnType<typeof createPaidFetch> {
  const paidFetchOptions: PaidFetchOptions = {
    mandate: mandateSpendingLimits(mandate, options.ledger, options.operatorIsVerified ?? false),
    signers,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  };
  return createPaidFetch(paidFetchOptions);
}
