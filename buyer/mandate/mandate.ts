// The mandate: what the buyer organization has authorized its agent to do.
//
// One object, five fields, and every one of them is a *refusal* the agent will
// hit rather than a preference it may weigh. The agent reads this; it can never
// write it. That is `CLAUDE.md`'s invariant — **the key that spends can never
// raise its own limit** — and MOV-228 is the issue that stopped it being a
// convention and made it a thing Privy's enclave enforces.
//
// ## The mandate lives in two places, and they say the same thing
//
// | Where | Enforces | Enforced by |
// |---|---|---|
// | this object | which offer the agent may accept, before it signs | our code, in `enforceMandate` |
// | a **Privy policy** on the org wallet | how much the org may deposit into the agent's Gateway balance | Privy's enclave, before a signature exists |
//
// Neither is redundant. The first stops the agent overpaying a seller; the
// second stops *anyone with our app secret* over-funding the agent in the first
// place. `buyer/mandate/policy.ts` projects this object into the second, so the
// two cannot drift apart by hand.
//
// ## The decision that shapes this file: decide the tier before quoting
//
// MOV-225 verified against live Circle Gateway that **no rail can settle below
// the authorized amount** — an EIP-3009 authorization signs `value` into the
// EIP-712 digest, and `35000` against a `70000` authorization comes back
// `amount_mismatch`. Hedera is the same, because Blocky402 co-signs a frozen
// transaction.
//
// So a mandate has to decide *before* a signature exists, and there is no
// partial-settlement or refund path to fall back on. Everything below is
// therefore a pre-signature check on the 402 challenge, and there is deliberately
// no post-hoc "settle for less" seam for a later issue to reach for.

/** The rails this organization knows how to pay on. */
export type RailId = 'hedera-x402' | 'arc-usdc';

/**
 * What the organization authorized, as issued by the warm tier.
 *
 * Everything is required. An optional cap is a cap someone forgets to set.
 */
export interface Mandate {
  /**
   * Total the agent may commit over the mandate's life, in decimal US dollars.
   *
   * This is the number the Privy policy caps on chain, and the one that needs a
   * 2-of-N quorum to raise. See `policy.ts`.
   */
  spendCapUsd: number;
  /**
   * Hard ceiling for any single query, in decimal US dollars.
   *
   * Distinct from {@link spendCapUsd} because they fail differently: a breached
   * per-query ceiling means the seller is asking too much for one answer, and a
   * breached spend cap means the agent has done enough for now. Collapsing them
   * loses the ability to say which.
   */
  maxPerQueryUsd: number;
  /** Rails the agent may pay on, best first. An offer on a rail not listed is refused. */
  railPreference: readonly RailId[];
  /**
   * Payout accounts the agent may pay, in each rail's own address format —
   * `0x0Adca6…` for Arc, `0.0.10403961` for Hedera.
   *
   * Compared against `PaymentRequirement.payTo`, case-insensitively, because a
   * seller quoting a checksummed address and a mandate written in lowercase are
   * the same seller and should not be a silent refusal.
   *
   * An **empty list means no seller is allowed**, not "any seller". A mandate
   * that widens when a field is left blank is a mandate that widens by accident.
   */
  sellerAllowlist: readonly string[];
  /**
   * Require the operator issuing this mandate to be a verified human.
   *
   * **A seam, not a feature.** MOV-223 binds this to World proof-of-personhood
   * and is blocked on World Sandbox approval. Until then the only honest
   * behaviour is the one implemented in `verifiedOperatorGate` below: with the
   * flag off, proceed; with it on, **refuse**, because a gate that cannot check
   * anything must not pass everything.
   */
  verifiedOperatorOnly: boolean;
}

/**
 * How much of the mandate is left.
 *
 * Kept separate from the {@link Mandate} because the mandate is *issued* — it is
 * a signed statement of authority that does not change as money is spent — while
 * this is bookkeeping the agent keeps. Putting a mutable counter inside the
 * issued object is how a mandate quietly becomes something the agent edits.
 */
export class MandateLedger {
  readonly mandate: Mandate;
  #spentUsd = 0;

  constructor(mandate: Mandate, alreadySpentUsd = 0) {
    this.mandate = mandate;
    this.#spentUsd = alreadySpentUsd;
  }

  get spentUsd(): number {
    return this.#spentUsd;
  }

  get remainingUsd(): number {
    return Math.max(0, this.mandate.spendCapUsd - this.#spentUsd);
  }

  /** Record a settled payment. Called after the money moved, never before. */
  record(costUsd: number): void {
    if (!Number.isFinite(costUsd) || costUsd < 0) throw new Error(`not a spend amount: ${costUsd}`);
    this.#spentUsd += costUsd;
  }
}

/**
 * The reason a mandate refused, as a stable code.
 *
 * Codes rather than prose because the operator-facing workflow branches on them:
 * `spend_cap_exhausted` is the one a human answers by raising the cap, which is
 * the 2-of-N quorum path. The others are answered by changing the request.
 */
export type RefusalCode =
  | 'rail_not_in_mandate'
  | 'no_signer_for_rail'
  | 'seller_not_allowlisted'
  | 'over_per_query_ceiling'
  | 'spend_cap_exhausted'
  | 'operator_not_verified'
  | 'amount_unreadable';

export interface Refusal {
  code: RefusalCode;
  detail: string;
}

/**
 * The `verified_operator_only` gate, in the only honest form available today.
 *
 * MOV-223 will replace the `false` branch with a World proof-of-personhood
 * check. Until it can, an enabled flag **refuses**: a gate wired to nothing that
 * returns "allowed" is worse than no gate, because it reads as a control in the
 * demo and is not one.
 */
export function verifiedOperatorGate(mandate: Mandate, operatorIsVerified = false): Refusal | null {
  if (!mandate.verifiedOperatorOnly) return null;
  if (operatorIsVerified) return null;
  return {
    code: 'operator_not_verified',
    detail: 'the mandate requires a verified operator, and proof-of-personhood is not wired up yet (MOV-223, blocked on World Sandbox approval)',
  };
}

/** Is this payout account one the mandate names? Case-insensitive; empty allowlist allows nobody. */
export function isAllowlistedSeller(mandate: Mandate, payTo: string): boolean {
  const wanted = payTo.trim().toLowerCase();
  return mandate.sellerAllowlist.some(entry => entry.trim().toLowerCase() === wanted);
}

/**
 * A worked default: the mandate the demo issues.
 *
 * The numbers are the ones MOV-225 settled against live Gateway — $0.07 for the
 * standard tier, $0.35 for premium — so a $0.10 per-query ceiling is a ceiling
 * that genuinely bites on the premium tier rather than a round number chosen to
 * never fire.
 */
export function demoMandate(overrides: Partial<Mandate> = {}): Mandate {
  return {
    spendCapUsd: 0.25,
    maxPerQueryUsd: 0.1,
    railPreference: ['arc-usdc', 'hedera-x402'],
    sellerAllowlist: ['0x0Adca6e14bA956201D221feC767e4f24194bf5F2', '0.0.10403961'],
    verifiedOperatorOnly: false,
    ...overrides,
  };
}
