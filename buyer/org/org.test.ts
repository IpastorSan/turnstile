// The warm tier, offline.
//
// What these tests are for is the part a live run cannot check: that the request
// we sign is the request we send. A successful call to Privy proves the happy
// path, and the happy path is the one that gets attention — but a signature over
// a *different* URL, a body with a key we dropped, or a header we forgot to
// include is a 401 that looks like a credentials problem and is not. Every one
// of those is asserted here against a fake `fetch`.
//
// The live behaviour these mirror was captured from the real API on 2026-09-07
// and is written up in `docs/privy-mandate.md`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify as ecdsaVerify } from 'node:crypto';

import { canonicalize, generateAuthorizationKey, loadAuthorizationKey, signAuthorizationPayload } from './authorization-key.ts';
import { PrivyClient, PrivyError } from './privy.ts';
import { createKeyQuorum } from './operators.ts';
import { fundAgentMandate } from './fund-agent.ts';

// --- canonicalization --------------------------------------------------------

test('canonicalize sorts object keys, as RFC 8785 requires', () => {
  assert.equal(canonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalize({ url: 'u', method: 'POST', body: { z: 1, a: 2 } }), '{"body":{"a":2,"z":1},"method":"POST","url":"u"}');
});

test('canonicalize drops undefined members and emits no whitespace', () => {
  assert.equal(canonicalize({ a: 1, b: undefined, c: 'x' }), '{"a":1,"c":"x"}');
  assert.equal(canonicalize([1, 'two', true, null]), '[1,"two",true,null]');
});

test('canonicalize refuses a non-integer rather than serializing it wrong', () => {
  // RFC 8785 mandates ECMAScript Number::toString for these. Half-implementing
  // it would produce a signature that fails at Privy with no local symptom, so
  // the failure belongs here instead.
  assert.throws(() => canonicalize({ price: 0.35 }), /only safe integers/);
});

// --- keys --------------------------------------------------------------------

test('a generated key signs something its own public half verifies', () => {
  const key = generateAuthorizationKey();
  const payload = { version: 1, method: 'POST', url: 'https://api.privy.io/v1/policies', body: { a: 1 }, headers: {} } as const;
  const signature = signAuthorizationPayload(key.privateKey, payload);

  const publicKey = createPublicKey({ key: Buffer.from(key.publicKey, 'base64'), format: 'der', type: 'spki' });
  assert.ok(ecdsaVerify('sha256', Buffer.from(canonicalize(payload), 'utf8'), publicKey, Buffer.from(signature, 'base64')));
});

test('a signature does not verify against a different body — this is what stops replay', () => {
  const key = generateAuthorizationKey();
  const url = 'https://api.privy.io/v1/policies/abc';
  const signature = signAuthorizationPayload(key.privateKey, { version: 1, method: 'PATCH', url, body: { cap: 250000 }, headers: {} });

  const publicKey = createPublicKey({ key: Buffer.from(key.publicKey, 'base64'), format: 'der', type: 'spki' });
  const tampered = canonicalize({ version: 1, method: 'PATCH', url, body: { cap: 25_000_000 }, headers: {} });
  assert.equal(ecdsaVerify('sha256', Buffer.from(tampered, 'utf8'), publicKey, Buffer.from(signature, 'base64')), false);
});

test('loadAuthorizationKey strips Privy\'s wallet-auth: prefix and re-derives the public half', () => {
  const generated = generateAuthorizationKey();
  const reloaded = loadAuthorizationKey(`wallet-auth:${generated.privateKey}`);
  assert.equal(reloaded.privateKey, generated.privateKey);
  assert.equal(reloaded.publicKey, generated.publicKey);
});

// --- the client --------------------------------------------------------------

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function fakePrivy(responses: unknown[] = [{ ok: true }]): { client: PrivyClient; calls: Captured[] } {
  const calls: Captured[] = [];
  let index = 0;
  const client = new PrivyClient({
    appId: 'app-123',
    appSecret: 'secret-456',
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method ?? 'GET',
        headers: init?.headers as Record<string, string>,
        body: init?.body as string | undefined,
      });
      const body = responses[Math.min(index, responses.length - 1)];
      index += 1;
      const status = typeof body === 'object' && body !== null && 'status' in body ? (body as { status: number }).status : 200;
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof globalThis.fetch,
  });
  return { client, calls };
}

