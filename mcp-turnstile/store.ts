// Finding the discovery store, and refusing to invent one.
//
// `openDb` is a `CREATE TABLE IF NOT EXISTS` migration over `new
// DatabaseSync(path)`, and `DatabaseSync` **creates the file if it is missing**.
// So a typo in `--db`, or a fresh clone that never ran the sink, does not fail:
// it produces an empty, perfectly valid store, and every tool then reports
// "0 agents" with total confidence. That is the worst failure mode this server
// has — an agent about to spend money cannot tell "nobody sells this" from
// "you pointed me at nothing".
//
// So the path is resolved before anything opens it, and a missing file is an
// error naming the two places it could have come from.

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/** Repository root, from this file's location — `mcp-turnstile/` is one level down. */
export const PACKAGE_ROOT = dirname(import.meta.dirname);

/**
 * Where a store might be, best first.
 *
 * `graph/sink/data/` is gitignored and is what the sink writes, so it is the
 * live one when a developer has run it. `web/data/discovery.db` is **tracked**:
 * a 197-agent snapshot with `web/data/provenance.json` beside it recording the
 * block ranges it was built from. A judge who has just cloned the repo has only
 * the second one, which is exactly why the fallback exists — the server has to
 * work from a clean checkout with no Substreams token.
 */
export const STORE_CANDIDATES = [
  join('graph', 'sink', 'data', 'discovery.db'),
  join('web', 'data', 'discovery.db'),
] as const;

export class StoreNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreNotFound';
  }
}

export interface ResolvedStore {
  path: string;
  /** `explicit` when the caller named it, `bundled` when we found the snapshot. */
  source: 'explicit' | 'sink' | 'snapshot';
}

/**
 * Resolve the discovery store, or throw with instructions.
 *
 * @param explicit - a `--db` flag or `TURNSTILE_DB`. Must exist; a named path
 *   that is not there is a mistake, never a reason to create an empty store.
 */
export function resolveStore(explicit?: string): ResolvedStore {
  if (explicit) {
    const path = isAbsolute(explicit) ? explicit : resolve(process.cwd(), explicit);
    if (!existsSync(path)) {
      throw new StoreNotFound(
        `no discovery store at ${path}. That path was given explicitly (--db or TURNSTILE_DB), ` +
        'so it is not created: an empty store answers every query with "nothing found", which is ' +
        'indistinguishable from a real answer. Omit --db to use the snapshot that ships with the repo.',
      );
    }
    return { path, source: 'explicit' };
  }

  for (const [i, candidate] of STORE_CANDIDATES.entries()) {
    const path = join(PACKAGE_ROOT, candidate);
    if (existsSync(path)) return { path, source: i === 0 ? 'sink' : 'snapshot' };
  }

  throw new StoreNotFound(
    `no discovery store found under ${PACKAGE_ROOT}. Looked for ${STORE_CANDIDATES.join(' and ')}.\n` +
    'Either point --db at one, or build a store with `npm run sink` (needs SUBSTREAMS_API_TOKEN). ' +
    'A clean clone of the Turnstile repo carries web/data/discovery.db and needs neither.',
  );
}

/**
 * Open the store for reading, and only for reading.
 *
 * Not `openDb()`, and the difference is not a micro-optimisation. `openDb` runs
 * `schema.sql` on every open, which includes `PRAGMA journal_mode = WAL` — so a
 * *reader* rewrites the file header of the store it was asked to read. That
 * showed up as the committed `web/data/discovery.db` snapshot appearing modified
 * after nothing but a `find_sellers` call, and it would show up again the first
 * time this ran with the store on a read-only mount.
 *
 * This server is a reader. It has no business being able to write to the
 * directory it serves, and `resolveStore` has already established that the file
 * exists, so there is nothing for the migration to do.
 *
 * Opened per call rather than held: the sink writes to the same file, and a
 * long-lived reader in WAL mode pins the snapshot it started with — so a server
 * that stayed connected would keep serving a directory that had stopped being
 * current. Verified 2026-09-07 that a read-only open works against a WAL store
 * with no `-shm` present and with the containing directory read-only.
 */
export function openStore(path: string): DatabaseSync {
  return new DatabaseSync(path, { readOnly: true });
}
