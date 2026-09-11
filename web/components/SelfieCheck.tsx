'use client';

import { IDKitRequestWidget, selfieCheckLegacy } from '@worldcoin/idkit';
import { useState } from 'react';

/**
 * Prove there is one human behind a listing.
 *
 * This is not a login and does not sign anybody in. It answers one question,
 * is this the same person as that other listing, and the answer caps how much
 * of the registry one human may occupy. Three listings; the fourth is refused.
 *
 * Three things this component deliberately does not do:
 *
 *  - It never decides whether the proof is valid. `handleVerify` posts the whole
 *    IDKit result to our backend, which asks the Developer Portal. A client that
 *    judges its own proof is a client marking its own homework.
 *  - It never decides which key the proof is stored under. It sends the listing
 *    it signed (`listing`, the proof's signal) and the backend resolves that to
 *    the agent id the market reads (MOV-277).
 *  - It never sees the nullifier. The backend takes that from the *verified*
 *    response, counts against it, and returns only the tally. A nullifier is a
 *    stable per-app pseudonym, so handing it to the browser would let anyone
 *    correlate listings back to a person.
 */

interface Context {
  app_id: string;
  action: string;
  rp_context: Record<string, unknown>;
}

export interface HeldListing {
  key: string;
  kind: 'agent' | 'reservation';
  ensName: string | null;
}

export type Outcome =
  | { kind: 'verified'; used: number; limit: number; remaining: number; listings: HeldListing[]; stored: HeldListing & { note?: string } }
  | { kind: 'refused'; reason: string; code?: string; used?: number; limit?: number; listings?: HeldListing[] }
  | { kind: 'error'; reason: string };

export function SelfieCheck({ listing, onOutcome }: { listing: string; onOutcome?: (outcome: Outcome) => void }) {
  const [context, setContext] = useState<Context | null>(null);
  const [open, setOpen] = useState(false);
  const [outcome, setOutcomeState] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false);

  function setOutcome(next: Outcome) {
    setOutcomeState(next);
    onOutcome?.(next);
  }

  async function begin() {
    setBusy(true);
    setOutcomeState(null);
    try {
      // The context is signed by our backend, because the signing key is what
      // tells World the request is really from this app. A context a browser
      // could mint is one anybody could mint.
      const response = await fetch('/api/world/context', { method: 'POST' });
      const body = await response.json();
      if (!body.ok) {
        setOutcome({ kind: 'error', reason: body.reason });
        return;
      }
      setContext(body as Context);
      setOpen(true);
    } catch (error) {
      setOutcome({ kind: 'error', reason: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function handleVerify(result: unknown) {
    // Forwarded as-is. World's docs are explicit that fields must not be
    // remapped, and tidying an untidy payload is the obvious mistake to make.
    const response = await fetch('/api/world/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ listing, proof: result }),
    });
    const body = await response.json();

    if (body.ok) {
      setOutcome({
        kind: 'verified',
        used: body.used,
        limit: body.limit,
        remaining: body.remaining,
        listings: body.listings ?? [],
        stored: body.listing,
      });
      return;
    }

    setOutcome({
      kind: 'refused',
      reason: body.reason ?? 'the proof was not accepted',
      code: body.code,
      used: body.used,
      limit: body.limit,
      listings: body.listings,
    });
    // Throwing tells IDKit the verification failed, so the widget shows a
    // failure rather than a success the backend just rejected.
    throw new Error(body.reason ?? 'verification failed');
  }

  return (
    <div className="probe">
      <button className="probe-button" onClick={begin} disabled={busy}>
        {busy ? 'preparing…' : `Verify ${listing} with World Selfie Check`}
      </button>

      {context ? (
        <IDKitRequestWidget
          open={open}
          onOpenChange={setOpen}
          app_id={context.app_id as `app_${string}`}
          action={context.action}
          rp_context={context.rp_context as never}
          allow_legacy_proofs
          preset={selfieCheckLegacy({ signal: listing })}
          handleVerify={handleVerify}
          onSuccess={() => setOpen(false)}
        />
      ) : null}

      {outcome?.kind === 'verified' ? (
        <p className="probe-result is-good">
          <b>
            Verified · {outcome.used} of {outcome.limit} listings used
          </b>
          <br />
          {outcome.stored?.note ? `${outcome.stored.note}. ` : ''}
          One human is behind this listing, and {outcome.remaining === 0 ? 'no further listings' : `${outcome.remaining} more`}{' '}
          may be claimed by them. The proof was checked by World, not by this page.
        </p>
      ) : null}

      {outcome?.kind === 'refused' ? (
        <p className="probe-result is-bad">
          <b>
            Refused{outcome.code ? ` · ${outcome.code}` : ''}
            {outcome.used !== undefined ? ` · ${outcome.used} of ${outcome.limit} used` : ''}
          </b>
          <br />
          {outcome.reason}
        </p>
      ) : null}

      {outcome?.kind === 'error' ? <p className="probe-result is-bad">{outcome.reason}</p> : null}

      <p className="probe-note">
        Selfie Check is a <b>medium-assurance</b> credential: a device-camera liveness and facial
        similarity check. It is not an Orb verification and does not claim to be. It is enough to
        make holding two hundred listings expensive, which is the only thing it is used for here.
      </p>
    </div>
  );
}
