import test from 'node:test';
import assert from 'node:assert/strict';

import { capabilityTokens, foldWallets, normalizeCapability, openDb, recordWalletUpdate, upsertAgent } from './db.ts';
import type { AgentRow } from './db.ts';

const base = (over: Partial<AgentRow> = {}): AgentRow => ({
  agentUid: 'eip155:8453:0xreg/1',
  namespace: 'eip155',
  chainId: 8453,
  network: 'base',
  registry: '0xreg',
  agentId: '1',
  owner: '0xowner',
  operator: '0xowner',
  operatorSource: 'OWNER_DEFAULT',
  agentUri: 'https://example.com/a.json',
  uriScheme: 'HTTPS',
  inModuleResolved: false,
  lastEvent: 'REGISTERED',
  blockNumber: 100,
  blockTimestamp: 1_700_000_000,
  transactionHash: '0xtx',
  logIndex: 0,
  ...over,
});

test('capability tokens index the whole OASF path and each segment', () => {
  assert.deepEqual(
    capabilityTokens('tool_interaction/blockchain_interaction'),
    ['tool-interaction/blockchain-interaction', 'tool-interaction', 'blockchain-interaction'],
  );
  // Single characters are noise, not capabilities.
  assert.deepEqual(capabilityTokens('a/search'), ['a/search', 'search']);
  assert.deepEqual(capabilityTokens('   '), []);
});

test('capabilities are compared, so spelling is normalized', () => {
  assert.equal(normalizeCapability('Uniswap_V4'), 'uniswap-v4');
  assert.equal(normalizeCapability('  Data Analysis '), 'data-analysis');
});

test('only a later event overwrites an agent', () => {
  const db = openDb(':memory:');
  upsertAgent(db, base({ name: 'first', blockNumber: 100, logIndex: 5 }));

  // A backfill of an OLDER range must not clobber newer state.
  upsertAgent(db, base({ name: 'older', blockNumber: 99, logIndex: 999 }));
  assert.equal((db.prepare('SELECT name FROM agent').get() as { name: string }).name, 'first');

  // Same block, later log index: this one wins.
  upsertAgent(db, base({ name: 'later-log', blockNumber: 100, logIndex: 6 }));
  assert.equal((db.prepare('SELECT name FROM agent').get() as { name: string }).name, 'later-log');

  upsertAgent(db, base({ name: 'newer', blockNumber: 101, logIndex: 0 }));
  const row = db.prepare('SELECT name, first_seen_block FROM agent').get() as { name: string; first_seen_block: number };
  assert.equal(row.name, 'newer');
  // first_seen only ever moves backwards.
  assert.equal(row.first_seen_block, 99);
  db.close();
});

test('folding wallet updates gives the agent its latest payout address', () => {
  // The map module sees one block at a time, so an agentWallet set in a
  // different block than the registration is invisible to it. This is the join
  // map_agent_directory does against store_agent_wallets, done in SQL instead.
  const db = openDb(':memory:');
  upsertAgent(db, base());
  recordWalletUpdate(db, {
    agentUid: 'eip155:8453:0xreg/1', wallet: '0xfirst',
    blockNumber: 101, blockTimestamp: 1, transactionHash: '0xa', logIndex: 0,
  });
  recordWalletUpdate(db, {
    agentUid: 'eip155:8453:0xreg/1', wallet: '0xlatest',
    blockNumber: 105, blockTimestamp: 2, transactionHash: '0xb', logIndex: 3,
  });

  assert.equal(foldWallets(db), 1);
  const row = db.prepare('SELECT operator, operator_source FROM agent').get() as
    { operator: string; operator_source: string };
  assert.equal(row.operator, '0xlatest');
  assert.equal(row.operator_source, 'AGENT_WALLET');

  // Idempotent: folding again changes nothing.
  assert.equal(foldWallets(db), 0);
  db.close();
});
