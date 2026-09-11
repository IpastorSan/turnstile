'use client';

import { useState } from 'react';

import { isListingName } from '../../identity/canonical.ts';
import { SelfieCheck, type HeldListing, type Outcome } from './SelfieCheck.tsx';

/**
 * Pick which listing a Selfie Check proof is for.
 *
 * The options come from the discovery store, not from this file: every
 * turnstile.eth name linked to a registered ERC-8004 agent, plus any other
 * subname typed in, which is a reservation. A reservation counts against the
 * human's listings like a registered one does, which is what lets the cap be
 * shown without registering four agents first.
 *
 * The page only suggests how a name will be stored. The verify route decides,
 * from the store, and its answer is what the standing below shows.
 */

interface Registered {
  ensName: string;
  agentUid: string;
}

interface Attempt {
  listing: string;
  outcome: Outcome;
}

const CUSTOM = '__custom__';

function shortUid(uid: string): string {
  const [prefix, id] = uid.split('/');
  return prefix && id ? `${prefix.slice(0, 22)}…/${id}` : uid;
}

function describe(held: HeldListing): string {
  return held.kind === 'agent' ? `registered agent ${shortUid(held.key)}` : 'reservation, not registered on chain yet';
}

export function ListingPicker({ registered, parent, limit }: { registered: Registered[]; parent: string; limit: number }) {
  const [choice, setChoice] = useState<string>(registered[0]?.ensName ?? CUSTOM);
  const [label, setLabel] = useState('');
  const [attempts, setAttempts] = useState<Attempt[]>([]);

  const typed = `${label.trim().toLowerCase()}.${parent}`;
  const listing = choice === CUSTOM ? (isListingName(typed) ? typed : '') : choice;
  const match = registered.find(entry => entry.ensName.toLowerCase() === listing);

  // The standing is whatever the server said last. A refusal carries it too.
  const latest = [...attempts].reverse().find(a => a.outcome.kind !== 'error')?.outcome;
  const standing = latest && latest.kind !== 'error' && latest.used !== undefined ? latest : null;

  return (
    <div className="listing-picker">
      <fieldset className="listing-options">
        <legend className="field-label">Which listing is this proof for</legend>
        {registered.map(entry => (
          <label className="check listing-option" key={entry.ensName}>
            <input type="radio" name="listing" checked={choice === entry.ensName} onChange={() => setChoice(entry.ensName)} />
            <span className="mono">{entry.ensName}</span>
            <span className="listing-kind">registered agent {shortUid(entry.agentUid)}</span>
          </label>
        ))}
        <label className="check listing-option">
          <input type="radio" name="listing" checked={choice === CUSTOM} onChange={() => setChoice(CUSTOM)} />
          <span>Another name under {parent}</span>
          <span className="listing-kind">reservation</span>
        </label>
      </fieldset>

      {choice === CUSTOM ? (
        <label className="field listing-custom">
          <span className="field-label">Subname</span>
          <span className="listing-custom-row">
            <input
              className="field-input"
              value={label}
              onChange={event => setLabel(event.target.value)}
              placeholder="depth"
              spellCheck={false}
              autoComplete="off"
            />
            <span className="mono listing-suffix">.{parent}</span>
          </span>
        </label>
      ) : null}

      {registered.length === 0 ? (
        <p className="field-note">
          The discovery store on this deployment lists no registered {parent} agents, so only
          reservations can be verified here.
        </p>
      ) : null}

      {listing ? (
        <>
          <p className="field-note">
            {match ? (
              <>
                <span className="mono">{listing}</span> is a registered listing. The proof is stored under its
                agent id, <span className="mono">{match.agentUid}</span>, which is the key the market page reads.
              </>
            ) : (
              <>
                <span className="mono">{listing}</span> is not registered as an agent, so it is a{' '}
                <b>reservation</b>: stored under the ENS name, counted against your {limit} listings, and moved
                to the agent id once the name is registered.
              </>
            )}
          </p>
          <SelfieCheck
            key={listing}
            listing={listing}
            onOutcome={outcome => setAttempts(previous => [...previous, { listing, outcome }])}
          />
        </>
      ) : (
        <p className="probe-result is-bad">
          A listing is one label directly under {parent}: lowercase letters, digits and hyphens.
        </p>
      )}

      {standing ? (
        <div className="standing">
          <p className="standing-count">
            <b>
              {standing.used} of {standing.limit ?? limit}
            </b>{' '}
            listings used by this human
          </p>
          {standing.listings && standing.listings.length > 0 ? (
            <ul className="standing-list">
              {standing.listings.map(held => (
                <li key={held.key}>
                  <span className="mono">{held.ensName ?? held.key}</span>
                  <span className="listing-kind">{describe(held)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {attempts.length > 0 ? (
        <ol className="attempts">
          {attempts.map((attempt, index) => (
            <li key={index} className={attempt.outcome.kind === 'verified' ? 'is-good' : 'is-bad'}>
              <span className="mono">{attempt.listing}</span>
              <span>
                {attempt.outcome.kind === 'verified'
                  ? `verified as ${attempt.outcome.stored.kind === 'agent' ? 'a registered listing' : 'a reservation'}`
                  : attempt.outcome.kind === 'refused'
                    ? `refused${attempt.outcome.code ? ` (${attempt.outcome.code})` : ''}: ${attempt.outcome.reason}`
                    : `error: ${attempt.outcome.reason}`}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
