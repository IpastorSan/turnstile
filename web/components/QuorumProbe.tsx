'use client';

import { useState } from 'react';

type Result =
  | { kind: 'refused'; status: number; detail: string }
  | { kind: 'error'; reason: string }
  | { kind: 'unexpected'; reason: string };

/**
 * The one button on this page that changes anything, and it is expected to be
 * told no. It asks the server to propose a cap raise carrying a single operator
 * signature against a quorum whose threshold is two.
 *
 * A refusal is the success state, so it is styled as one. An acceptance is
 * rendered as a failure, because it would mean the control this page documents
 * is not actually enforced.
 */
export function QuorumProbe() {
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);

  async function attempt() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch('/api/mandate/raise-cap', { method: 'POST' });
      const body = await res.json();
      if (body.refused) setResult({ kind: 'refused', status: body.status, detail: body.detail });
      else if (body.unexpected) setResult({ kind: 'unexpected', reason: body.reason });
      else setResult({ kind: 'error', reason: body.reason ?? 'unknown failure' });
    } catch (error) {
      setResult({ kind: 'error', reason: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="probe">
      <button className="probe-button" onClick={attempt} disabled={busy}>
        {busy ? 'asking Privy…' : 'Attempt a cap raise with one signature'}
      </button>

      {result?.kind === 'refused' ? (
        <p className="probe-result is-good">
          <b>
            {result.status} {result.detail}
          </b>
          <br />
          Refused, which is the point. Alice proposed; the board quorum needs two signatures and
          this request carried one. The check ran inside Privy against registered public keys, not
          in this application.
        </p>
      ) : null}

      {result?.kind === 'unexpected' ? (
        <p className="probe-result is-bad">
          <b>Accepted, and it should not have been.</b>
          <br />
          {result.reason}
        </p>
      ) : null}

      {result?.kind === 'error' ? (
        <p className="probe-result is-bad">
          Could not reach the quorum: {result.reason}
        </p>
      ) : null}

      <p className="probe-note">
        This server never holds enough keys to succeed here. The second operator&rsquo;s key is not
        read by this route, so no request to it can raise the cap. The two-signature path is{' '}
        <span className="mono">npm run privy:mandate</span>, run on an operator&rsquo;s own machine.
      </p>
    </div>
  );
}
