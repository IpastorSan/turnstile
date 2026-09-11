// Which key a verification is stored under, against the real schema.
//
// The bug this pins (MOV-277): the first real proof, 2026-09-11, was stored
// under `liquidity.turnstile.eth`, while the market joins world_verification
// on the ERC-8004 agent uid. The proof was valid and the market still said
// `unknown`. These tests build graph/sink/schema.sql rather than a stub table,
// because the join in `agent_current` is the thing that has to see the row.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { SCHEMA_PATH } from '../graph/sink/db.ts';
import { findSellers } from '../seller/service/discovery.ts';
import {
  canonicalAgentUid,
  describeListing,
  nameKeyedVerifications,
  registeredListings,
  rekeyVerification,
} from './canonical.ts';
import { LISTINGS_PER_HUMAN } from './limits.ts';
import { mayClaim, recordVerification, standingFor } from './store.ts';

const UID = 'eip155:11155111:0x8004a818bfb912233c491871b3d84c89a494bd9e/10127';
const NAME = 'liquidity.turnstile.eth';
const HUMAN = '0x02d021c7c2f4-test-nullifier';

function store(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  db.prepare(`
    INSERT INTO agent (agent_uid, namespace, chain_id, network, registry, agent_id,
      owner, operator, operator_source, agent_uri, uri_scheme, in_module_resolved,
      last_event, block_number, block_timestamp, transaction_hash, log_index,
      first_seen_block, first_seen_timestamp)
    VALUES (?, 'eip155', 11155111, 'sepolia', '0x8004a818bfb912233c491871b3d84c89a494bd9e', '10127',
      '0xown', '0xop', 'OWNER_DEFAULT', ?, 'OTHER', 0,
      'REGISTERED', 1, 1, '0xtx', 0, 1, 1)
  `).run(UID, NAME);
  db.prepare(`
    INSERT INTO turnstile_seller (ens_name, node, resolver, chain_id, agent_uid, price, read_at)
    VALUES (?, '0xnode', '0xresolver', 11155111, ?, '0.01', 1)
  `).run(NAME, UID);
  return db;
}

function marketState(db: DatabaseSync): string {
  const row = db.prepare('SELECT world_verification FROM agent_current WHERE agent_uid = ?').get(UID) as { world_verification: string };
  return row.world_verification;
}

test('a registered ENS name resolves to its agent uid, not to itself', () => {
  const resolved = canonicalAgentUid(store(), NAME);
  assert.deepEqual(resolved, { ok: true, input: NAME, kind: 'agent', key: UID, ensName: NAME });
});

test('case and a trailing dot do not change the key', () => {
  const resolved = canonicalAgentUid(store(), ' Liquidity.Turnstile.ETH. ');
  assert.equal(resolved.ok && resolved.key, UID);
});

test('an agent uid resolves to itself, spelled as the store spells it', () => {
  const resolved = canonicalAgentUid(store(), UID.toUpperCase().replace('EIP155', 'eip155'));
  assert.equal(resolved.ok && resolved.kind, 'agent');
  assert.equal(resolved.ok && resolved.key, UID);
  assert.equal(resolved.ok && resolved.ensName, NAME);
});

test('an unregistered turnstile.eth subname is a reservation keyed by the name', () => {
  const resolved = canonicalAgentUid(store(), 'Depth.turnstile.eth');
  assert.deepEqual(resolved, { ok: true, input: 'Depth.turnstile.eth', kind: 'reservation', key: 'depth.turnstile.eth', ensName: 'depth.turnstile.eth' });
});

test('names outside turnstile.eth, nested names, and the parent itself are refused', () => {
  const db = store();
  for (const input of ['vitalik.eth', 'turnstile.eth', 'a.b.turnstile.eth', '-bad.turnstile.eth', 'liquidity.turnstile.eth.evil.eth', '']) {
    const resolved = canonicalAgentUid(db, input);
    assert.equal(resolved.ok, false, `${input} should be refused`);
    assert.equal(!resolved.ok && resolved.code, 'not_a_listing');
  }
});

test('an agent uid the store has never seen is refused, not reserved', () => {
  const resolved = canonicalAgentUid(store(), 'eip155:1:0x8004a818bfb912233c491871b3d84c89a494bd9e/999999');
  assert.equal(resolved.ok, false);
  assert.equal(!resolved.ok && resolved.code, 'unknown_agent');
});

