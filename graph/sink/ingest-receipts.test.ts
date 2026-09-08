// The seam MOV-222 left open, closed.
//
// `seller/service/discovery.test.ts` already asserts the *transition*: with an
// empty `settlement_receipt`, ranking calls itself a placeholder; with a row in
// it, ranking switches to settled volume and stops apologising. What it does by
// hand there — `INSERT INTO settlement_receipt ... '5.00'` — is what this file
// does from real HCS messages.

import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb, upsertAgent } from './db.ts';
import type { AgentRow } from './db.ts';
import { agentUidForEns, ingestReceipts } from './ingest-receipts.ts';
import type { HcsReceiptMessage } from '../../rails/hedera-x402/hcs.ts';
import { findSellers } from '../../seller/service/discovery.ts';

const AGENT_UID = 'eip155:11155111:0xreg/3';

function receipt(over: Partial<HcsReceiptMessage> = {}): HcsReceiptMessage {
  return {
    v: 1,
    kind: 'turnstile.settlement',
    railId: 'hedera-x402',
    network: 'hedera:testnet',
    transaction: '0.0.7162784@1788791330.918068236',
    payer: '0.0.10408012',
    payTo: '0.0.10403961',
    amount: '84367844',
    asset: '0.0.0',
    priceUsd: 0.07,
    resource: 'https://liquidity.turnstile.eth/analyze/0xpool',
    settledAt: 1788791339313,
    ...over,
  };
}

function fixture() {
  const db = openDb(':memory:');
  const agent = (id: string): AgentRow => ({
    agentUid: `eip155:11155111:0xreg/${id}`,
    namespace: 'eip155', chainId: 11155111, network: 'sepolia', registry: '0xreg', agentId: id,
    owner: '0xowner', operator: '0xowner', operatorSource: 'OWNER_DEFAULT',
    agentUri: 'https://example.com/a.json', uriScheme: 'HTTPS', inModuleResolved: true,
    lastEvent: 'REGISTERED', blockNumber: 100, blockTimestamp: 1_700_000_100,
    transactionHash: '0xtx', logIndex: 0,
    name: 'Turnstile Liquidity', description: 'Uniswap v4 pool liquidity analytics',
    x402Support: true, active: true,
  });
  upsertAgent(db, agent('3'));
  upsertAgent(db, { ...agent('4'), agentUid: 'eip155:11155111:0xreg/4', agentId: '4', name: 'Someone Else', blockTimestamp: 1_700_000_900 });
  db.prepare(`
    INSERT INTO turnstile_seller (ens_name, node, resolver, chain_id, agent_uid, mcp_endpoint,
      price, price_ceiling, rails, payout_addr, resolver_verified, read_at)
    VALUES ('liquidity.turnstile.eth', '0xnode', '0xresolver', 11155111, ?, 'https://mcp.example/sse',
      '0.07', '0.50', 'x402,usdc-arc', '0xpayout', 1, 0)
  `).run(AGENT_UID);
  return db;
}

test('ingesting one HCS receipt flips discovery off its placeholder ranking', () => {
  const db = fixture();

  const before = findSellers(db, {});
  assert.equal(before.ranking.basis, 'registration_recency');
  assert.equal(before.ranking.placeholder, true);
  // Newest registration first, so the seller with the receipts starts last.
  assert.equal(before.sellers[0]!.agentId, '4');

  const result = ingestReceipts(db, AGENT_UID, [receipt()], '0.0.10408013');
  assert.deepEqual(result, { read: 1, inserted: 1, skipped: [] });

  const after = findSellers(db, {});
  assert.equal(after.ranking.basis, 'settled_volume');
  assert.equal(after.ranking.placeholder, false);
  assert.match(after.ranking.note, /1 HCS receipts/);
  // And the ordering actually changed, rather than the label alone.
  assert.equal(after.sellers[0]!.agentId, '3');
  assert.equal(after.sellers[0]!.rank.settledVolume, 0.07);
  db.close();
});

test('the row stores dollars, and names the transaction it came from', () => {
  // `settled_volume` sums `amount` across rails, so it can only hold a number
  // that means the same thing on both. Tinybars here would report the seller as
  // having done 84 million dollars of business. See the correction in schema.sql.
  const db = fixture();
  ingestReceipts(db, AGENT_UID, [receipt()], '0.0.10408013');
  const row = db.prepare('SELECT * FROM settlement_receipt').get() as Record<string, unknown>;

  assert.equal(row['receipt_id'], '0.0.7162784@1788791330.918068236');
  assert.equal(row['currency'], 'USD');
  assert.equal(Number(row['amount']), 0.07);
  assert.equal(row['buyer'], '0.0.10408012');
  assert.equal(row['asset'], '0.0.0');
  // The ENS token from `turnstile:rails`, not the rail id — that is what a buyer
  // who found us through ENS filters on.
  assert.equal(row['rail'], 'x402');
  assert.equal(row['hcs_topic_id'], '0.0.10408013');
  db.close();
});

test('re-ingesting the same topic adds nothing', () => {
  // The receipt id is the Hedera transaction id, so a second pass over a topic
  // that has grown by one message writes one row, not all of them again.
  const db = fixture();
  const first = receipt();
  const second = receipt({ transaction: '0.0.7162784@1788791491.360427997', priceUsd: 0.35 });

  ingestReceipts(db, AGENT_UID, [first], '0.0.10408013');
  ingestReceipts(db, AGENT_UID, [first, second], '0.0.10408013');

  const { n } = db.prepare('SELECT COUNT(*) AS n FROM settlement_receipt').get() as { n: number };
  assert.equal(n, 2);
  assert.equal(findSellers(db, {}).sellers[0]!.rank.settledVolume, 0.42);
  db.close();
});

test('a receipt whose dollar amount is unknown is dropped, not zeroed', () => {
  // A zero row would count as evidence of a sale that cannot be compared with
  // any other, which corrupts the ranking rather than improving it. Discovery's
  // whole posture is that a missing number stays missing.
  const db = fixture();
  const result = ingestReceipts(db, AGENT_UID, [receipt({ priceUsd: null }), receipt({ transaction: '' })], '0.0.10408013');

  assert.equal(result.inserted, 0);
  assert.equal(result.skipped.length, 2);
  assert.match(result.skipped[0]!.why, /cannot be summed/);
  assert.equal(findSellers(db, {}).ranking.placeholder, true);
  db.close();
});

test('the agent uid is resolved from the ENS name the sink already knows', () => {
  const db = fixture();
  assert.equal(agentUidForEns(db, 'liquidity.turnstile.eth'), AGENT_UID);
  assert.equal(agentUidForEns(db, 'nobody.eth'), null);
  db.close();
});
