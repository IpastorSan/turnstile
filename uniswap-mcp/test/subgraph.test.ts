import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CANNED_QUERIES, describeStaleness, withMeta } from '../src/subgraph.ts';
import { formatLag } from '../src/format.ts';

describe('withMeta', () => {
  test('appends a _meta selection to a plain query', () => {
    const { document, injected } = withMeta('{ liquidityPools(first: 1) { name } }');
    assert.equal(injected, true);
    assert.match(document, /_meta \{ block \{ number timestamp \} hasIndexingErrors \}/);
    // The caller's own selection must survive intact.
    assert.match(document, /liquidityPools\(first: 1\) \{ name \}/);
  });

  test('leaves a document that already selects _meta alone', () => {
    // Re-declaring _meta with a different sub-selection is a validation error,
    // so injecting into it would break a query that was previously fine.
    const doc = '{ _meta { block { number } } }';
    assert.deepEqual(withMeta(doc), { document: doc, injected: false });
  });

  test('does not touch a mutation or a subscription', () => {
    const m = 'mutation Foo { bar }';
    assert.deepEqual(withMeta(m), { document: m, injected: false });
    const s = 'subscription Foo { bar }';
    assert.deepEqual(withMeta(s), { document: s, injected: false });
  });

  test('handles a named query with variables', () => {
    const { document, injected } = withMeta(
      'query PoolHistory($pool: String!) { liquidityPoolDailySnapshots(where: {pool: $pool}) { day } }',
    );
    assert.equal(injected, true);
    assert.match(document, /\$pool/);
    assert.match(document, /_meta/);
    // The injection must land inside the outermost braces, not after them.
    assert.equal(document.trim().endsWith('}'), true);
  });

  test('leaves a document with no braces alone rather than corrupting it', () => {
    assert.deepEqual(withMeta('not a query'), { document: 'not a query', injected: false });
  });
});

describe('describeStaleness', () => {
  test('calls out a subgraph that is days behind, in days', () => {
    const notes = describeStaleness(12.6 * 86_400, false);
    assert.ok(notes.some((n) => /12\.6 days behind/.test(n)), notes.join('\n'));
    assert.ok(notes.some((n) => /historical/.test(n)));
  });

  test('says nothing about lag when the subgraph is at the chainhead', () => {
    const notes = describeStaleness(14, false);
    assert.ok(!notes.some((n) => /behind the chain/.test(n)), notes.join('\n'));
  });

  test('always warns about sparse snapshot series', () => {
    // This is the bug the note exists to prevent: `first: 24` is 24 rows, not
    // 24 hours, and dividing by the row count reports a pool with three trades
    // a day as trading all day.
    for (const lag of [0, 3600, 86_400 * 30]) {
      const notes = describeStaleness(lag, false);
      assert.ok(notes.some((n) => /sparse/.test(n)), `lag ${lag}: ${notes.join('\n')}`);
    }
  });

  test('flags indexing errors and missing _meta separately', () => {
    assert.ok(describeStaleness(0, true).some((n) => /hasIndexingErrors is true/.test(n)));
    assert.ok(describeStaleness(null, null).some((n) => /freshness of this data is unknown/.test(n)));
  });

  test('explains a GraphQL error as a probable schema-version boundary', () => {
    const notes = describeStaleness(0, false, [{ message: 'Type LiquidityPool has no field tick' }]);
    assert.ok(notes.some((n) => /schemaVersion/.test(n)), notes.join('\n'));
  });
});

describe('formatLag', () => {
  test('scales its unit with the size of the lag', () => {
    assert.equal(formatLag(14), '14s');
    assert.equal(formatLag(600), '10.0 min');
    assert.equal(formatLag(7200), '2.0 h');
    assert.equal(formatLag(12.6 * 86_400), '12.6 days');
  });

  test('never reports a negative lag', () => {
    // Clock skew between the indexer and here can make this negative, and
    // "-3s behind" reads as a bug in the tool rather than in the clock.
    assert.equal(formatLag(-3), '0s');
  });
});

describe('canned queries', () => {
  test('every canned document is balanced and names the entity it claims to', () => {
    for (const [name, q] of Object.entries(CANNED_QUERIES)) {
      const opens = (q.document.match(/\{/g) ?? []).length;
      const closes = (q.document.match(/\}/g) ?? []).length;
      assert.equal(opens, closes, `${name}: unbalanced braces`);
      assert.ok(q.description.length > 40, `${name}: description too thin to guide a caller`);
    }
    assert.match(CANNED_QUERIES.protocol_vitals!.document, /dexAmmProtocols/);
    assert.match(CANNED_QUERIES.concentrated_liquidity!.document, /tick/);
    assert.match(CANNED_QUERIES.pool_history!.document, /liquidityPoolDailySnapshots/);
  });

  test('every canned document survives _meta injection', () => {
    for (const [name, q] of Object.entries(CANNED_QUERIES)) {
      const { document, injected } = withMeta(q.document);
      assert.equal(injected, true, `${name} should accept injection`);
      const opens = (document.match(/\{/g) ?? []).length;
      const closes = (document.match(/\}/g) ?? []).length;
      assert.equal(opens, closes, `${name}: injection unbalanced the document`);
    }
  });
});
