import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { encodePaymentRequiredHeader } from '@x402/core/http';

import { openDb, replaceEndpoints, upsertAgent } from './db.ts';
import { parseX402Body, parseX402Response, probeAgent, probeEndpoint, selectProbeCandidates } from './probe-x402.ts';

test('reads the headline requirement out of an x402 body', () => {
  const parsed = parseX402Body({
    x402Version: 1,
    accepts: [
      {
        scheme: 'exact', network: 'base', maxAmountRequired: '70000',
        asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        payTo: '0xseller', extra: { name: 'USDC', version: '2' },
      },
      { scheme: 'exact', network: 'arbitrum', maxAmountRequired: '80000' },
    ],
  });
  assert.equal(parsed.amount, '70000');
  assert.equal(parsed.currency, 'USDC');
  assert.equal(parsed.network, 'base');
  assert.equal(parsed.payTo, '0xseller');
});

test('falls back to a bare requirement with no accepts array', () => {
  assert.equal(parseX402Body({ maxAmountRequired: '1', scheme: 'exact' }).amount, '1');
  assert.equal(parseX402Body({ amount: '2' }).amount, '2');
});

test('a body with nothing usable yields nothing, not a zero', () => {
  assert.deepEqual(parseX402Body({}).amount, undefined);
  assert.deepEqual(parseX402Body(null), {});
  assert.deepEqual(parseX402Body('402'), {});
});

// --- x402 v2: the quote is in the PAYMENT-REQUIRED header (TUR-1) ----------

/**
 * Modelled on Capminal's live answer (agent eip155:8453:0x8004…a432/1380, read
 * 2026-10-16): x402 v2, the PaymentRequired object base64'd into a header, and a
 * body of `{}`. GET is 405; only POST quotes.
 */
const CAPMINAL_REQUIRED = {
  x402Version: 2,
  error: 'Payment required',
  resource: { url: 'https://www.capminal.ai/api/x402/deploy', description: 'Flash Clanker Token Deployment API', mimeType: 'application/json' },
  accepts: [{
    scheme: 'exact', network: 'eip155:8453', amount: '500000',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    payTo: '0xf9d1d63f362bbf1ee08ab9acb36fe74afc48d5f1',
    maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' },
  }],
};

const capminalHeader = (): string =>
  encodePaymentRequiredHeader(CAPMINAL_REQUIRED as unknown as Parameters<typeof encodePaymentRequiredHeader>[0]);

test('a v2 quote is read from the PAYMENT-REQUIRED header when the body is empty', () => {
  const { fields, from } = parseX402Response(capminalHeader(), '{}');
  assert.equal(from, 'header');
  assert.equal(fields.amount, '500000');
  assert.equal(fields.network, 'eip155:8453');
  assert.equal(fields.scheme, 'exact');
  assert.equal(fields.asset, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
  assert.equal(fields.payTo, '0xf9d1d63f362bbf1ee08ab9acb36fe74afc48d5f1');
  assert.equal(fields.currency, 'USD Coin');
});

test('a malformed header falls through to a v1 body that does quote', () => {
  const { fields, from } = parseX402Response('not base64 json', JSON.stringify({ accepts: [{ maxAmountRequired: '70000' }] }));
  assert.equal(from, 'body');
  assert.equal(fields.amount, '70000');
});

test('a 402 with neither carrying an amount is reported, not zeroed', () => {
  const { fields, from, error } = parseX402Response(null, '{}');
  assert.equal(from, null);
  assert.equal(fields.amount, undefined);
  assert.match(error ?? '', /no amount/);
});

/** A stand-in for capminal.ai: an MCP URL serving HTML, and a POST-only paid API. */
async function capminalLike(): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    if (req.url === '/mcp') {
      res.writeHead(200, { 'content-type': 'text/html' }).end('<!DOCTYPE html><html></html>');
    } else if (req.url === '/api/x402/deploy') {
      if (req.method !== 'POST') {
        res.writeHead(405).end();
      } else {
        res.writeHead(402, { 'content-type': 'application/json', 'payment-required': capminalHeader() }).end('{}');
      }
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}

test('probeEndpoint gets a v2 quote out of a POST-only endpoint that answers GET with 405', async () => {
  const srv = await capminalLike();
  try {
    const result = await probeEndpoint(`${srv.base}/api/x402/deploy`, 5_000, { allowPrivateHosts: true });
    assert.equal(result.status, 'quoted');
    assert.equal(result.amount, '500000');
    assert.equal(result.network, 'eip155:8453');
    // The stored evidence is the decoded header, not the empty body.
    assert.equal(JSON.parse(result.raw!).accepts[0].amount, '500000');
  } finally {
    await srv.close();
  }
});

test('probeAgent asks every endpoint, so a quote on a non-preferred service is found', async () => {
  const srv = await capminalLike();
  try {
    const results = await probeAgent([
      { name: 'MCP', uri: `${srv.base}/mcp` },
      { name: 'custom', uri: `${srv.base}/api/x402/deploy` },
      { name: 'twitter', uri: 'ipfs://not-http' },
    ], 5_000, { allowPrivateHosts: true });
    // MCP outranks `custom`, and is asked first — it is just not where the price is.
    assert.deepEqual(results.map((r) => r.endpoint.name), ['MCP', 'custom']);
    assert.equal(results[0].result.status, 'no_402');
    assert.equal(results[1].result.status, 'quoted');
    assert.equal(results[1].result.amount, '500000');
  } finally {
    await srv.close();
  }
});

test('the private-host guard still applies to every endpoint probeAgent asks', async () => {
  const results = await probeAgent([{ name: 'custom', uri: 'http://127.0.0.1:9/x' }], 1_000);
  assert.equal(results[0].result.status, 'blocked_host');
});

test('selectProbeCandidates returns every unasked http endpoint of an x402 agent', () => {
  const db = openDb(':memory:');
  upsertAgent(db, {
    agentUid: 'eip155:8453:0xreg/1380', namespace: 'eip155', chainId: 8453, network: 'base',
    registry: '0xreg', agentId: '1380', owner: '0xo', operator: '0xo', operatorSource: 'OWNER_DEFAULT',
    agentUri: 'https://a.example/card.json', uriScheme: 'HTTPS', inModuleResolved: true,
    lastEvent: 'REGISTERED', blockNumber: 1, blockTimestamp: 1, transactionHash: '0xt', logIndex: 0,
    x402Support: true,
  });
  replaceEndpoints(db, 'eip155:8453:0xreg/1380', 'in_module', [
    { name: 'MCP', uri: 'https://a.example/mcp' },
    { name: 'custom', uri: 'https://a.example/api/x402/deploy' },
    { name: 'ENS', uri: 'capminal.eth' },
  ], []);
  const [candidate] = selectProbeCandidates(db, 10);
  assert.deepEqual(candidate.endpoints.map((e) => e.name), ['MCP', 'custom']);

  db.prepare(`INSERT INTO x402_quote (agent_uid, endpoint, status, probed_at) VALUES (?, ?, 'no_402', 1)`)
    .run('eip155:8453:0xreg/1380', 'https://a.example/mcp');
  assert.deepEqual(selectProbeCandidates(db, 10)[0].endpoints.map((e) => e.name), ['custom']);
  db.close();
});