test('the market reports verified once the proof is stored under the canonical key', () => {
  const db = store();
  assert.equal(marketState(db), 'unknown');

  const resolved = canonicalAgentUid(db, NAME);
  assert.ok(resolved.ok);
  recordVerification(db, { agentUid: resolved.key, nullifier: HUMAN });

  assert.equal(marketState(db), 'verified');
  const seller = findSellers(db, { turnstileOnly: true }).sellers.find(s => s.agentUid === UID);
  assert.equal(seller?.worldVerification, 'verified');
});

test('the 2026-09-11 bug, reproduced: a row keyed by the ENS name is invisible to the market', () => {
  const db = store();
  recordVerification(db, { agentUid: NAME, nullifier: HUMAN, at: 1789117562 });
  assert.equal(marketState(db), 'unknown');
});

test('rekey moves the name-keyed row onto the uid, and the market then sees it', () => {
  const db = store();
  recordVerification(db, { agentUid: NAME, nullifier: HUMAN, at: 1789117562 });

  assert.deepEqual(rekeyVerification(db, NAME), { status: 'rekeyed', from: NAME, to: UID });
  assert.equal(marketState(db), 'verified');
  const row = db.prepare('SELECT nullifier, verified_at FROM world_verification WHERE agent_uid = ?').get(UID) as Record<string, unknown>;
  assert.equal(row['nullifier'], HUMAN);
  assert.equal(row['verified_at'], 1789117562, 'the original verification time is kept');
  assert.deepEqual(nameKeyedVerifications(db), []);
});

test('rekey is idempotent', () => {
  const db = store();
  recordVerification(db, { agentUid: NAME, nullifier: HUMAN });
  rekeyVerification(db, NAME);
  assert.deepEqual(rekeyVerification(db, NAME), { status: 'already_canonical', from: NAME, to: UID });
});

test('rekey refuses when the uid already has a row, and changes nothing', () => {
  const db = store();
  recordVerification(db, { agentUid: NAME, nullifier: HUMAN, at: 1 });
  recordVerification(db, { agentUid: UID, nullifier: '0xsomeone-else', at: 2 });

  const outcome = rekeyVerification(db, NAME);
  assert.equal(outcome.status, 'conflict');
  const count = db.prepare('SELECT COUNT(*) AS n FROM world_verification').get() as { n: number };
  assert.equal(count.n, 2);
});

test('rekey leaves a reservation alone while its name is unregistered', () => {
  const db = store();
  recordVerification(db, { agentUid: 'depth.turnstile.eth', nullifier: HUMAN });
  assert.equal(rekeyVerification(db, 'depth.turnstile.eth').status, 'not_registered');
  assert.deepEqual(nameKeyedVerifications(db), ['depth.turnstile.eth']);
});

test('reservations count against the cap: one registered listing plus two reservations, and the fourth is refused', () => {
  const db = store();
  const picks = [NAME, 'depth.turnstile.eth', 'routing.turnstile.eth'];
  for (const pick of picks) {
    const resolved = canonicalAgentUid(db, pick);
    assert.ok(resolved.ok);
    assert.equal(mayClaim(db, HUMAN, resolved.key).allowed, true, `${pick} should be allowed`);
    recordVerification(db, { agentUid: resolved.key, nullifier: HUMAN });
  }
  assert.equal(standingFor(db, HUMAN).used, LISTINGS_PER_HUMAN);

  const fourth = canonicalAgentUid(db, 'fees.turnstile.eth');
  assert.ok(fourth.ok);
  const refused = mayClaim(db, HUMAN, fourth.key);
  assert.equal(refused.allowed, false);
  assert.equal(refused.code, 'listing_limit_reached');

  const held = standingFor(db, HUMAN).agents.map(key => describeListing(db, key));
  assert.deepEqual(held, [
    { key: UID, kind: 'agent', ensName: NAME },
    { key: 'depth.turnstile.eth', kind: 'reservation', ensName: 'depth.turnstile.eth' },
    { key: 'routing.turnstile.eth', kind: 'reservation', ensName: 'routing.turnstile.eth' },
  ]);
});

test('the picker lists registered turnstile.eth listings from the store', () => {
  const db = store();
  db.prepare(`
    INSERT INTO turnstile_seller (ens_name, node, resolver, chain_id, agent_uid, read_at)
    VALUES ('pending.turnstile.eth', '0xn2', '0xr', 11155111, NULL, 1)
  `).run();
  assert.deepEqual(registeredListings(db), [{ ensName: NAME, agentUid: UID }]);
});
