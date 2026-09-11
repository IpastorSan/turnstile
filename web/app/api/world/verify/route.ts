// Verify a Selfie Check proof, then decide whether this human may list.
//
// Order matters and is the whole control:
//
//   1. Check the proof was made for the listing the request names: its
//      signal_hash must be hashSignal(listing), the exact string the client
//      handed to selfieCheckLegacy.
//   2. Decide which key the listing is stored under, from the discovery store,
//      never from the client. A registered turnstile.eth name becomes its
//      ERC-8004 agent uid, because that is what the market joins on. The first
//      real proof was stored under the ENS name and the market never saw it
//      (MOV-277). An unregistered subname is a reservation, keyed by the name.
//   3. Ask the Developer Portal whether the proof is cryptographically valid.
//      A client saying "I verified" is a client marking its own homework.
//   4. Take the nullifier from the *verified* response, never from the request
//      body. Trusting a client-supplied nullifier would let anyone claim to be
//      any human, which is precisely the attack this is meant to stop.
//   5. Count how many listings that human already holds and refuse the fourth.
//
// The proof is forwarded to World as-is. Their docs are explicit that fields
// must not be remapped, and tidying an untidy payload is the obvious mistake.

import { NextRequest } from 'next/server';

import {
  canonicalAgentUid,
  checkSignal,
  describeListing,
  mayClaim,
  recordVerification,
  rekeyVerification,
  standingFor,
  verifyProof,
  worldConfigFromEnv,
  worldIsConfigured,
  type Listing,
} from '../../../../../identity/index.ts';
import { openDiscoveryStore } from '../../../../lib/discovery.ts';
import { WORLD_VERIFY, rateLimit } from '../../../../lib/rate-limit.ts';

export const dynamic = 'force-dynamic';

function note(listing: Listing): string {
  return listing.kind === 'agent'
    ? `${listing.ensName ?? listing.key} is a registered listing, stored under its agent id so the market reads it`
    : `${listing.key} is a reservation: no agent is registered for it yet, so it is stored under the ENS name and counts against this human's listings. It moves to the agent id once the name is registered`;
}

export async function POST(request: NextRequest): Promise<Response> {
  // Every accepted request is a call to the Developer Portal and a row in our
  // store, so this is a write path with our credentials on it. The limit is
  // per-IP, which is looser than the per-human cap below and deliberately so:
  // this stops a script, the nullifier count stops a person.
  const limited = rateLimit(request, WORLD_VERIFY.name, WORLD_VERIFY.limit);
  if (limited) return limited;

  if (!worldIsConfigured()) {
    return Response.json(
      { ok: false, reason: 'This deployment has no World credentials configured.' },
      { status: 503 },
    );
  }

  let body: { listing?: unknown; agentUid?: unknown; proof?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, reason: 'the request body was not JSON' }, { status: 400 });
  }

  // `agentUid` is what clients before MOV-277 sent. Accepted, and canonicalized
  // like anything else: the name is only ever a request, never the key.
  const signal = typeof body.listing === 'string' ? body.listing : typeof body.agentUid === 'string' ? body.agentUid : '';
  if (!signal.trim()) {
    return Response.json({ ok: false, reason: 'listing is required: a proof has to be bound to the listing it authorises' }, { status: 400 });
  }
  if (!body.proof) {
    return Response.json({ ok: false, reason: 'proof is required' }, { status: 400 });
  }

  const bound = checkSignal(body.proof, signal);
  if (!bound.ok) {
    return Response.json({ ok: false, verified: false, code: 'signal_mismatch', reason: bound.reason }, { status: 400 });
  }

  const store = openDiscoveryStore({ readOnly: false });
  if (!store.ok) {
    return Response.json(
      { ok: false, verified: false, reason: `nothing was verified, because the proof could not be recorded: ${store.reason}` },
      { status: 503 },
    );
  }

  try {
    const db = store.db;
    const resolved = canonicalAgentUid(db, signal);
    if (!resolved.ok) {
      return Response.json({ ok: false, verified: false, code: resolved.code, reason: resolved.reason }, { status: 400 });
    }
    const listing: Listing = { key: resolved.key, kind: resolved.kind, ensName: resolved.ensName };

    const outcome = await verifyProof(worldConfigFromEnv(), body.proof);
    if (!outcome.ok) {
      return Response.json({ ok: false, verified: false, reason: outcome.reason, status: outcome.status }, { status: 400 });
    }

    const { nullifier } = outcome.proof;

    // A row stored under this name before it was registered (a reservation,
    // or the pre-MOV-277 bug) belongs under the uid now. Moving it first means
    // re-verifying a listing you hold is recognised as the same listing.
    if (listing.kind === 'agent' && listing.ensName) rekeyVerification(db, listing.ensName);

    const held = () => standingFor(db, nullifier).agents.map(key => describeListing(db, key));
    const allowance = mayClaim(db, nullifier, listing.key);
    if (!allowance.allowed) {
      // Recorded as rejected. A refused attempt is part of the audit trail, and
      // a rejected row deliberately does not consume anyone's allowance or
      // overwrite a verified one.
      recordVerification(db, { agentUid: listing.key, nullifier, status: 'rejected', proofRef: allowance.code ?? 'refused' });
      return Response.json(
        {
          ok: false,
          verified: true,
          allowed: false,
          reason: allowance.detail,
          code: allowance.code,
          listing: { ...listing, signal, note: note(listing) },
          used: allowance.used,
          limit: allowance.limit,
          listings: held(),
        },
        { status: 409 },
      );
    }

    recordVerification(db, { agentUid: listing.key, nullifier, status: 'verified' });
    const standing = standingFor(db, nullifier);
    return Response.json({
      ok: true,
      verified: true,
      allowed: true,
      // Never the nullifier itself: it is a stable per-app pseudonym, and
      // handing it back to the browser lets anyone correlate listings to a
      // person outside our own store.
      listing: { ...listing, signal, note: note(listing) },
      signalChecked: bound.checked,
      used: standing.used,
      limit: standing.allowance.limit,
      remaining: standing.allowance.remaining,
      listings: held(),
      agents: standing.agents,
    });
  } finally {
    store.close();
  }
}
