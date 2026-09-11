// The listing limit, against a real database rather than a mock.
//
// The rule itself is covered in limits.test.ts. What is checked here is the
// thing that only appears once rows exist: that "how many listings does this
// human hold" is a count over a shared nullifier, that a rejected attempt does
// not consume somebody's allowance, and that re-claiming an agent you already
// hold is free.

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { LISTINGS_PER_HUMAN } from './limits.ts';
import { mayClaim, recordVerification, standingFor, verificationFor } from './store.ts';

const ALICE = '0xalice-nullifier';
const BOB = '0xbob-nullifier';

function db(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  // The columns as graph/sink/schema.sql declares them, minus the foreign key,
  // which would need the whole agent table for a test about counting.
  database.exec(`CREATE TABLE world_verification (
    agent_uid TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    nullifier TEXT,
    proof_ref TEXT,
    verified_at INTEGER NOT NULL
  );`);
  return database;
}

test('three listings for one human, and the fourth is refused', () => {
  const database = db();
  for (let i = 1; i <= LISTINGS_PER_HUMAN; i += 1) {
    const allowance = mayClaim(database, ALICE, `agent-${i}`);
    assert.equal(allowance.allowed, true, `listing ${i} should be allowed`);
    recordVerification(database, { agentUid: `agent-${i}`, nullifier: ALICE });
  }

  const fourth = mayClaim(database, ALICE, 'agent-4');
  assert.equal(fourth.allowed, false);
  assert.equal(fourth.code, 'listing_limit_reached');
  assert.equal(standingFor(database, ALICE).used, LISTINGS_PER_HUMAN);
});

test('a different human has their own allowance', () => {
  // The Sybil control has to bind to the person, not to the key. If the count
  // were per-key, the whole thing would be defeated by generating keys.
  const database = db();
  for (let i = 1; i <= LISTINGS_PER_HUMAN; i += 1) {
    recordVerification(database, { agentUid: `alice-${i}`, nullifier: ALICE });
  }
  assert.equal(mayClaim(database, ALICE, 'alice-4').allowed, false);
  assert.equal(mayClaim(database, BOB, 'bob-1').allowed, true);
});

test('a rejected attempt does not consume an allowance', () => {
  const database = db();
  recordVerification(database, { agentUid: 'agent-1', nullifier: ALICE, status: 'rejected' });
  const standing = standingFor(database, ALICE);
  assert.equal(standing.used, 0, 'a rejected row is a record that someone tried, not a listing they hold');
  assert.equal(standing.allowance.allowed, true);
});

test('re-claiming an agent you already hold is free', () => {
  // Re-verifying after a key rotation must not cost an operator a listing they
  // already own, or rotating a key would silently shrink their allowance.
  const database = db();
  for (let i = 1; i <= LISTINGS_PER_HUMAN; i += 1) {
    recordVerification(database, { agentUid: `agent-${i}`, nullifier: ALICE });
  }
  assert.equal(mayClaim(database, ALICE, 'agent-2').allowed, true, 'already held');
  assert.equal(mayClaim(database, ALICE, 'agent-new').allowed, false, 'but a new one is still capped');
});

test('re-verifying the same agent updates the row rather than adding one', () => {
  const database = db();
  recordVerification(database, { agentUid: 'agent-1', nullifier: ALICE, proofRef: 'first', at: 100 });
  recordVerification(database, { agentUid: 'agent-1', nullifier: ALICE, proofRef: 'second', at: 200 });
  assert.equal(standingFor(database, ALICE).used, 1, 'one agent, one listing, however many times it verifies');
  const row = verificationFor(database, 'agent-1');
  assert.equal(row?.proofRef, 'second');
  assert.equal(row?.verifiedAt, 200);
});

test('an agent with no verification reads as absent, never as verified', () => {
  assert.equal(verificationFor(db(), 'agent-unknown'), null);
});

test('a listing another human already holds is refused, not taken over (MOV-277)', () => {
  // One row per listing: without this, Bob verifying Alice's listing would
  // overwrite her nullifier and move the listing into his allowance.
  const database = db();
  recordVerification(database, { agentUid: 'agent-1', nullifier: ALICE });
  const attempt = mayClaim(database, BOB, 'agent-1');
  assert.equal(attempt.allowed, false);
  assert.equal(attempt.code, 'listing_held_by_another_human');
});

test('a rejected attempt never overwrites a verified row (MOV-277)', () => {
  const database = db();
  recordVerification(database, { agentUid: 'agent-1', nullifier: ALICE, at: 100 });
  recordVerification(database, { agentUid: 'agent-1', nullifier: BOB, status: 'rejected', proofRef: 'listing_held_by_another_human', at: 200 });
  const row = verificationFor(database, 'agent-1');
  assert.equal(row?.status, 'verified');
  assert.equal(row?.nullifier, ALICE);
  assert.equal(row?.verifiedAt, 100);
});

test('a verified proof does replace an earlier rejected attempt', () => {
  const database = db();
  recordVerification(database, { agentUid: 'agent-1', nullifier: BOB, status: 'rejected', at: 100 });
  recordVerification(database, { agentUid: 'agent-1', nullifier: ALICE, at: 200 });
  assert.equal(verificationFor(database, 'agent-1')?.status, 'verified');
  assert.equal(verificationFor(database, 'agent-1')?.nullifier, ALICE);
});
