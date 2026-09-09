import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { operatorIsVerified, operatorStanding } from './operator.ts';
import { recordVerification } from './store.ts';

function db(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec(`CREATE TABLE world_verification (
    agent_uid TEXT PRIMARY KEY, status TEXT NOT NULL, nullifier TEXT, proof_ref TEXT, verified_at INTEGER NOT NULL
  );`);
  return database;
}

test('an agent nobody has verified is unknown, not unverified', () => {
  // The distinction matters in the UI: 197 agents in the registry are not ours
  // to verify, and rendering them as "unverified" accuses them of failing a
  // test they were never given.
  assert.equal(operatorStanding(db(), 'stranger'), 'unknown');
});

test('unknown collapses to false for the gate', () => {
  // And it must, for the opposite reason: a mandate that refuses what it cannot
  // check is a control. One that treats silence as consent is decoration.
  assert.equal(operatorIsVerified(db(), 'stranger'), false);
});

test('a verified agent passes the gate', () => {
  const database = db();
  recordVerification(database, { agentUid: 'ours', nullifier: '0xn' });
  assert.equal(operatorStanding(database, 'ours'), 'verified');
  assert.equal(operatorIsVerified(database, 'ours'), true);
});

test('a rejected agent fails the gate and is distinguishable from unknown', () => {
  const database = db();
  recordVerification(database, { agentUid: 'over-limit', nullifier: '0xn', status: 'rejected' });
  assert.equal(operatorStanding(database, 'over-limit'), 'rejected');
  assert.equal(operatorIsVerified(database, 'over-limit'), false);
});
