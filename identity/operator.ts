// "Has a person proved they are behind this seller?"
//
// The one question the payment path asks of World. It is answered here rather
// than inside `buyer/mandate/` on purpose: the mandate rule stays pure and
// testable without a database, and this is the thin layer that fetches.
//
// The answer is deliberately three-valued, collapsed to a boolean only at the
// last moment:
//
//   verified    a proof was checked by World's Developer Portal and recorded
//   rejected    a proof was checked and the listing was refused (over the limit)
//   unknown     no row. NOT "unverified" — we have not asked, and most agents in
//               the registry are not ours to ask about
//
// Collapsing `unknown` to `false` is right for a gate (refuse what you cannot
// check) and wrong for a UI (do not accuse 197 strangers of failing a test they
// were never given). Keeping the distinction here lets each caller choose.

import type { DatabaseSync } from 'node:sqlite';

import { verificationFor } from './store.ts';

export type OperatorStanding = 'verified' | 'rejected' | 'unknown';

export function operatorStanding(db: DatabaseSync, agentUid: string): OperatorStanding {
  const row = verificationFor(db, agentUid);
  if (!row) return 'unknown';
  return row.status;
}

/**
 * The boolean the mandate gate wants.
 *
 * `unknown` and `rejected` both become `false`. That is the whole point of the
 * gate: a mandate carrying `verifiedOperatorOnly` refuses anyone it cannot
 * positively vouch for, rather than treating silence as consent.
 */
export function operatorIsVerified(db: DatabaseSync, agentUid: string): boolean {
  return operatorStanding(db, agentUid) === 'verified';
}
