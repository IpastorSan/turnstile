import Link from 'next/link';

import { QuorumProbe } from './QuorumProbe.tsx';
import type { MandateRead } from '../lib/mandate.ts';
import type { SpendState } from '../lib/spend.ts';
import { shortAddress } from '../lib/price.ts';

/**
 * The mandate, rendered.
 *
 * Shared by `/mandate` (the organization in `.env`) and `/mandate/<walletId>`
 * (anyone's). The two differ in exactly two ways, both passed in rather than
 * detected here:
 *
 *   `spend`  settled payments belong to OUR agent. Showing them under someone
 *            else's mandate would attribute our spending to them, so it is null
 *            for any organization but the demo one.
 *   `probe`  the cap-raise attempt signs with an operator key from `.env`. We
 *            hold no keys for a browser-created org, so there is nothing to
 *            attempt and the section is omitted rather than shown broken.
 */
export function MandateView({
  read,
  spend,
  probe = false,
}: {
  read: MandateRead;
  spend: SpendState | null;
  probe?: boolean;
}) {
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
  const shown = spend ? spend.payments.slice(0, 12) : [];

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
            $0.25, and a quorum can move it; this is what the policy actually says right now.
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
        {spend ? (
          <div className="band-cell">
            <p className="band-label">Settled to date</p>
            <p className="band-value">${spend.totalUsd.toFixed(4)}</p>
            <p className="band-sub">
              {spend.totalCount} payments that actually moved money, on both rails. Not a balance
              against the cap above — see below.
            </p>
          </div>
        ) : null}
      </div>

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Who may authorise what</h2>
          <p className="results-count">{m.operators.length > 0 ? `${m.operators.length} operators` : 'quorum members not listed'}</p>
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

      {spend ? (
      <section className="section">
        <div className="section-head">
          <h2 className="section-title">What it has actually spent</h2>
          <p className="results-count">
            {spend.totalCount} settled · ${spend.totalUsd.toFixed(4)}
          </p>
        </div>
        <p className="section-note">
          Everything above is permission. This is what the agent did with it. Neither rail is read
          from a database of ours: Hedera receipts come off a public consensus topic through the
          mirror node, and Arc settlements come from Circle Gateway&rsquo;s transfers API queried by
          the agent&rsquo;s own address.
        </p>

        <ul className="records">
          {spend.rails.map(rail => (
            <li className="record" key={rail.railId}>
              <div>
                <span className="record-family">{rail.railId}</span>
                <div className="record-key">{rail.label}</div>
              </div>
              <div>
                <p className={`record-value${rail.error ? ' is-unset' : ''}`}>
                  {rail.error ? 'could not be read' : `${rail.count} settled · $${(rail.usd ?? 0).toFixed(6)}`}
                </p>
                <p className="record-note">{rail.error ?? rail.source}</p>
              </div>
            </li>
          ))}
        </ul>

        <p className="section-note">
          <b>This is not a running balance against the cap.</b> ${spend.totalUsd.toFixed(4)} settled
          and a ${m.spendCapUsd ?? '?'} cap are two true numbers that do not subtract from each
          other: these payments span several runs, and a quorum raised the cap partway through.
          Presenting them as one ledger would be a tidier story and a false one. Per-run enforcement
          lives in <span className="mono">buyer/mandate/</span>, where the agent refuses before it
          pays.
          {spend.topicIsOpen && spend.topic ? (
            <>
              {' '}
              Topic <span className="mono">{spend.topic}</span> has <b>no submit key</b>, so anyone
              may append to it and a receipt is a claim until checked against the ledger.{' '}
              <span className="mono">npm run mcp</span>&rsquo;s <span className="mono">receipts</span>{' '}
              tool does that check.
            </>
          ) : null}
        </p>

        {shown.length > 0 ? (
          <ul className="payments">
            {shown.map(payment => (
              <li className="payment" key={payment.reference + payment.at}>
                <span className="payment-rail">{payment.railId}</span>
                <span className="payment-usd">
                  {payment.usd === null ? '—' : `$${payment.usd.toFixed(6)}`}
                </span>
                <span className="payment-amount">{payment.amount}</span>
                <span className="payment-at">{payment.at.replace('T', ' ').slice(0, 19)}</span>
                <span className="payment-ref">
                  {payment.href ? (
                    <a href={payment.href} target="_blank" rel="noreferrer">
                      {payment.reference.length > 26
                        ? `${payment.reference.slice(0, 12)}…${payment.reference.slice(-8)}`
                        : payment.reference}
                    </a>
                  ) : (
                    payment.reference
                  )}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {spend.payments.length > shown.length ? (
          <p className="section-note">
            {spend.payments.length - shown.length} older payments not listed. All of them are on the
            topic and in the Gateway API.
          </p>
        ) : null}
      </section>
      ) : null}

      {probe ? (
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
      ) : null}

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
          <Link href="/mandate/new">Create your own mandate →</Link> Its operator keys are generated
          in your browser and never sent here, so the organization is yours whether you run it on
          this deployment or your own.
        </p>
        <p className="section-note">
          <Link href="/">← The market page is live, and reads real registrations.</Link>
        </p>
      </section>
    </div>
  );
}
