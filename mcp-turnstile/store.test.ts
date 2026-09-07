// The store has to be found or the failure has to be loud. There is no third
// option, because `openDb` creates a missing file and an empty store answers
// every query with a confident "nothing found".

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PACKAGE_ROOT, STORE_CANDIDATES, StoreNotFound, resolveStore } from './store.ts';

test('a named path that does not exist is an error, not an empty store', () => {
  const missing = join(mkdtempSync(join(tmpdir(), 'turnstile-store-')), 'nope.db');
  assert.throws(() => resolveStore(missing), StoreNotFound);
  // The point of the throw: nothing was created on the way out.
  assert.equal(existsSync(missing), false);
});

test('the error names the fix rather than only the failure', () => {
  try {
    resolveStore(join(mkdtempSync(join(tmpdir(), 'turnstile-store-')), 'nope.db'));
    assert.fail('expected a throw');
  } catch (cause) {
    const message = (cause as Error).message;
    assert.match(message, /--db or TURNSTILE_DB/);
    assert.match(message, /Omit --db/);
  }
});

test('a named path that exists is used verbatim', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'turnstile-store-')), 'there.db');
  writeFileSync(path, '');
  assert.deepEqual(resolveStore(path), { path, source: 'explicit' });
});

test('with no argument it finds the snapshot that ships with the repo', () => {
  // The judge case: a clean clone, no Substreams token, no sink run. If this
  // ever stops passing, the server stops working from a fresh checkout.
  const resolved = resolveStore();
  assert.ok(STORE_CANDIDATES.some((c) => resolved.path === join(PACKAGE_ROOT, c)));
  assert.ok(existsSync(resolved.path));
});
