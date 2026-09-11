// How many seller listings one human may hold.
//
// This is the abuse model the World track asks for, and it is deliberately not
// a login. Nothing here authenticates anybody: proof-of-personhood answers one
// question, "is this the same human as that other listing", and the answer is
// used to cap how much of the registry a single person can occupy.
//
// Without it the market is a Sybil farm. One operator can register two hundred
// subnames, publish two hundred prices, and drown every honest seller in a
// ranking. The nullifier is what makes "one human" a checkable claim rather
// than an assumption about key ownership.
//
// Kept pure and separate from the store so the rule can be tested without a
// database, a network, or a World credential.

/**
 * Three, not one.
 *
 * One would be tidier and wrong: a real operator legitimately sells more than
 * one thing — a liquidity analyst and a depth analyst are different services
 * with different prices. The limit exists to make farming expensive, not to
 * make a second honest listing impossible. Three is the point where "this is a
 * business with a few products" stops and "this is someone occupying the
 * registry" starts.
 */
export const LISTINGS_PER_HUMAN = 3;

export type ListingRefusalCode = 'listing_limit_reached' | 'operator_not_verified' | 'listing_held_by_another_human';

export interface ListingAllowance {
  allowed: boolean;
  used: number;
  limit: number;
  remaining: number;
  code?: ListingRefusalCode;
  detail?: string;
}

/**
 * May this human publish another listing?
 *
 * `used` is how many listings already resolve to their nullifier. `verified` is
 * whether we hold a proof at all — and an unverified operator is refused rather
 * than waved through, for the same reason `verifiedOperatorGate` refuses: a gate
 * that cannot check anything must not pass everything.
 */
export function listingAllowance(
  used: number,
  options: { verified?: boolean; limit?: number } = {},
): ListingAllowance {
  const limit = options.limit ?? LISTINGS_PER_HUMAN;
  const verified = options.verified ?? true;

  if (!Number.isInteger(used) || used < 0) {
    throw new Error(`used must be a non-negative integer, got ${used}`);
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`limit must be a positive integer, got ${limit}`);
  }

  const remaining = Math.max(0, limit - used);

  if (!verified) {
    return {
      allowed: false,
      used,
      limit,
      remaining,
      code: 'operator_not_verified',
      detail: 'no World proof is on file for this operator, so "how many listings does this human already hold" cannot be answered',
    };
  }

  if (used >= limit) {
    return {
      allowed: false,
      used,
      limit,
      remaining: 0,
      code: 'listing_limit_reached',
      detail: `this human already holds ${used} of ${limit} listings`,
    };
  }

  return { allowed: true, used, limit, remaining };
}
