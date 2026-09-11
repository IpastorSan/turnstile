// Which key a World verification is stored under.
//
// The market joins `world_verification` to agents on `agent_uid`, and an
// agent's uid is its ERC-8004 registry id
// (`eip155:11155111:0x8004…/10127`), not its ENS name. The first real proof,
// on 2026-09-11, was stored under `liquidity.turnstile.eth` because /onboard
// posted the name, and the market kept reporting the seller as `unknown`
// (MOV-277). So the key is decided here, on the server, from the discovery
// store. The client never decides it.
//
// Two kinds of key come out:
//
//   agent        a listing registered on chain. Keyed by its agent_uid, so the
//                market join finds it.
//   reservation  a subname under turnstile.eth with no registered agent yet.
//                Keyed by the ENS name itself. It counts against the human's
//                three listings (identity/limits.ts), which is the point: the
//                cap has to hold before a name is registered, or farming just
//                means registering first and verifying later. When the name is
//                registered, `rekeyVerification` moves the row to the uid.
//
// No npm imports on purpose: scripts/world-rekey.ts uses this file on the
// production host with a bare `node` image and no node_modules.

import type { DatabaseSync } from 'node:sqlite';

/** The parent every Turnstile listing lives under. */
export const LISTING_PARENT = 'turnstile.eth';

const AGENT_UID = /^eip155:\d+:0x[0-9a-f]{40}\/\d+$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export type ListingKind = 'agent' | 'reservation';

export interface Listing {
  /** What world_verification.agent_uid holds for this listing. */
  key: string;
  kind: ListingKind;
  /** The ENS name, when there is one. Always set for a reservation. */
  ensName: string | null;
}

export type CanonicalListing =
  | ({ ok: true; input: string } & Listing)
  | { ok: false; input: string; code: 'not_a_listing' | 'unknown_agent'; reason: string };

export function looksLikeAgentUid(value: string): boolean {
  return AGENT_UID.test(value.trim().toLowerCase());
}

/** `Liquidity.Turnstile.eth.` -> `liquidity.turnstile.eth`. Not full ENSIP-15; our labels are ASCII. */
export function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

/** One label directly under turnstile.eth, and nothing else. */
export function isListingName(name: string): boolean {
  const suffix = `.${LISTING_PARENT}`;
  if (!name.endsWith(suffix)) return false;
  return LABEL.test(name.slice(0, -suffix.length));
}

interface SellerLink {
  ens_name: string;
  agent_uid: string | null;
}

function sellerByName(db: DatabaseSync, name: string): SellerLink | undefined {
  return db
    .prepare('SELECT ens_name, agent_uid FROM turnstile_seller WHERE LOWER(ens_name) = ?')
    .get(name) as SellerLink | undefined;
}

function nameForAgent(db: DatabaseSync, agentUid: string): string | null {
  const row = db
    .prepare('SELECT ens_name FROM turnstile_seller WHERE agent_uid = ? ORDER BY ens_name LIMIT 1')
    .get(agentUid) as { ens_name: string } | undefined;
  return row ? row.ens_name : null;
}

/**
 * Resolve an ENS name or an agent uid to the key its verification belongs under.
 *
 * - A registered agent uid comes back as itself, spelled as the store spells it.
 * - A turnstile.eth subname linked to an agent comes back as that agent's uid.
 * - A turnstile.eth subname with no agent comes back as a reservation, keyed by
 *   the normalized name.
 * - Anything else is refused. A uid we have never seen is refused rather than
 *   reserved: a uid is a claim about the chain, and we can check it.
 */
