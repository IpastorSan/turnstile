// The one-time migration that removes world_verification's FK to agent.
//
// Live failure this reproduces: a real World Selfie Check verified fine with
// the Developer Portal, then our insert into `world_verification` died with
// FOREIGN KEY constraint failed, and /onboard returned 500 for every genuine
// proof (2026-09-11). The cause was a schema-level contradiction — the table
// required an `agent` row, and onboarding writes the verification *before*
// any registration exists — made unfixable-in-place by `CREATE TABLE IF NOT
// EXISTS` never editing the deployed volume's copy of the table.
//
// What the test pins down: the rebuild preserves data, keeps the views and
// indexes that reference the table (dropping a table with a dependent view
// and then renaming over it is the classic way to corrupt a schema), and is
// a no-op once migrated. It builds the real schema.sql rather than a stub
// precisely because the interaction with `seller_view` is the part at risk.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { migrateWorldVerificationFk, SCHEMA_PATH } from './db.ts';

/** A database in the OLD shape: real schema.sql, then FK re-added by hand. */
function legacyDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  // An agent row so the legacy FK is satisfiable for the seeded verification.
  db.prepare(`
    INSERT INTO agent (agent_uid, namespace, chain_id, network, registry, agent_id,
      owner, operator, operator_source, agent_uri, uri_scheme, in_module_resolved,
      last_event, block_number, block_timestamp, transaction_hash, log_index,
      first_seen_block, first_seen_timestamp)
    VALUES ('agent-known', 'eip8004', 1, 'eip155:1', '0xreg', '1',
      '0xown', '0xwal', 'OWNER_DEFAULT', '', 'EMPTY', 0,
      'REGISTERED', 1, 1, '0xtx', 0, 1, 1)
  `).run();
  // schema.sql no longer declares the FK, so replay the historical version.
  // Views survive because they reference the table by name, not by identity.
  db.exec(`
    DROP TABLE world_verification;
    CREATE TABLE world_verification (
      agent_uid    TEXT PRIMARY KEY REFERENCES agent(agent_uid) ON DELETE CASCADE,
      status       TEXT NOT NULL,
      nullifier    TEXT,
      proof_ref    TEXT,
      verified_at  INTEGER NOT NULL
    );
    INSERT INTO world_verification VALUES ('agent-known', 'verified', '0xn', NULL, 1);
  `);
  return db;
}

function tableSql(db: DatabaseSync): string {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'world_verification'")
    .get() as { sql: string };
  return row.sql;
}

test('a pre-existing verification row proves the legacy FK blocks an unregistered agent', () => {
  // Not tautological: if this insert ever succeeds, the FK is gone and the
  // rest of the test is vacuous. `agent-known` exists in the table; the ENS
  // listing does not exist in `agent`, which is the live case.
  const db = legacyDb();
  assert.throws(
    () => db.prepare('INSERT INTO world_verification VALUES (?, ?, ?, NULL, ?)').run('liquidity.turnstile.eth', 'verified', '0xt', 2),
    /FOREIGN KEY constraint failed/,
  );
});

test('migration drops the FK, and the previously-blocked insert now lands', () => {
  const db = legacyDb();
  assert.equal(migrateWorldVerificationFk(db), true);
  assert.doesNotMatch(tableSql(db), /REFERENCES\s+agent/i);
  db.prepare('INSERT INTO world_verification VALUES (?, ?, ?, NULL, ?)').run('liquidity.turnstile.eth', 'verified', '0xt', 2);
});

test('migration is idempotent and no-ops on an already-migrated database', () => {
  const db = legacyDb();
  assert.equal(migrateWorldVerificationFk(db), true);
  assert.equal(migrateWorldVerificationFk(db), false);
  // A fresh schema.sql database has never had the FK; still false, still safe.
  const fresh = new DatabaseSync(':memory:');
  fresh.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  assert.equal(migrateWorldVerificationFk(fresh), false);
});

test('existing rows, the dependent view and the count index survive the rebuild', () => {
  const db = legacyDb();
  migrateWorldVerificationFk(db);
  const rows = db.prepare('SELECT agent_uid, status FROM world_verification ORDER BY agent_uid').all();
  // node:sqlite rows have a null prototype, which deepStrictEqual rejects
  // against object literals (the same reason web/lib/discovery.ts has toPlain).
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), [{ agent_uid: 'agent-known', status: 'verified' }]);
  // agent_current LEFT JOINs world_verification — the live read path.
  const view = db.prepare('SELECT agent_uid, world_verification FROM agent_current').all();
  assert.ok(Array.isArray(view));
  const indexed = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'world_verification_by_nullifier'")
    .get();
  assert.ok(indexed, 'counting index must exist after migration');
  assert.equal((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1, 'FK enforcement must be back on');
});
