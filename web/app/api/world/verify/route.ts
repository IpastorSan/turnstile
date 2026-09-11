// Verify a Selfie Check proof, then decide whether this human may list.
//
// Order matters and is the whole control:
//
//   1. Ask the Developer Portal whether the proof is cryptographically valid.
//      A client saying "I verified" is a client marking its own homework.
//   2. Take the nullifier from the *verified* response, never from the request
//      body. Trusting a client-supplied nullifier would let anyone claim to be
//      any human, which is precisely the attack this is meant to stop.
//   3. Count how many listings that human already holds and refuse the fourth.
//
// The proof is forwarded to World as-is. Their docs are explicit that fields
// must not be remapped, and tidying an untidy payload is the obvious mistake.

import { NextRequest } from 'next/server';

import { mayClaim, recordVerification, standingFor, verifyProof, worldConfigFromEnv, worldIsConfigured } from '../../../../../identity/index.ts';
import { openDiscoveryStore } from '../../../../lib/discovery.ts';
import { WORLD_VERIFY, rateLimit } from '../../../../lib/rate-limit.ts';

export const dynamic = 'force-dynamic';

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

  let body: { agentUid?: unknown; proof?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, reason: 'the request body was not JSON' }, { status: 400 });
  }

  const agentUid = typeof body.agentUid === 'string' ? body.agentUid.trim() : '';
  if (!agentUid) {
    return Response.json({ ok: false, reason: 'agentUid is required — a proof has to be bound to the listing it authorises' }, { status: 400 });
  }
  if (!body.proof) {
    return Response.json({ ok: false, reason: 'proof is required' }, { status: 400 });
  }

  const config = worldConfigFromEnv();
  const outcome = await verifyProof(config, body.proof);
  if (!outcome.ok) {
    return Response.json({ ok: false, verified: false, reason: outcome.reason, status: outcome.status }, { status: 400 });
  }

  const { nullifier } = outcome.proof;

  const store = openDiscoveryStore({ readOnly: false });
  if (!store.ok) {
    return Response.json(
      { ok: false, verified: true, reason: `the proof is valid but it could not be recorded: ${store.reason}` },
      { status: 503 },
    );
  }

  try {
    const allowance = mayClaim(store.db, nullifier, agentUid);
    if (!allowance.allowed) {
      // Recorded as rejected. A refused attempt is part of the audit trail, and
      // a rejected row deliberately does not consume anyone's allowance.
      recordVerification(store.db, { agentUid, nullifier, status: 'rejected', proofRef: allowance.code ?? 'refused' });
      return Response.json(
        { ok: false, verified: true, allowed: false, reason: allowance.detail, code: allowance.code, used: allowance.used, limit: allowance.limit },
        { status: 409 },
      );
    }

    recordVerification(store.db, { agentUid, nullifier, status: 'verified' });
    const standing = standingFor(store.db, nullifier);
    return Response.json({
      ok: true,
      verified: true,
      allowed: true,
      // Never the nullifier itself: it is a stable per-app pseudonym, and
      // handing it back to the browser lets anyone correlate listings to a
      // person outside our own store.
      used: standing.used,
      limit: standing.allowance.limit,
      remaining: standing.allowance.remaining,
      agents: standing.agents,
    });
  } finally {
    store.close();
  }
}
