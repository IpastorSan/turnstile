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

  const rows: { family: string; key: string; values: string[]; note?: string }[] = [
    {
      family: 'wallet',
      key: 'organization wallet',
      values: [m.walletAddress],
      note: `Privy id ${m.walletId}. This is the warm tier: it holds the funds an agent draws on, and it is not the agent's key.`,
    },
    {
      family: 'quorum',
      key: 'operations quorum',
      values: [m.ownerId ?? m.opsQuorumId],
      note: `Owns the wallet. Signing a transaction needs its threshold, one of ${m.operators.length}.`,
    },
    {
      family: 'quorum',
      key: 'board quorum',
      values: [m.policyOwnerId ?? m.boardQuorumId],
      note: `Owns the policy. Raising the cap needs this quorum and not the one above, at two of ${m.operators.length}. Two different groups on purpose: the people who can spend are not the people who can decide how much.`,
    },
    {
      family: 'policy',
      key: m.policyName,
      values: [m.policyId],
      note:
        m.rules.length > 0
          ? `Allows ${m.rules.length === 1 ? 'one call' : `${m.rules.length} calls`}, listed below the table.`
          : undefined,
    },
    {
      family: 'allowlist',
      key: 'sellers this mandate may pay',
      values: [...m.sellerAllowlist],
      note: 'An agent holding this mandate cannot pay anyone else, on either rail.',
    },
  ];

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
        The market page shows what is for sale. This is the other side: what a buyer&rsquo;s agent
        is allowed to spend, and who decides. An organization wallet authorises an agent up to a
        cap, on named rails, without ever handing it the key that set the cap.
      </p>

      <div className="price-band">
        <div className="band-cell is-price">
          <p className="band-label">Spend cap</p>
          <p className="band-value">{m.spendCapUsd === null ? 'unreadable' : `$${m.spendCapUsd}`}</p>
          <p className="band-sub">
            Read off the live policy, not from a literal in the code. The code&rsquo;s default is
            $0.25; a quorum raised it, and this is what the policy says now.
          </p>
        </div>
        <div className="band-cell">
          <p className="band-label">Max per query</p>
          <p className="band-value">${m.maxPerQueryUsd}</p>
          <p className="band-sub">Enforced by the agent before it pays, in `buyer/mandate/`.</p>
        </div>
        <div className="band-cell">
          <p className="band-label">Rails</p>
          <p className="band-value">{m.railPreference.length}</p>
          <p className="band-sub">{m.railPreference.join(' · ')}</p>
        </div>
      </div>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Who may authorise what</h2>
          <p className="results-count">{m.operators.length} operators</p>
        </div>
        <p className="section-note">
          Every value below was fetched from Privy when this page was requested. The two quorum ids
          differ, and that difference is the control: it is what stops the agent, or any one human,
          from widening its own limit.
        </p>
        <ul className="records">
          {rows.map(row => (
            <li className="record" key={row.key}>
              <div>
                <span className="record-family">{row.family}</span>
                <div className="record-key">{row.key}</div>
              </div>
              <div>
                {row.values.map(value => (
                  <p className="record-value" key={value}>
                    {value}
                  </p>
                ))}
                {row.note ? <p className="record-note">{row.note}</p> : null}
              </div>
            </li>
          ))}
        </ul>

        {m.rules.length > 0 ? (
          <ul className="rule-list">
            {m.rules.map(rule => (
              <li key={rule.name}>
                <span className="allow">ALLOW</span> {rule.name}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Prove the quorum is real</h2>
        </div>
        <p className="section-note">
          Everything above is a claim until something is refused. This asks Privy to raise the cap
          with one operator&rsquo;s signature against a threshold of two. It is meant to fail, and
          the failure is the evidence.
        </p>
        <QuorumProbe />
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">What this page does not do</h2>
        </div>
        <p className="section-note">
          It does not issue a mandate and it does not raise a cap. Both need operator signatures,
          and a server holding enough keys to do either from a browser would defeat the property
          this page exists to show. That flow is{' '}
          <span className="mono">npm run privy:mandate</span>, which issues the mandate, funds the
          agent through <span className="mono">depositFor</span>, and shows the same refusal
          followed by a two-signature success.
        </p>
        <p className="section-note">
          <Link href="/">← The market page is live, and reads real registrations.</Link>
        </p>
      </section>
    </div>
  );
}
