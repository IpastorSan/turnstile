// The SSE endpoint, end to end with the SDK's own client — and the SSRF guard.
//
// Two halves on purpose:
//
//  - The transport test starts the real app, connects a real MCP client over
//    HTTP+SSE, lists tools and calls find_sellers. This is the thing that must
//    work on the public host because an ENS record points at it; a unit test
//    of routing alone would pass while the endpoint stayed broken.
//  - The guard tests pin the refusal list. The ranges are exactly what a
//    public process must never fetch: the GCP metadata address, the container
//    network, loopback. A regression here turns the endpoint into an internal
//    network scanner, which is the one way this "reads public data only"
//    service could do real damage.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

import { blockedUrl, createMcpApp, ipRangeBlocked } from './http-app.ts';
import { resolveStore } from './store.ts';

// ---------------------------------------------------------------------------
// The guard, as pure functions

test('the ranges a public process must never reach are all refused', () => {
  for (const ip of [
    '169.254.169.254', // GCP + AWS metadata
    '10.128.0.1', // the VPC the containers live on
    '127.0.0.1',
    '0.0.0.0',
    '172.17.0.3', // the docker bridge
    '192.168.1.1',
    '::1',
    '::ffff:127.0.0.1', // IPv4-mapped loopback must not sneak through
    'fd00::1', // unique local
    'fe80::1', // link-local
  ]) {
    assert.equal(ipRangeBlocked(ip), true, `${ip} should be blocked`);
  }
  for (const ip of ['8.8.8.8', '34.175.99.87', '2606:4700:4700::1111']) {
    assert.equal(ipRangeBlocked(ip), false, `${ip} should be allowed`);
  }
});

test('blockedUrl refuses private literals, non-http schemes and known metadata hostnames', () => {
  const guard = (host: string) => ipRangeBlocked(host);
  assert.equal(blockedUrl(new URL('http://169.254.169.254/key'), guard), true);
  assert.equal(blockedUrl(new URL('http://localhost:3210/'), guard), true);
  assert.equal(blockedUrl(new URL('http://metadata.google.internal/'), guard), true);
  assert.equal(blockedUrl(new URL('file:///etc/passwd'), guard), true);
  assert.equal(blockedUrl(new URL('http://example.com/'), guard), false);
});

// ---------------------------------------------------------------------------
// The endpoint, with a real client

const store = resolveStore(); // the repo snapshot — the same file the tools read
const app = createMcpApp({ store });
const server = createServer(app);
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

after(() => {
  server.close();
});

async function connect(name: string): Promise<Client> {
  const client = new Client({ name: 'guard-test', version: '0.0.0' });
  // 127.0.0.1 is the app itself; the guard is about what the *tools* fetch.
  await client.connect(new SSEClientTransport(new URL(`${origin}/${name}/sse`)));
  return client;
}

test('GET …/sse opens the stream and the client negotiates the four tools', async () => {
  const client = await connect('liquidity.turnstile.eth');
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map(tool => tool.name).sort(),
      ['find_sellers', 'get_offer', 'purchase', 'receipts'],
    );
  } finally {
    await client.close();
  }
});

test('find_sellers answers a real query over SSE from the mounted store', async () => {
  const client = await connect('liquidity.turnstile.eth');
  try {
    const result = await client.callTool({ name: 'find_sellers', arguments: { limit: 3 } });
    const text = (result.content as { type: string; text?: string }[]).find(c => c.type === 'text')?.text ?? '';
    // The snapshot holds 197 agents; a refusal or an empty store is the bug
    // this assertion exists to catch (it is the server's worst failure mode).
    assert.ok(/agent/i.test(text), `expected agents, got: ${text.slice(0, 160)}`);
  } finally {
    await client.close();
  }
});

test('POST /messages with no live session is a 400, not a crash', async () => {
  const response = await fetch(`${origin}/liquidity.turnstile.eth/messages?sessionId=made-up`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.ok, false);
});

test('two sessions are independent; closing one does not take the other', async () => {
  const a = await connect('a.eth');
  const b = await connect('b.eth');
  await a.listTools();
  await b.close();
  const { tools } = await a.listTools(); // still alive
  assert.equal(tools.length, 4);
  await a.close();
});