export function canonicalAgentUid(db: DatabaseSync, nameOrUid: string): CanonicalListing {
  const input = nameOrUid;
  const value = nameOrUid.trim().toLowerCase();

  if (!value) {
    return { ok: false, input, code: 'not_a_listing', reason: 'no listing was named' };
  }

  if (AGENT_UID.test(value)) {
    const row = db
      .prepare(
        `SELECT agent_uid FROM agent WHERE LOWER(agent_uid) = ?
         UNION SELECT agent_uid FROM turnstile_seller WHERE LOWER(agent_uid) = ?
         LIMIT 1`,
      )
      .get(value, value) as { agent_uid: string } | undefined;
    if (!row) {
      return {
        ok: false,
        input,
        code: 'unknown_agent',
        reason: `${value} is not in the discovery store, so it cannot be verified as a registered listing. Name its ${LISTING_PARENT} subname instead to reserve one.`,
      };
    }
    return { ok: true, input, kind: 'agent', key: row.agent_uid, ensName: nameForAgent(db, row.agent_uid) };
  }

  const name = normalizeName(value);
  if (!isListingName(name)) {
    return {
      ok: false,
      input,
      code: 'not_a_listing',
      reason: `listings are subnames directly under ${LISTING_PARENT} (for example depth.${LISTING_PARENT}) or registered ERC-8004 agent ids; ${name} is neither`,
    };
  }

  const seller = sellerByName(db, name);
  if (seller?.agent_uid) {
    return { ok: true, input, kind: 'agent', key: seller.agent_uid, ensName: seller.ens_name };
  }
  return { ok: true, input, kind: 'reservation', key: name, ensName: name };
}

/** Describe a key already in world_verification, for showing a human what they hold. */
export function describeListing(db: DatabaseSync, key: string): Listing {
  if (AGENT_UID.test(key.toLowerCase())) {
    return { key, kind: 'agent', ensName: nameForAgent(db, key) };
  }
  return { key, kind: 'reservation', ensName: key };
}

/** Every turnstile.eth listing registered as an agent, for the /onboard picker. */
export function registeredListings(db: DatabaseSync): { ensName: string; agentUid: string }[] {
  const rows = db
    .prepare('SELECT ens_name, agent_uid FROM turnstile_seller WHERE agent_uid IS NOT NULL ORDER BY ens_name')
    .all() as unknown as SellerLink[];
  return rows
    .filter(row => isListingName(normalizeName(row.ens_name)))
    .map(row => ({ ensName: row.ens_name, agentUid: String(row.agent_uid) }));
}

export type RekeyOutcome =
  | { status: 'rekeyed'; from: string; to: string }
  | { status: 'already_canonical'; from: string; to: string }
  | { status: 'no_row'; from: string }
  | { status: 'not_registered'; from: string; reason: string }
  | { status: 'conflict'; from: string; to: string; reason: string };

/**
 * Move a verification stored under an ENS name onto its agent's uid.
 *
 * Idempotent: a second run finds nothing under the name and reports
 * `already_canonical`. It refuses to overwrite a row already stored under the
 * uid, because that row is a proof too, possibly from a different human, and
 * picking one silently would be deciding who owns the listing.
 */
export function rekeyVerification(db: DatabaseSync, ensName: string): RekeyOutcome {
  const from = normalizeName(ensName);
  const resolved = canonicalAgentUid(db, from);
  if (!resolved.ok) return { status: 'not_registered', from, reason: resolved.reason };
  if (resolved.kind !== 'agent') {
    return { status: 'not_registered', from, reason: `${from} has no registered agent in the discovery store` };
  }
  const to = resolved.key;

  const source = db
    .prepare('SELECT agent_uid FROM world_verification WHERE LOWER(agent_uid) = ?')
    .get(from) as { agent_uid: string } | undefined;
  const target = db.prepare('SELECT agent_uid FROM world_verification WHERE agent_uid = ?').get(to);

  if (!source) return target ? { status: 'already_canonical', from, to } : { status: 'no_row', from };
  if (target) {
    return {
      status: 'conflict',
      from,
      to,
      reason: `world_verification already has a row for ${to}; refusing to overwrite it with the row stored under ${source.agent_uid}`,
    };
  }

  db.prepare('UPDATE world_verification SET agent_uid = ? WHERE agent_uid = ?').run(to, source.agent_uid);
  return { status: 'rekeyed', from, to };
}

/** Every row keyed by something other than an agent uid: reservations, and legacy rows like the 2026-09-11 one. */
export function nameKeyedVerifications(db: DatabaseSync): string[] {
  const rows = db.prepare('SELECT agent_uid FROM world_verification ORDER BY verified_at').all() as { agent_uid: string }[];
  return rows.map(row => row.agent_uid).filter(key => !AGENT_UID.test(key.toLowerCase()));
}
