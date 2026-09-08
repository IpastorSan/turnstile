import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import { openDb } from './db.ts';
import { ingest, toAgentRow } from './sink.ts';

test('proto3 JSON omits defaults, so absent means zero', () => {
  // The wire format drops false, 0 and "". Reading them as undefined rather
  // than as absent-and-unknown is the difference between an agent that does not
  // support x402 and one we forgot to ask.
  const row = toAgentRow({ agentUid: 'eip155:1:0xreg/7' });
  assert.equal(row.x402Support, false);
  assert.equal(row.active, false);
  assert.equal(row.inModuleResolved, false);
  assert.equal(row.logIndex, 0);
  assert.equal(row.agentUri, '');
  assert.equal(row.uriScheme, 'UNSPECIFIED');
  assert.equal(row.namespace, 'eip155');
});

test('enum names arrive spelled out in full', () => {
  const row = toAgentRow({
    agentUid: 'u',
    uriScheme: 'URI_SCHEME_HTTPS',
    event: 'REGISTRATION_EVENT_URI_UPDATED',
    operatorSource: 'OPERATOR_SOURCE_AGENT_WALLET',
  });
  assert.equal(row.uriScheme, 'HTTPS');
  assert.equal(row.lastEvent, 'URI_UPDATED');
  assert.equal(row.operatorSource, 'AGENT_WALLET');
});

test('an absent operator falls back to the owner, per EIP-8004', () => {
  // The registry initialises agentWallet to the owner, so the module emits no
  // operator when nothing has repointed it.
  assert.equal(toAgentRow({ agentUid: 'u', owner: '0xowner' }).operator, '0xowner');
});

test('ingest folds a jsonl stream into agents and wallets', async () => {
  const lines = [
    // An empty block: no registrations key at all.
    { '@data': { chainId: '8453', network: 'base', blockNumber: '100', blockTimestamp: '1700000000' } },
    {
      '@data': {
        chainId: '8453', network: 'base', blockNumber: '101', blockTimestamp: '1700000010',
        registrations: [{
          agentUid: 'eip155:8453:0xreg/1', chainId: '8453', network: 'base', registry: '0xreg',
          agentId: '1', owner: '0xowner', agentUri: 'data:application/json,{}',
          uriScheme: 'URI_SCHEME_DATA', registrationResolved: true, name: 'A',
          endpoints: [{ name: 'x402', uri: 'https://e', skills: ['swap'] }],
          x402Support: true, event: 'REGISTRATION_EVENT_REGISTERED',
          blockNumber: '101', blockTimestamp: '1700000010', transactionHash: '0xtx', logIndex: 3,
        }],
      },
    },
    {
      // The wallet moves in a LATER block than the registration — the case a
      // pure map module cannot see, and the reason the sink folds in SQL.
      '@data': {
        chainId: '8453', network: 'base', blockNumber: '105', blockTimestamp: '1700000050',
        walletUpdates: [{
          agentUid: 'eip155:8453:0xreg/1', wallet: '0xpayout',
          blockNumber: '105', blockTimestamp: '1700000050', transactionHash: '0xtx2', logIndex: 1,
        }],
      },
    },
    'not json at all',
  ];
  const stream = Readable.from(lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l)) + '\n'));

  const db = openDb(':memory:');
  const result = await ingest(db, stream, { network: 'base', quiet: true });

  assert.equal(result.blocks, 3);
  assert.equal(result.registrations, 1);
  assert.equal(result.walletUpdates, 1);
  assert.equal(result.walletsFolded, 1);

  const row = db.prepare('SELECT operator, name, x402_support FROM agent').get() as
    { operator: string; name: string; x402_support: number };
  assert.equal(row.operator, '0xpayout');
  assert.equal(row.name, 'A');
  assert.equal(row.x402_support, 1);

  const caps = db.prepare('SELECT capability FROM agent_capability ORDER BY capability')
    .all() as unknown as { capability: string }[];
  assert.deepEqual(caps.map((c) => c.capability), ['swap', 'x402']);

  const cursor = db.prepare('SELECT last_block, blocks_seen FROM sink_cursor').get() as
    { last_block: number; blocks_seen: number };
  assert.equal(cursor.last_block, 105);
  assert.equal(cursor.blocks_seen, 3);
  db.close();
});

test('an unresolved URI_UPDATED does not wipe endpoints already known', async () => {
  // A URI_UPDATED pointing at an https:// document is unresolvable in-module.
  // Treating that as "this agent now has no endpoints" would delete real data
  // every time an agent edited its card.
  const registered = {
    '@data': {
      chainId: '1', network: 'mainnet', blockNumber: '10', blockTimestamp: '1',
      registrations: [{
        agentUid: 'eip155:1:0xreg/9', chainId: '1', network: 'mainnet', registry: '0xreg', agentId: '9',
        owner: '0xo', uriScheme: 'URI_SCHEME_DATA', registrationResolved: true,
        endpoints: [{ name: 'web', uri: 'https://a' }],
        event: 'REGISTRATION_EVENT_REGISTERED', blockNumber: '10', blockTimestamp: '1', transactionHash: '0x1',
      }],
    },
  };
  const updated = {
    '@data': {
      chainId: '1', network: 'mainnet', blockNumber: '11', blockTimestamp: '2',
      registrations: [{
        agentUid: 'eip155:1:0xreg/9', chainId: '1', network: 'mainnet', registry: '0xreg', agentId: '9',
        owner: '0xo', agentUri: 'https://later', uriScheme: 'URI_SCHEME_HTTPS',
        event: 'REGISTRATION_EVENT_URI_UPDATED', blockNumber: '11', blockTimestamp: '2', transactionHash: '0x2',
      }],
    },
  };

  const db = openDb(':memory:');
  await ingest(db, Readable.from([JSON.stringify(registered) + '\n', JSON.stringify(updated) + '\n']),
    { network: 'mainnet', quiet: true });

  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM agent_endpoint').get() as { n: number }).n, 1);
  const agent = db.prepare('SELECT agent_uri, in_module_resolved FROM agent').get() as
    { agent_uri: string; in_module_resolved: number };
  assert.equal(agent.agent_uri, 'https://later');
  assert.equal(agent.in_module_resolved, 0);
  db.close();
});