test('every request carries basic auth and the privy-app-id header', async () => {
  const { client, calls } = fakePrivy();
  await client.get('/v1/wallets');
  const call = calls[0]!;
  assert.equal(call.headers['privy-app-id'], 'app-123');
  assert.equal(call.headers['authorization'], `Basic ${Buffer.from('app-123:secret-456').toString('base64')}`);
});

test('an unapproved mutation carries no signature header at all', async () => {
  const { client, calls } = fakePrivy();
  await client.post('/v1/wallets', { chain_type: 'ethereum' });
  assert.equal(calls[0]!.headers['privy-authorization-signature'], undefined);
});

test('two approvals become one comma-separated header, and both verify over the sent body', async () => {
  const alice = generateAuthorizationKey();
  const bob = generateAuthorizationKey();
  const { client, calls } = fakePrivy();

  const body = { name: 'raised', rules: [{ cap: 1 }] };
  await client.patch('/v1/policies/pol-1', body, { approvals: [alice, bob] });

  const call = calls[0]!;
  const signatures = call.headers['privy-authorization-signature']!.split(',');
  assert.equal(signatures.length, 2);

  // The payload Privy will reconstruct on its side: the URL it was sent to, the
  // body verbatim, and only the privy- prefixed headers. If this file and
  // `privy.ts` ever disagree about that shape, this assertion is what catches it.
  const expected = canonicalize({
    version: 1,
    method: 'PATCH',
    url: 'https://api.privy.io/v1/policies/pol-1',
    body,
    headers: { 'privy-app-id': 'app-123' },
  });
  for (const [key, signature] of [[alice, signatures[0]!], [bob, signatures[1]!]] as const) {
    const publicKey = createPublicKey({ key: Buffer.from(key.publicKey, 'base64'), format: 'der', type: 'spki' });
    assert.ok(ecdsaVerify('sha256', Buffer.from(expected, 'utf8'), publicKey, Buffer.from(signature, 'base64')), 'signature must verify over the canonical payload');
  }
  assert.equal(call.body, JSON.stringify(body), 'the signed body and the sent body must be the same object');
});

test('the idempotency key is signed as well as sent — otherwise it could be swapped in flight', async () => {
  const alice = generateAuthorizationKey();
  const { client, calls } = fakePrivy();
  await client.post('/v1/policies', { name: 'p' }, { approvals: [alice], idempotencyKey: 'idem-1' });

  const call = calls[0]!;
  assert.equal(call.headers['privy-idempotency-key'], 'idem-1');
  const expected = canonicalize({
    version: 1,
    method: 'POST',
    url: 'https://api.privy.io/v1/policies',
    body: { name: 'p' },
    headers: { 'privy-app-id': 'app-123', 'privy-idempotency-key': 'idem-1' },
  });
  const publicKey = createPublicKey({ key: Buffer.from(alice.publicKey, 'base64'), format: 'der', type: 'spki' });
  assert.ok(ecdsaVerify('sha256', Buffer.from(expected, 'utf8'), publicKey, Buffer.from(call.headers['privy-authorization-signature']!, 'base64')));
});

test('signing a GET is refused rather than silently ignored', async () => {
  const { client } = fakePrivy();
  await assert.rejects(() => client.request('GET', '/v1/wallets', undefined, { approvals: [generateAuthorizationKey()] }), /only checks authorization signatures on mutations/);
});

test('PrivyError separates "one approval short" from every other failure', () => {
  assert.equal(new PrivyError('PATCH', '/v1/policies/p', 401, { code: 'invalid_data' }).isMissingApproval, true);
  assert.equal(new PrivyError('POST', '/v1/wallets/w/rpc', 400, { code: 'policy_violation' }).isMissingApproval, false);
});

// --- quorums -----------------------------------------------------------------

const stubOperator = (handle: string) => ({ handle, role: 'test', userId: `did:privy:${handle}`, walletAddress: '0x0', key: generateAuthorizationKey() });

test('a quorum threshold above its membership is refused, not created', async () => {
  const { client } = fakePrivy();
  await assert.rejects(
    () => createKeyQuorum(client, { displayName: 'impossible', members: [stubOperator('a')], threshold: 2 }),
    /would lock the org out/,
  );
});

