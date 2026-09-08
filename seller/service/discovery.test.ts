// Discovery's job is to be honest about what it does not know. Most of these
// tests assert that a missing price stays missing rather than becoming a zero,
// and that a placeholder ranking says it is one.

import test from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';

import { openDb, replaceEndpoints, upsertAgent } from '../../graph/sink/db.ts';
import type { AgentRow } from '../../graph/sink/db.ts';
import { findSellers, normalizePriceUsd } from './discovery.ts';

const agent = (over: Partial<AgentRow> = {}): AgentRow => ({
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
  inModuleResolved: true,
  lastEvent: 'REGISTERED',
  blockNumber: 100,
  blockTimestamp: 1_700_000_000,
  transactionHash: '0xtx',
  logIndex: 0,
  ...over,
});

/** Two chains, three agents, one of them ours with an ENS price. */
function fixture(): DatabaseSync {
  const db = openDb(':memory:');

  upsertAgent(db, agent({
    agentUid: 'eip155:8453:0xreg/1', chainId: 8453, network: 'base', agentId: '1',
    name: 'Base Liquidity Bot', description: 'Uniswap v4 liquidity analytics',
    x402Support: true, active: true, blockTimestamp: 1_700_000_300,
  }));
  replaceEndpoints(db, 'eip155:8453:0xreg/1', 'in_module',
    [{ name: 'x402', uri: 'https://example.com/api', skills: ['analytical_skills/liquidity_analysis'] }], ['reputation']);

  upsertAgent(db, agent({
    agentUid: 'eip155:1:0xreg/2', chainId: 1, network: 'mainnet', agentId: '2',
    name: 'Mainnet Image Agent', description: 'Generates images',
    x402Support: false, active: true, blockTimestamp: 1_700_000_200,
  }));

  upsertAgent(db, agent({
    agentUid: 'eip155:11155111:0xreg/3', chainId: 11155111, network: 'sepolia', agentId: '3',
    name: 'Turnstile Liquidity', description: 'Uniswap v4 pool liquidity analytics',
    x402Support: true, active: true, blockTimestamp: 1_700_000_100,
  }));
  db.prepare(`
    INSERT INTO turnstile_seller (ens_name, node, resolver, chain_id, agent_uid, mcp_endpoint,
      price, price_ceiling, rails, payout_addr, resolver_verified, read_at)
    VALUES ('liquidity.turnstile.eth', '0xnode', '0xresolver', 11155111, 'eip155:11155111:0xreg/3',
      'https://mcp.example/sse', '0.07', '0.50', 'x402,usdc-arc', '0xpayout', 1, 0)
  `).run();

  return db;
}

test('one result set spans chains', () => {
  // The cross-chain claim: agent 1 on Base and agent 2 on mainnet come back
  // together, distinguishable by agent_uid rather than by agent id.
  const db = fixture();
  const result = findSellers(db, {});
  const networks = new Set(result.sellers.map((s) => s.network));
  assert.deepEqual([...networks].sort(), ['base', 'mainnet', 'sepolia']);
  assert.equal(result.coverage.chains.length, 3);
  db.close();
});

test('chains filter narrows to the chains asked for, by name or by id', () => {
  const db = fixture();
  assert.deepEqual(findSellers(db, { chains: ['base'] }).sellers.map((s) => s.agentId), ['1']);
  assert.deepEqual(findSellers(db, { chains: [1] }).sellers.map((s) => s.agentId), ['2']);
  assert.equal(findSellers(db, { chains: ['base', 1] }).sellers.length, 2);
  db.close();
});

test('capability matches a declared skill, and says that is what matched', () => {
  const db = fixture();
  const result = findSellers(db, { capabilities: ['liquidity-analysis'], matchText: false });
  assert.deepEqual(result.sellers.map((s) => s.agentId), ['1']);
  assert.ok(result.sellers[0].matchedOn.some((m) => m.startsWith('skill:')), result.sellers[0].matchedOn.join());
  db.close();
});

test('capability falls back to text, and says THAT is what matched', () => {
  // Most of the directory declares no skills at all, so a capability filter
  // that only read the skill index would return almost nothing.
  const db = fixture();
  const result = findSellers(db, { capabilities: ['uniswap'] });
  assert.deepEqual(result.sellers.map((s) => s.agentId).sort(), ['1', '3']);
  const viaText = result.sellers.find((s) => s.agentId === '3')!;
  assert.deepEqual(viaText.matchedOn, ['text:name-or-description']);
  db.close();
});

test('a price ceiling keeps a Turnstile seller under it and drops one over it', () => {
  const db = fixture();
  const under = findSellers(db, { maxPriceUsd: 0.10 });
  assert.deepEqual(under.sellers.map((s) => s.agentId), ['3']);
  assert.equal(under.sellers[0].price?.usd, 0.07);
  assert.equal(under.sellers[0].price?.source, 'turnstile');
  assert.equal(under.sellers[0].price?.comparable, true);
  // The cold-key ceiling the seller's hot key cannot exceed travels with it.
  assert.equal(under.sellers[0].price?.ceilingUsd, 0.50);

  const over = findSellers(db, { maxPriceUsd: 0.05 });
  assert.equal(over.sellers.length, 0);
  assert.equal(over.coverage.droppedForPriceCeiling, 1);
  db.close();
});

