// `get_offer` has one job it must never get wrong: never let a published price
// pass for a payable quote. Most of what is below is that distinction, tested
// from both sides.

import test from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';

import { openDb, replaceEndpoints, upsertAgent } from '../graph/sink/db.ts';
import type { AgentRow } from '../graph/sink/db.ts';
import { classifyRef, getOffer, preferredEndpoint, sellerDeclaredUsd } from './offer.ts';

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

/**
 * Two agents: a stranger with an x402 endpoint, and a seller with an ENS price.
 *
 * Neither is the real one. A test that only passed against
 * `liquidity.turnstile.eth` would be pinning the wrong property — the claim
 * under test is that resolution is a function of data, not of a name.
 */
function fixture(): DatabaseSync {
  const db = openDb(':memory:');

  upsertAgent(db, agent({
    agentUid: 'eip155:8453:0xreg/1', name: 'Stranger Gas', x402Support: true, active: true,
  }));
  replaceEndpoints(db, 'eip155:8453:0xreg/1', 'in_module', [
    { name: 'twitter', uri: 'https://x.com/stranger' },
    { name: 'x402', uri: 'https://stranger.example/v1/quote' },
    { name: 'web', uri: 'https://stranger.example' },
  ], []);

  upsertAgent(db, agent({
    agentUid: 'eip155:11155111:0xreg/9', chainId: 11155111, network: 'sepolia', agentId: '9',
    name: 'someone.else.eth', x402Support: false, active: true,
  }));
  db.prepare(`
    INSERT INTO turnstile_seller (ens_name, node, resolver, chain_id, agent_uid, mcp_endpoint,
      price, price_ceiling, rails, payout_addr, resolver_verified, read_at)
    VALUES ('someone.else.eth', '0xnode', '0xresolver', 11155111, 'eip155:11155111:0xreg/9',
      'https://seller.example/mcp', '0.09', '0.25', 'x402', '0xpayout', 1, 1788000000)
  `).run();

  return db;
}

/** A 402 body shaped like the ones real rails emit. */
function challengeBody(amount: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    x402Version: 2,
    accepts: [{
      scheme: 'exact', network: 'hedera:testnet', asset: '0.0.0',
      maxAmountRequired: amount, payTo: '0.0.999', maxTimeoutSeconds: 300, extra,
    }],
  });
}

const respond = (status: number, body: string, headers: Record<string, string> = {}): Response =>
  new Response(body, { status, headers: { 'content-type': 'application/json', ...headers } });

test('an identifier is classified by shape, not by a list of known sellers', () => {
  assert.equal(classifyRef('https://example.com/x'), 'url');
  assert.equal(classifyRef('eip155:11155111:0x8004a818bfb912233c491871b3d84c89a494bd9e/10127'), 'agent_uid');
  // Loosely, so a registry that is not an EVM contract address still resolves.
  assert.equal(classifyRef('solana:mainnet:SomeProgram/42'), 'agent_uid');
  assert.equal(classifyRef('liquidity.turnstile.eth'), 'ens');
  assert.equal(classifyRef('anything.else.example'), 'ens');
  assert.equal(classifyRef('not an identifier'), 'unknown');
});

test('the endpoint worth paying is the one the agent nominated for payment', () => {
  // An agent listing an x402 service and a Twitter profile has told us which of
  // the two takes money. Falling through to whatever came first probes GitHub.
  const chosen = preferredEndpoint([
    { name: 'twitter', uri: 'https://x.com/a' },
    { name: 'mcp', uri: 'https://a.example/mcp' },
    { name: 'x402', uri: 'https://a.example/pay' },
  ]);
  assert.equal(chosen?.uri, 'https://a.example/pay');
});

test('an endpoint with no http URI is not an endpoint to buy from', () => {
  assert.equal(preferredEndpoint([{ name: 'x402', uri: 'ipfs://cid' }]), null);
});

test("a seller's own dollar figure is read out of extra, by either route", () => {
  assert.equal(sellerDeclaredUsd(challengeBody('84770051', { priceUsd: 0.07 }), '84770051'), 0.07);
  // Derived when priceUsd is absent: 24220015 tinybars at 8 decimals, 8.26c/HBAR.
  const derived = sellerDeclaredUsd(challengeBody('24220015', { decimals: 8, usdPerUnit: 0.0826 }), '24220015');
  assert.ok(derived !== null && Math.abs(derived - 0.02) < 0.001);
  assert.equal(sellerDeclaredUsd(challengeBody('1', {}), '1'), null);
  assert.equal(sellerDeclaredUsd(undefined, '1'), null);
});