test('a quorum sends every member\'s public key and the threshold', async () => {
  const { client, calls } = fakePrivy([{ id: 'kq1' }]);
  const members = [stubOperator('a'), stubOperator('b')];
  await createKeyQuorum(client, { displayName: 'board', members, threshold: 2 });
  const body = JSON.parse(calls[0]!.body!);
  assert.deepEqual(body.public_keys, members.map(m => m.key.publicKey));
  assert.equal(body.authorization_threshold, 2);
});

// --- the treasury operation --------------------------------------------------

const AGENT = '0x0633a193017939Bb1eB242982397224c66948e2F';
const ORG = '0x3De96375140717193f52c220Df5Ec460971cbE84';

test('funding the agent asks the ORG wallet to sign, and names the AGENT as depositor', async () => {
  // The invariant, as a unit test rather than a comment: nothing on this path
  // may ask the agent to sign anything, because a signature is a transaction is
  // gas, and the agent's nonce staying 0 is the whole evidence.
  const signed: { walletId: string; body: unknown }[] = [];
  const client = new PrivyClient({
    appId: 'a',
    appSecret: 's',
    fetch: (async (url: string | URL, init?: RequestInit) => {
      const match = /\/v1\/wallets\/([^/]+)\/rpc$/.exec(String(url));
      assert.ok(match, `unexpected call to ${url}`);
      signed.push({ walletId: match[1]!, body: JSON.parse(init!.body as string) });
      return new Response(JSON.stringify({ method: 'eth_signTransaction', data: { signed_transaction: '0x02deadbeef' } }), { status: 200 });
    }) as unknown as typeof globalThis.fetch,
  });

  // A stub Arc: an allowance already high enough (so no approve), a nonce, fees,
  // and a receipt. Keeps this test offline while still exercising the ordering.
  const rpc = async (_url: string | URL, init?: RequestInit): Promise<Response> => {
    const { id, method } = JSON.parse(init!.body as string) as { id: number; method: string };
    const result = ({
      eth_call: '0x000000000000000000000000000000000000000000000000000000000fffffff', // allowance, huge
      eth_getTransactionCount: '0x7',
      eth_gasPrice: '0x3b9aca00',
      eth_maxPriorityFeePerGas: '0xf4240',
      eth_chainId: '0x4cef52',
      eth_blockNumber: '0x1',
      eth_sendRawTransaction: '0xaaa',
      eth_getTransactionReceipt: { status: '0x1', blockNumber: '0x1', transactionHash: '0xaaa', logs: [], type: '0x2' },
      eth_getBlockByNumber: { number: '0x1', baseFeePerGas: '0x3b9aca00', timestamp: '0x1', transactions: [], gasLimit: '0x1', gasUsed: '0x0', hash: '0x1', parentHash: '0x0', miner: '0x0', extraData: '0x', logsBloom: '0x', difficulty: '0x0', nonce: '0x0', sha3Uncles: '0x0', size: '0x0', stateRoot: '0x0', receiptsRoot: '0x0', transactionsRoot: '0x0', uncles: [], mixHash: '0x0', totalDifficulty: '0x0' },
    } as Record<string, unknown>)[method];
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { headers: { 'content-type': 'application/json' } });
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = rpc as unknown as typeof globalThis.fetch;
  try {
    const result = await fundAgentMandate({
      privy: client,
      walletId: 'org-wallet-id',
      walletAddress: ORG,
      agentAddress: AGENT,
      amountUsd: 0.25,
      approvals: [generateAuthorizationKey()],
    });
    assert.equal(result.depositor, AGENT);
    assert.equal(result.amount, 250000n);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(signed.length, 1, 'allowance was sufficient, so only the deposit should be signed');
  const request = signed[0]!;
  assert.equal(request.walletId, 'org-wallet-id', 'the ORG wallet signs — never the agent');
  const transaction = (request.body as { params: { transaction: { data: string; nonce: number } } }).params.transaction;
  assert.equal(transaction.nonce, 7, 'the nonce must be the ORG wallet\'s, read from chain');
  // `depositFor(address,address,uint256)` with the agent as the second argument.
  assert.ok(transaction.data.toLowerCase().includes(AGENT.slice(2).toLowerCase()), 'the agent must appear as the depositor');
});
