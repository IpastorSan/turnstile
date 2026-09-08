import Link from 'next/link';

import { QuorumProbe } from '../../components/QuorumProbe.tsx';
import { readMandate } from '../../lib/mandate.ts';
import { shortAddress } from '../../lib/price.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'The mandate · Turnstile' };

export default async function MandatePage() {
  const read = await readMandate();

  if (!read.ok) {
    return (
      <div className="wrap placeholder">
        <span className="placeholder-badge">Not read</span>
        <h1 className="placeholder-title">The mandate could not be read.</h1>
        <p className="placeholder-body">{read.reason}</p>
        <p className="placeholder-body">
          Nothing is faked in its place. The mandate either reads from Privy or this page says why
          it did not.
        </p>
        <p className="placeholder-body">
          <Link href="/">Back to the market</Link>
        </p>
      </div>
    );
  }

  const m = read.state;
  const arcscan = `https://testnet.arcscan.app/address/${m.walletAddress}`;

  return (
    <div className="wrap seller">
      <div className="seller-head">
        <div>
          <p className="eyebrow">The warm tier · read live from Privy</p>
          <h1 className="seller-name">The mandate</h1>
        </div>
        <p className="readout">
          org wallet{' '}
          <a href={arcscan} target="_blank" rel="noreferrer">
            {shortAddress(m.walletAddress)}
          </a>
          <br />
          {new Date(m.readAt).toISOString().replace('T', ' ').slice(0, 19)} UTC
        </p>
      </div>

      <p className="lede">
        An organization wallet authorises an agent to spend up to a cap, on named rails, without
        ever handing it the key that set the cap. Two separate quorums govern it: one owns the
        wallet, a different one owns the policy. That separation is the whole point, and it is
        enforced by Privy rather than by this application.
      </p>

      <div className="price-band">
        <div className="band-cell is-price">
          <span className="band-label">Spend cap</span>
          <span className="band-value">
            {m.spendCapUsd === null ? 'unreadable' : `$${m.spendCapUsd}`}
          </span>
          <span className="band-note">read off the live policy, not a literal in the code</span>
        </div>
        <div className="band-cell">
          <span className="band-label">Max per query</span>
          <span className="band-value">${m.maxPerQueryUsd}</span>
        </div>
        <div className="band-cell">
          <span className="band-label">Rails</span>
          <span className="band-value">{m.railPreference.join(', ')}</span>
        </div>
      </div>

      <h2 className="section-head">Who may authorise what</h2>
      <table className="records">
        <tbody>
          <tr>
            <th>Organization wallet</th>
            <td>
              <span className="mono">{m.walletAddress}</span>
              <br />
              Privy id <span className="mono">{m.walletId}</span>
            </td>
          </tr>
          <tr>
            <th>Operations quorum</th>
            <td>
              <span className="mono">{m.ownerId ?? m.opsQuorumId}</span> owns the wallet. Signing a
              transaction needs its threshold, which is one of {m.operators.length}.
            </td>
          </tr>
          <tr>
            <th>Board quorum</th>
            <td>
              <span className="mono">{m.policyOwnerId ?? m.boardQuorumId}</span> owns the policy.
              Raising the cap needs <b>this</b> quorum, not the one above, and its threshold is two
              of {m.operators.length}.
            </td>
          </tr>
          <tr>
            <th>Policy</th>
            <td>
              <span className="mono">{m.policyName}</span>
              <br />
              <span className="mono">{m.policyId}</span>
              {m.rules.length > 0 ? (
                <ul className="rule-list">
                  {m.rules.map(rule => (
                    <li key={rule.name}>
                      <span className="allow">ALLOW</span> {rule.name}
                    </li>
                  ))}
                </ul>
              ) : null}
            </td>
          </tr>
          <tr>
            <th>Operators</th>
            <td>
              {m.operators.map(op => (
                <div key={op.handle}>
                  <b>{op.handle}</b> — {op.role}
                  {op.walletAddress ? (
                    <>
                      {' '}
                      <span className="mono">{shortAddress(op.walletAddress)}</span>
                    </>
                  ) : null}
                </div>
              ))}
            </td>
          </tr>
          <tr>
            <th>Seller allowlist</th>
            <td>
              {m.sellerAllowlist.map(seller => (
                <div key={seller} className="mono">
                  {seller}
                </div>
              ))}
            </td>
          </tr>
        </tbody>
      </table>

      <h2 className="section-head">Prove the quorum is real</h2>
      <p className="placeholder-body">
        The invariant is that the hot key spends within the mandate and can never widen it. Raising
        a cap is a warm-tier action needing two humans; rotating a key or moving a payout address is
        a cold-tier one and cannot be done from here at all.
      </p>
      <QuorumProbe />

      <h2 className="section-head">What this page does not do</h2>
      <p className="placeholder-body">
        It does not issue a mandate, and it does not raise a cap. Both need operator signatures, and
        a server holding enough keys to do either from a browser would defeat the property the page
        exists to demonstrate. That flow is{' '}
        <span className="mono">npm run privy:mandate</span>, which issues the mandate, funds the
        agent through <span className="mono">depositFor</span>, and shows the same refusal followed
        by a two-signature success.
      </p>

      <p className="placeholder-body">
        <Link href="/">← The market page is live, and reads real registrations.</Link>
      </p>
    </div>
  );
}
