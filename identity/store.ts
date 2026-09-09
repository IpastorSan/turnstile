// Reading and writing `world_verification`.
//
// The table has been in the schema since MOV-222 with nothing writing to it, so
// discovery has reported every agent as `unknown`. This is what fills it.
//
// One row per agent, keyed by `agent_uid`. Counting listings per human is
// therefore a count of rows sharing a nullifier — which is why the nullifier
// column is NOT unique: holding three listings is allowed, and a unique index
// would make the second one impossible rather than the fourth.

import type { DatabaseSync } from 'node:sqlite';

import { listingAllowance, type ListingAllowance } from './limits.ts';

export interface VerificationRow {
  agentUid: string;
  status: 'verified' | 'rejected';
  nullifier: string | null;
  proofRef: string | null;
  verifiedAt: number;
}

/** Everything a listing decision needs about one human. */
export interface HumanStanding {
  nullifier: string;
  used: number;
  allowance: ListingAllowance;
  agents: string[];
}

export function recordVerification(
  db: DatabaseSync,
  entry: { agentUid: string; nullifier: string; proofRef?: string | null; status?: 'verified' | 'rejected'; at?: number },
): void {
  db.prepare(
    `INSERT INTO world_verification (agent_uid, status, nullifier, proof_ref, verified_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(agent_uid) DO UPDATE SET
       status = excluded.status,
       nullifier = excluded.nullifier,
       proof_ref = excluded.proof_ref,
       verified_at = excluded.verified_at`,
  ).run(
    entry.agentUid,
    entry.status ?? 'verified',
    entry.nullifier,
    entry.proofRef ?? null,
    entry.at ?? Math.floor(Date.now() / 1000),
  );
}

export function verificationFor(db: DatabaseSync, agentUid: string): VerificationRow | null {
  const row = db
    .prepare('SELECT agent_uid, status, nullifier, proof_ref, verified_at FROM world_verification WHERE agent_uid = ?')
    .get(agentUid) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    agentUid: String(row['agent_uid']),
    status: row['status'] === 'rejected' ? 'rejected' : 'verified',
    nullifier: row['nullifier'] === null ? null : String(row['nullifier']),
    proofRef: row['proof_ref'] === null ? null : String(row['proof_ref']),
    verifiedAt: Number(row['verified_at']),
  };
}

/**
 * What this human currently holds.
 *
 * Only `status = 'verified'` rows count. A rejected row is a record that
 * somebody tried, and counting it would let a failed verification consume
 * somebody else's allowance.
 */
export function standingFor(db: DatabaseSync, nullifier: string): HumanStanding {
  const rows = db
    .prepare("SELECT agent_uid FROM world_verification WHERE nullifier = ? AND status = 'verified' ORDER BY verified_at")
    .all(nullifier) as Record<string, unknown>[];
  const agents = rows.map(row => String(row['agent_uid']));
  return { nullifier, used: agents.length, allowance: listingAllowance(agents.length), agents };
}

/**
 * May this human claim this particular agent?
 *
 * Re-claiming an agent they already hold is allowed and does not consume a new
 * slot — otherwise re-verifying after a key rotation would cost an operator a
 * listing they already own.
 */
export function mayClaim(db: DatabaseSync, nullifier: string, agentUid: string): ListingAllowance {
  const standing = standingFor(db, nullifier);
  if (standing.agents.includes(agentUid)) {
    return { allowed: true, used: standing.used, limit: standing.allowance.limit, remaining: standing.allowance.remaining };
  }
  return standing.allowance;
}
