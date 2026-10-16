// The price reader against a stubbed JSON-RPC endpoint (TUR-3).
//
// Sepolia is never touched. `makePublicClient` is a viem client over `http()`,
// which goes through `globalThis.fetch`, so the stub below exercises the real
// encoder, the real `readSellerOffer` and the real `priceTiers()` — everything
// between the resolver's bytes and the price on the 402.

import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, encodeAbiParameters, namehash, parseAbi } from 'viem';

import { PriceBook } from './pricing.ts';
import { ensPriceReader, manifestSeller } from './price-records.ts';

const RPC = 'http://rpc.invalid.test';
const seller = manifestSeller();

// Re-stated rather than imported, as web/lib/ens.test.ts does: graph/sink/ens.ts
// keeps its ABI private, and a test that re-states it fails if it changes.
const ABI = parseAbi([
  'function text(bytes32 node, string key) view returns (string)',
  'function addr(bytes32 node) view returns (address)',
]);

interface Chain { text: Record<string, string>; down?: boolean }

function stubRpc(chain: Chain): typeof globalThis.fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
    const respond = (payload: object) => new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...payload }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
    // -32000 rather than a dead socket: viem retries those with backoff, which
    // would cost this file seconds for the same branch.
    if (chain.down) return respond({ error: { code: -32000, message: 'upstream provider is unavailable' } });
    if (body.method === 'eth_blockNumber') return respond({ result: `0x${(9_000_000).toString(16)}` });
    const { to, data } = body.params[0] as { to: string; data: `0x${string}` };
    assert.equal(to.toLowerCase(), seller.resolver.toLowerCase(), 'read from the manifest resolver');
    const call = decodeFunctionData({ abi: ABI, data });
    if (call.functionName === 'addr') {
      return respond({ result: encodeAbiParameters([{ type: 'address' }], ['0x0000000000000000000000000000000000000000']) });
    }
    assert.equal(call.args[0], namehash(seller.ensName), 'read from the manifest name');
    return respond({ result: encodeAbiParameters([{ type: 'string' }], [chain.text[call.args[1] as string] ?? '']) });
  }) as typeof globalThis.fetch;
}

async function withChain<T>(chain: Chain, fn: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = stubRpc(chain);
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('the reader prices the tiers from the records on the seller name', async () => {
  const chain: Chain = { text: { 'turnstile:price': '0.07', 'turnstile:price-ceiling': '0.50' } };
  const state = await withChain(chain, () => new PriceBook({ read: ensPriceReader(RPC, seller) }).current());
  assert.ok(state.ok && !state.stale);
  assert.equal(state.tiers.standard.priceUsd, 0.07);
  assert.equal(state.tiers.premium.priceUsd, 0.35);
  assert.equal(state.tiers.ceilingUsd, 0.5);
  assert.equal(state.provenance, `${seller.ensName} at Sepolia block 9000000`);
});

test('an unset price record fails closed with the reason', async () => {
  const chain: Chain = { text: { 'turnstile:price-ceiling': '0.50' } };
  const state = await withChain(chain, () => new PriceBook({ read: ensPriceReader(RPC, seller) }).current());
  assert.deepEqual(state, { ok: false, reason: 'turnstile:price is not set' });
});

test('an unreachable RPC fails closed rather than reading as unset records', async () => {
  const state = await withChain({ text: {}, down: true }, () => new PriceBook({ read: ensPriceReader(RPC, seller) }).current());
  assert.equal(state.ok, false);
  assert.match(state.ok ? '' : state.reason, /upstream provider is unavailable/);
});

test('no RPC configured fails closed and names the variable', async () => {
  const state = await new PriceBook({ read: ensPriceReader(undefined, seller) }).current();
  assert.deepEqual(state, { ok: false, reason: 'SEPOLIA_RPC_URL is not set, so the price records cannot be read' });
});