test('agents with no knowable price are excluded from a ceiling query, and counted', () => {
  // Not a rejection of the agent — a refusal to pretend we know its price.
  const db = fixture();
  const strict = findSellers(db, { maxPriceUsd: 1 });
  assert.deepEqual(strict.sellers.map((s) => s.agentId), ['3']);
  assert.equal(strict.coverage.droppedForUnknownPrice, 2);

  const loose = findSellers(db, { maxPriceUsd: 1, includeUnknownPrice: true });
  assert.equal(loose.sellers.length, 3);
  assert.equal(loose.sellers.find((s) => s.agentId === '1')!.price, null);
  db.close();
});

test('x402Support without a quote is ask_x402, never free', () => {
  // The distinction the whole design turns on: the registry says this agent
  // takes money, and says nothing about how much.
  const db = fixture();
  const result = findSellers(db, {});
  assert.equal(result.priceSources.ask_x402, 1);   // agent 1: x402, no quote
  assert.equal(result.priceSources.turnstile, 1);  // agent 3: ENS price
  assert.equal(result.priceSources.none, 1);       // agent 2: nothing
  assert.equal(result.priceSources.document, 0);   // as expected, always
  db.close();
});

test('a fetched 402 quote prices a non-Turnstile agent', () => {
  const db = fixture();
  db.prepare(`
    INSERT INTO x402_quote (agent_uid, endpoint, status, amount, currency, asset, network, scheme, probed_at)
    VALUES ('eip155:8453:0xreg/1', 'https://example.com/api', 'quoted', '70000', 'USDC', '0xusdc', 'base', 'exact', 1)
  `).run();
  const result = findSellers(db, { chains: ['base'] });
  const seller = result.sellers[0];
  assert.equal(seller.price?.source, 'x402');
  // maxAmountRequired is an integer in the asset's smallest unit: 70000 USDC
  // units is seven cents, not seventy thousand dollars.
  assert.equal(seller.price?.usd, 0.07);
  assert.equal(seller.price?.comparable, true);
  db.close();
});

test('ranking is labelled a placeholder while no receipts exist', () => {
  const db = fixture();
  const before = findSellers(db, {});
  assert.equal(before.ranking.basis, 'registration_recency');
  assert.equal(before.ranking.placeholder, true);
  assert.match(before.ranking.note, /PLACEHOLDER/);
  // Newest registration first.
  assert.deepEqual(before.sellers.map((s) => s.agentId), ['1', '2', '3']);
  for (const s of before.sellers) assert.equal(s.rank.settledVolume, 0);

  // The seam: the moment MOV-220 writes receipts, ranking switches and stops
  // calling itself a placeholder. Nothing else has to change.
  db.prepare(`
    INSERT INTO settlement_receipt (receipt_id, agent_uid, amount, rail, settled_at)
    VALUES ('r1', 'eip155:11155111:0xreg/3', '5.00', 'x402', 1)
  `).run();
  const after = findSellers(db, {});
  assert.equal(after.ranking.basis, 'settled_volume');
  assert.equal(after.ranking.placeholder, false);
  assert.equal(after.sellers[0].agentId, '3');
  assert.equal(after.sellers[0].rank.settledVolume, 5);
  db.close();
});

test('World verification is a seam, and reports unknown for everyone', () => {
  // MOV-223 is blocked on Sandbox approval. Reporting "unverified" would be a
  // claim we have not earned; "unknown" is the true statement.
  const db = fixture();
  for (const s of findSellers(db, {}).sellers) assert.equal(s.worldVerification, 'unknown');
  db.close();
});

test('normalizePriceUsd refuses units it cannot convert', () => {
  assert.deepEqual(normalizePriceUsd('0.07', 'usd', 'turnstile').usd, 0.07);
  assert.deepEqual(normalizePriceUsd('70000', 'USDC', 'x402').usd, 0.07);
  // Already decimal: not a smallest-unit integer.
  assert.deepEqual(normalizePriceUsd('0.07', 'USDC', 'x402').usd, 0.07);
  assert.equal(normalizePriceUsd('1000', 'ETH', 'document').usd, null);
  assert.equal(normalizePriceUsd('1000', null, 'document').usd, null);
  assert.equal(normalizePriceUsd('not a number', 'USDC', 'x402').usd, null);
  assert.equal(normalizePriceUsd(null, 'USDC', 'x402').usd, null);
});

test('a null price says which kind of nothing it is', () => {
  // Both of these agents have `price: null`, and they are not the same case. One
  // advertises x402, so a price exists and could be quoted if its endpoint ever
  // answered; the other publishes no price anywhere and has nothing to ask. A
  // caller rendering a single row has only `priceSource` to tell them apart —
  // the aggregate counts cannot say which row is which.
  const db = fixture();
  const { sellers } = findSellers(db, { includeUnknownPrice: true });
  const bySource = Object.fromEntries(sellers.map((s) => [s.agentId, s.priceSource]));

  assert.equal(bySource['1'], 'ask_x402', 'x402Support and no quote is askable, not absent');
  assert.equal(bySource['2'], 'none', 'no price and no x402 is genuinely nothing');
  assert.equal(bySource['3'], 'turnstile', 'an ENS price record is the only readable source here');

  const askable = sellers.find((s) => s.agentId === '1');
  const nothing = sellers.find((s) => s.agentId === '2');
  assert.equal(askable?.price, null);
  assert.equal(nothing?.price, null);
  assert.notEqual(askable?.priceSource, nothing?.priceSource);
  db.close();
});
