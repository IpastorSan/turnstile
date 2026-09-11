// Move World verifications stored under an ENS name onto the agent's uid.
//
// Before MOV-277, /onboard posted the ENS name and the verify route stored the
// proof under it. The market joins world_verification on the ERC-8004 agent
// uid, so the first real proof (2026-09-11 09:06:02 UTC, stored under
// liquidity.turnstile.eth) never showed. The route now stores under the uid;
// this fixes rows written before that.
//
//   node scripts/world-rekey.ts [--db <path>] [--name <ens>]... [--dry-run]
//
// Without --name it considers every row not keyed by an agent uid. A row whose
// name has no registered agent is a reservation and is left alone. A row whose
// uid already has a verification is a conflict: nothing is written for it and
// the exit code is 1, because choosing between two proofs is a decision about
// who holds the listing, not a migration.
//
// Idempotent: a second run reports already_canonical and writes nothing.
// Imports only node builtins and identity/canonical.ts, so it runs in a bare
// node:24 image with no node_modules (that is how it runs on the host).

import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';

import { DEFAULT_DB_PATH, migrateWorldVerificationFk } from '../graph/sink/db.ts';
import { nameKeyedVerifications, rekeyVerification, type RekeyOutcome } from '../identity/canonical.ts';

const { values } = parseArgs({
  options: {
    db: { type: 'string', default: DEFAULT_DB_PATH },
    name: { type: 'string', multiple: true },
    'dry-run': { type: 'boolean', default: false },
  },
});

const path = values.db;
const dryRun = values['dry-run'];
if (!existsSync(path)) {
  console.error(`no database at ${path}`);
  process.exit(2);
}

const db = new DatabaseSync(path);
const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'world_verification'").get();
if (!hasTable) {
  console.error(`${path} has no world_verification table`);
  process.exit(2);
}

// A store built before the FK came out still has world_verification.agent_uid
// REFERENCES agent. The live one was migrated by the verify route on
// 2026-09-11; running the same idempotent migration here means the script
// behaves the same on any copy.
if (!dryRun && migrateWorldVerificationFk(db)) console.log('dropped the legacy FK on world_verification first');

const names = values.name?.length ? values.name : nameKeyedVerifications(db);
console.log(`${dryRun ? 'dry run on' : 'rekeying'} ${path}: ${names.length} name-keyed row(s) to consider`);

const outcomes: RekeyOutcome[] = [];
db.exec('BEGIN IMMEDIATE');
try {
  for (const name of names) outcomes.push(rekeyVerification(db, name));
  db.exec(dryRun ? 'ROLLBACK' : 'COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}

for (const outcome of outcomes) {
  const detail =
    outcome.status === 'rekeyed' || outcome.status === 'already_canonical' ? ` -> ${outcome.to}`
    : outcome.status === 'not_registered' || outcome.status === 'conflict' ? `: ${outcome.reason}`
    : '';
  console.log(`  ${outcome.status.padEnd(17)} ${outcome.from}${detail}`);
}
if (dryRun && outcomes.some(o => o.status === 'rekeyed')) console.log('dry run: nothing was written');

const rows = db.prepare('SELECT agent_uid, status, verified_at FROM world_verification ORDER BY verified_at').all();
console.log('world_verification now:');
for (const row of rows) console.log(`  ${String(row['agent_uid'])}  ${String(row['status'])}  ${String(row['verified_at'])}`);
db.close();

process.exit(outcomes.some(o => o.status === 'conflict') ? 1 : 0);
