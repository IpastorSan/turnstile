'use client';

import Link from 'next/link';
import { useState } from 'react';

import { generateBrowserKey, type BrowserKeyPair } from '../lib/browser-key.ts';

interface OperatorDraft {
  handle: string;
  role: string;
  email: string;
}

interface Created {
  orgName: string;
  walletId: string;
  walletAddress: string;
  opsQuorumId: string;
  boardQuorumId: string;
  policyId: string;
  policyName: string;
  capUsd: number;
  agentAddress: string;
  operators: { handle: string; role: string; userId: string; walletAddress: string }[];
}

const DEFAULT_OPERATORS: OperatorDraft[] = [
  { handle: 'alice', role: 'CFO', email: '' },
  { handle: 'bob', role: 'Head of Research', email: '' },
];

export function CreateMandate() {
  const [orgName, setOrgName] = useState('');
  const [capUsd, setCapUsd] = useState('1');
  const [operators, setOperators] = useState<OperatorDraft[]>(DEFAULT_OPERATORS);
  const [keys, setKeys] = useState<BrowserKeyPair[] | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function update(index: number, field: keyof OperatorDraft, value: string) {
    setOperators(current => current.map((op, i) => (i === index ? { ...op, [field]: value } : op)));
  }

  async function create() {
    setBusy(true);
    setError(null);
    try {
      // The keys are made here, in this tab. Nothing below sends the private
      // half: the request body is built from `publicKey` only, and the server
      // refuses outright if it ever receives a `privateKey` field.
      const generated = await Promise.all(operators.map(() => generateBrowserKey()));
      setKeys(generated);

      const response = await fetch('/api/org/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          orgName: orgName || undefined,
          capUsd: Number(capUsd),
          operators: operators.map((op, i) => ({
            handle: op.handle,
            role: op.role,
            email: op.email,
            publicKey: generated[i]!.publicKey,
          })),
        }),
      });

      const body = await response.json();
      if (!body.ok) {
        setError(body.reason ?? 'the organization could not be created');
        return;
      }
      setCreated(body as Created);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (created && keys) {
    const env = [
      `PRIVY_APP_ID=${'<your app id, or ours if you are hosted here>'}`,
      `PRIVY_APP_SECRET=${'<your app secret — never commit this>'}`,
      `PRIVY_ORG_WALLET_ID=${created.walletId}`,
      `PRIVY_ORG_WALLET_ADDRESS=${created.walletAddress}`,
      `PRIVY_OPS_QUORUM_ID=${created.opsQuorumId}`,
      `PRIVY_BOARD_QUORUM_ID=${created.boardQuorumId}`,
      `PRIVY_MANDATE_POLICY_ID=${created.policyId}`,
      ...created.operators.flatMap((operator, i) => [
        `PRIVY_OPERATOR_${operator.handle.toUpperCase()}_KEY=${keys[i]!.privateKey}`,
        `PRIVY_OPERATOR_${operator.handle.toUpperCase()}_USER_ID=${operator.userId}`,
        `PRIVY_OPERATOR_${operator.handle.toUpperCase()}_WALLET=${operator.walletAddress}`,
      ]),
    ].join('\n');

    return (
      <div className="created">
        <p className="created-lede">
          <b>{created.orgName}</b> exists. Its wallet is{' '}
          <span className="mono">{created.walletAddress}</span>, owned by a 1-of-
          {created.operators.length} operations quorum, and its ${created.capUsd} cap is governed by
          a separate 2-of-{created.operators.length} board quorum.
        </p>

        <div className="warn-block">
          <b>These private keys exist only in this tab.</b> They were generated here and never sent
          to the server, so nobody can send them to you again. Copy them now. Lose them and the
          organization above is unreachable: the quorums are built from the matching public keys,
          and there is no reset.
        </div>

        <label className="env-label" htmlFor="envblock">
          Your <span className="mono">.env</span> block
        </label>
        <textarea id="envblock" className="env-block" readOnly rows={14} value={env} spellCheck={false} />

        <div className="created-actions">
          <button
            className="probe-button"
            onClick={() => navigator.clipboard?.writeText(env)}
          >
            Copy the .env block
          </button>
          <Link className="probe-button" href={`/mandate/${created.walletId}`}>
            View this organization →
          </Link>
        </div>

        <p className="probe-note">
          To run it yourself rather than here, paste that into a checkout of the repo with your own{' '}
          <span className="mono">PRIVY_APP_ID</span> and{' '}
          <span className="mono">PRIVY_APP_SECRET</span>, then{' '}
          <span className="mono">npm run privy:mandate</span>. Nothing about this organization
          depends on this site staying up.
        </p>
      </div>
    );
  }

  return (
    <div className="create-form">
      <div className="field-row">
        <label className="field">
          <span className="field-label">Organization name</span>
          <input
            className="field-input"
            value={orgName}
            placeholder="Turnstile buyer org"
            onChange={event => setOrgName(event.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">Spend cap, USD</span>
          <input
            className="field-input"
            value={capUsd}
            inputMode="decimal"
            onChange={event => setCapUsd(event.target.value)}
          />
        </label>
      </div>

      <p className="field-note">
        Two operators minimum. Funding the agent takes one signature; raising the cap takes two.
        That asymmetry is the only thing standing between an agent and its own spending limit, so
        one operator is not offered.
      </p>

      {operators.map((operator, index) => (
        <div className="field-row" key={index}>
          <label className="field">
            <span className="field-label">Handle</span>
            <input
              className="field-input"
              value={operator.handle}
              onChange={event => update(index, 'handle', event.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">Role</span>
            <input
              className="field-input"
              value={operator.role}
              onChange={event => update(index, 'role', event.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">Email</span>
            <input
              className="field-input"
              value={operator.email}
              placeholder="alice@example.com"
              onChange={event => update(index, 'email', event.target.value)}
            />
          </label>
        </div>
      ))}

      <div className="created-actions">
        {operators.length < 5 ? (
          <button
            className="probe-button"
            onClick={() => setOperators(current => [...current, { handle: '', role: 'operator', email: '' }])}
          >
            Add an operator
          </button>
        ) : null}
        <button className="probe-button" onClick={create} disabled={busy || operators.some(op => !op.email.includes('@'))}>
          {busy ? 'creating…' : 'Generate keys here and create the organization'}
        </button>
      </div>

      {error ? <p className="probe-result is-bad">{error}</p> : null}

      <p className="probe-note">
        Your operators&rsquo; signing keys are generated by your browser and stay in this tab. Only
        the public halves are sent, which is all a Privy key quorum consumes. The server refuses the
        request outright if a private key ever appears in it.
      </p>
    </div>
  );
}