test('a published price with a dead endpoint is reported AND refused', async () => {
  const db = fixture();
  const offer = await getOffer(db, 'someone.else.eth', {
    // The endpoint is unreachable, which is the point: the ENS record is real
    // and the host behind it is not.
    probeFn: async () => ({ status: 'network_error', error: 'getaddrinfo ENOTFOUND' }),
  });
  assert.equal(offer.published?.priceUsd, 0.09);
  assert.equal(offer.published?.ceilingUsd, 0.25);
  assert.equal(offer.purchasable.ok, false);
  assert.match(offer.purchasable.reason, /A published price is not a quote/);
  assert.match(offer.warnings.join(' '), /publishes an exact price on chain but the endpoint it names does not answer/);
  db.close();
});

test('probe: false is honest that nothing is buyable rather than assuming it is', async () => {
  const db = fixture();
  const offer = await getOffer(db, 'someone.else.eth', { probe: false });
  assert.equal(offer.offer.resource, 'https://seller.example/mcp');
  assert.equal(offer.published?.priceUsd, 0.09);
  assert.equal(offer.purchasable.ok, false);
  assert.match(offer.purchasable.reason, /probing was disabled/);
  db.close();
});

test('an unknown identifier fails with an explanation, not an exception', async () => {
  const db = fixture();
  const offer = await getOffer(db, 'nonsense here', {});
  assert.equal(offer.refKind, 'unknown');
  assert.equal(offer.purchasable.ok, false);
  assert.match(offer.warnings.join(' '), /is not an ENS name, an agentUid/);
  db.close();
});

test('an agentUid that is not in the store says so rather than returning nothing', async () => {
  const db = fixture();
  const offer = await getOffer(db, 'eip155:1:0x0000000000000000000000000000000000000000/7', { probe: false });
  assert.equal(offer.agent, null);
  assert.match(offer.warnings.join(' '), /not in the discovery store/);
  db.close();
});

test("an agent advertising x402 with no price reads as 'ask', never as free", async () => {
  const db = fixture();
  const offer = await getOffer(db, 'eip155:8453:0xreg/1', { probe: false });
  assert.equal(offer.offer.source, 'ask_x402');
  assert.equal(offer.offer.priceUsd, null);
  assert.equal(offer.published, null);
  // And the resource it would be quoted at is the one it nominated.
  assert.equal(offer.offer.resource, 'https://stranger.example/v1/quote');
  db.close();
});

test('a live quote supersedes the published price without erasing it', async () => {
  const db = fixture();
  const offer = await getOffer(db, 'someone.else.eth', {
    probeFn: async () => ({
      status: 'quoted', httpStatus: 402, amount: '84770051', asset: '0.0.0',
      network: 'hedera:testnet', scheme: 'exact', payTo: '0.0.999',
      raw: challengeBody('84770051', { priceUsd: 0.12 }),
    }),
  });
  assert.equal(offer.published?.priceUsd, 0.09, 'the published price survives');
  assert.equal(offer.offer.source, 'x402_live');
  assert.equal(offer.offer.priceUsd, 0.12, 'the live quote is what a payment is signed against');
  assert.equal(offer.offer.basis, 'seller_declared');
  assert.equal(offer.offer.comparable, false, "the seller's own arithmetic cannot check a budget");
  assert.equal(offer.purchasable.ok, true);
  // Two independent things went wrong and both are said out loud.
  const warnings = offer.warnings.join(' ');
  assert.match(warnings, /published price \(\$0.09\) and the live quote \(\$0.12\) disagree/);
  db.close();
});

test('a quote above the seller\'s own published ceiling is called out', async () => {
  const db = fixture();
  const offer = await getOffer(db, 'someone.else.eth', {
    probeFn: async () => ({
      status: 'quoted', httpStatus: 402, amount: '400000', currency: 'USDC',
      asset: 'usdc', network: 'eip155:8453', scheme: 'exact', payTo: '0xpayout',
      raw: challengeBody('400000'),
    }),
  });
  assert.equal(offer.offer.priceUsd, 0.4);
  assert.equal(offer.offer.basis, 'stablecoin_unit');
  assert.equal(offer.offer.comparable, true, 'a dollar stablecoin unit IS checkable');
  assert.match(offer.warnings.join(' '), /above the cold-key price ceiling of \$0.25/);
  db.close();
});

test('a URL ref skips the directory entirely', async () => {
  const db = fixture();
  const offer = await getOffer(db, 'https://never-seen.example/buy', {
    probeFn: async () => ({
      status: 'quoted', httpStatus: 402, amount: '20000', currency: 'USDC',
      asset: 'usdc', network: 'eip155:8453', scheme: 'exact', payTo: '0xstranger',
      raw: challengeBody('20000'),
    }),
  });
  assert.equal(offer.refKind, 'url');
  assert.equal(offer.agent, null);
  assert.equal(offer.ens, null);
  assert.equal(offer.published, null);
  assert.equal(offer.offer.priceUsd, 0.02);
  assert.equal(offer.offer.payTo, '0xstranger');
  assert.equal(offer.purchasable.ok, true);
  db.close();
});
