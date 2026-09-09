// `readOffer` is the seller page's only data source, so every failure mode here
// is something a judge sees instead of the demo.
//
// The rule the module is built around is that the price on the page is the price
// on chain at the moment of the read — never a cached one. That makes the
// *failure* branches the interesting ones: each of them has to produce a legible
// "we could not read this", because the alternative the module rejects is
// showing a stale number that looks fine.
//
// Sepolia is never touched. `makePublicClient` is a viem client over `http()`,
// which goes through `globalThis.fetch`, so a JSON-RPC stub installed here
// exercises the real encoder, the real decoder and the real per-record error
// handling — the parts that would actually drift.

import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeFunctionData, encodeAbiParameters, parseAbi, namehash } from 'viem';

import { findSeller, knownSellers, readOffer } from './ens.ts';
import { agentRegistrationKey } from '../../graph/sink/ens.ts';
import { PERMISSIONED_RESOLVER_IMPL } from '../../graph/sink/sellers.ts';

const RPC = 'http://rpc.invalid.test';
const ZERO = '0x0000000000000000000000000000000000000000';

// Declared here rather than imported: graph/sink/ens.ts keeps its ABI private,
// and a test that re-states the signatures fails loudly if they change under it.
const ABI = parseAbi([
  'function text(bytes32 node, string key) view returns (string)',
  'function addr(bytes32 node) view returns (address)',
  'function verifyContract(address proxy) view returns (address)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function ownerOf(uint256 tokenId) view returns (address)',
]);

const seller = knownSellers()[0]!;
const REGISTRATION_KEY = agentRegistrationKey(seller.chainId, seller.identityRegistry, seller.agentId);

const encodeString = (value: string) => encodeAbiParameters([{ type: 'string' }], [value]);
const encodeAddress = (value: string) => encodeAbiParameters([{ type: 'address' }], [value as `0x${string}`]);

interface Chain {
  /** Resolver text records. A key that is absent answers `""`, as a real one does. */
  text?: Record<string, string>;
  addr?: string;
  /** What VerifiableFactory.verifyContract returns for the resolver. */
  implementation?: string;
  tokenUri?: string;
  owner?: string;
  blockNumber?: bigint;
  /**
   * Fail every RPC call. Answered as a server-error (-32000) JSON-RPC response
   * rather than a dead socket or a -32603 on purpose: viem retries both of those
   * three times with backoff, and `readSellerOffer` makes five sequential
   * rounds of reads, so the same `catch` would cost this file five seconds.
   */
  down?: boolean;
}

function stubRpc(chain: Chain): typeof globalThis.fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
    if (chain.down) {
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'upstream provider is unavailable' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    const reply = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    if (body.method === 'eth_blockNumber') return reply(`0x${(chain.blockNumber ?? 9_000_000n).toString(16)}`);
    if (body.method !== 'eth_call') throw new Error(`unstubbed RPC method ${body.method}`);

    const { data } = body.params[0] as { data: `0x${string}` };
    const call = decodeFunctionData({ abi: ABI, data });
    switch (call.functionName) {
      case 'text':
        return reply(encodeString(chain.text?.[call.args[1] as string] ?? ''));
      case 'addr':
        return reply(encodeAddress(chain.addr ?? ZERO));
      case 'verifyContract':
        return reply(encodeAddress(chain.implementation ?? ZERO));
      case 'tokenURI':
        // A registry that has never minted this id reverts. Answering an empty
        // string instead would look like a name that points nowhere, which is a
        // different finding.
        if (chain.tokenUri === undefined) return reply('0x');
        return reply(encodeString(chain.tokenUri));
      case 'ownerOf':
        if (chain.owner === undefined) return reply('0x');
        return reply(encodeAddress(chain.owner));
      default:
        throw new Error(`unstubbed call ${call.functionName}`);
    }
  }) as typeof globalThis.fetch;
}

async function offerFrom(chain: Chain, name = seller.ensName): ReturnType<typeof readOffer> {
  const realFetch = globalThis.fetch;
  const realRpc = process.env['SEPOLIA_RPC_URL'];
  globalThis.fetch = stubRpc(chain);
  process.env['SEPOLIA_RPC_URL'] = RPC;
  try {
    return await readOffer(name);
  } finally {
    globalThis.fetch = realFetch;
    if (realRpc === undefined) delete process.env['SEPOLIA_RPC_URL'];
    else process.env['SEPOLIA_RPC_URL'] = realRpc;
  }
}

/** The records a fully published seller has on chain. */
const published = (): Chain => ({
  text: {
    'agent-context': 'Uniswap v4 pool analysis',
    'agent-endpoint[mcp]': 'https://seller.example/mcp',
    'turnstile:price': '0.07',
    'turnstile:price-ceiling': '0.25',
    'turnstile:rails': 'arc-usdc,hedera-x402',
    'turnstile:operator-proof': 'world-id',
    [REGISTRATION_KEY]: seller.ensName,
  },
  addr: '0x0Adca6e14bA956201D221feC767e4f24194bf5F2',
  implementation: PERMISSIONED_RESOLVER_IMPL,
  tokenUri: seller.ensName,
  owner: '0x0Adca6e14bA956201D221feC767e4f24194bf5F2',
});

// --- identity, before any network is involved ---------------------------------

test('the seller comes from the deployment manifest, never from a literal', () => {
  // MOV-218's rule: renaming the seller changes one file and the site follows.
  // If this list is ever empty the page has no data source at all, and the
  // failure would otherwise surface as "no seller named …" — a misleading
  // message, since the name is not the problem.
  const sellers = knownSellers();
  assert.ok(sellers.length > 0, 'the manifest yielded no sellers');
  assert.match(sellers[0]!.ensName, /\.eth$/);
  assert.equal(sellers[0]!.permissionedResolverImpl, PERMISSIONED_RESOLVER_IMPL);
  assert.equal(sellers[0]!.uid, `eip155:${seller.chainId}:${seller.identityRegistry.toLowerCase()}/${seller.agentId}`);
});

test('a name is matched case-insensitively and after trimming', () => {
  // ENS names are case-insensitive and a name pasted out of a wallet arrives
  // with whitespace. Both would otherwise 404 a seller that exists.
  assert.equal(findSeller(`  ${seller.ensName.toUpperCase()}  `)?.ensName, seller.ensName);
  assert.equal(findSeller('nobody.turnstile.eth'), null);
});

test('a name that is not in the manifest is refused before any RPC call', async () => {
  // No fetch stub and no RPC configuration are installed for this one, so the
  // only way it can answer at all is by refusing before the client is built.
  const result = await readOffer('definitely-not-ours.eth');
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.ensName, null);
  assert.match(result.ok === false ? result.reason : '', /is in the deployment manifest/);
});

test('a malformed name is refused the same way, rather than reaching namehash', async () => {
  for (const name of ['', '   ', 'not a name', '../../etc/passwd']) {
    const result = await readOffer(name);
    assert.equal(result.ok, false, `${JSON.stringify(name)} was accepted`);
  }
});

// --- the read cannot happen ---------------------------------------------------

test('with no RPC configured it says so, instead of serving a cached price', async () => {
  // The whole reason this module exists rather than a JSON fixture. A price that
  // was not read live is not a price the page can vouch for, so the records are
  // withheld — and the reason has to say that, because a blank page looks like
  // a bug and invites someone to "fix" it with a cache.
  const rpc = process.env['SEPOLIA_RPC_URL'];
  const publicRpc = process.env['NEXT_PUBLIC_SEPOLIA_RPC_URL'];
  delete process.env['SEPOLIA_RPC_URL'];
  delete process.env['NEXT_PUBLIC_SEPOLIA_RPC_URL'];
  try {
    const result = await readOffer(seller.ensName);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.ensName, seller.ensName, 'the name is known even when the read is not possible');
    assert.match(result.ok === false ? result.reason : '', /SEPOLIA_RPC_URL is not set/);
    assert.match(result.ok === false ? result.reason : '', /rather than served from cache/);
  } finally {
    if (rpc !== undefined) process.env['SEPOLIA_RPC_URL'] = rpc;
    if (publicRpc !== undefined) process.env['NEXT_PUBLIC_SEPOLIA_RPC_URL'] = publicRpc;
  }
});

test('an RPC that is down is reported as a failed read, not as an empty offer', async () => {
  // `readSellerOffer` swallows a failure on every individual record, so the only
  // call that can surface an outage is the block-number read at the end. That
  // makes this branch load-bearing: without it a dead RPC would render as a
  // seller whose every record happens to be unset.
  const result = await offerFrom({ down: true });
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.reason : '', /Sepolia read failed/);
  assert.equal(result.ok === false && result.ensName, seller.ensName);
});

// --- the read happens -------------------------------------------------------

test('a published seller reads back every record, live', async () => {
  const result = await offerFrom(published());
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.ensName, seller.ensName);
  assert.equal(result.node, namehash(seller.ensName));
  assert.equal(result.readAtBlock, 9_000_000);
  assert.equal(result.offer.price, '0.07');
  assert.equal(result.offer.priceCeiling, '0.25');
  assert.equal(result.offer.resolverVerified, true);

  const byKey = new Map(result.records.map(r => [r.key, r]));
  assert.equal(byKey.get('turnstile:price')?.value, '0.07');
  assert.equal(byKey.get('agent-endpoint[mcp]')?.value, 'https://seller.example/mcp');
  assert.equal(byKey.get('addr')?.value, '0x0Adca6e14bA956201D221feC767e4f24194bf5F2');
  // The ENSIP-25 key is computed from the manifest, not written down. If the
  // encoder drifts, the record silently stops being visible to standard clients.
  assert.ok(byKey.has(REGISTRATION_KEY), `no record for ${REGISTRATION_KEY}`);
  // Both directions agree: the name names the agent and the registry names the
  // name back. This is the claim the seller page makes in one word.
  assert.equal(result.linked, true);
  assert.equal(result.backlink.tokenUri, seller.ensName);
});

test('an unset key reads as null, never as an empty string or a stale value', async () => {
  // A resolver that answers nothing is a normal state, not a failure: the page
  // shows the row with no value rather than dropping it, so a missing price is
  // visibly missing rather than invisible.
  const result = await offerFrom({ implementation: PERMISSIONED_RESOLVER_IMPL });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.records.length, 8, 'a row was dropped rather than shown empty');
  for (const record of result.records) {
    assert.equal(record.value, null, `${record.key} should have no value`);
  }
  assert.equal(result.offer.payoutAddr, undefined, 'the zero address must not be shown as a payout address');
  assert.equal(result.linked, false);
});

test('one unset record does not take down the other seven', async () => {
  // Each read is caught individually for exactly this case. A seller mid-setup
  // must still show what it has published.
  const chain = published();
  delete chain.text!['turnstile:price'];
  const result = await offerFrom(chain);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const byKey = new Map(result.records.map(r => [r.key, r]));
  assert.equal(byKey.get('turnstile:price')?.value, null);
  assert.equal(byKey.get('turnstile:price-ceiling')?.value, '0.25', 'a neighbouring record was lost with the unset one');
  assert.equal(byKey.get('agent-context')?.value, 'Uniswap v4 pool analysis');
});

test('a name claiming an agent the registry does not point back at is not linked', async () => {
  // The negative control on the two-way link, and the one that only fires when
  // something is wrong. A name can assert any agent id it likes; only the
  // ERC-8004 registry can corroborate it, and half a link must not read as one.
  const chain = published();
  chain.tokenUri = 'someone-else.turnstile.eth';
  const result = await offerFrom(chain);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.offer.agentRegistrationConfirmed, true, 'the ENS half of the link is still present');
  assert.equal(result.linked, false, 'a one-way claim was reported as a confirmed two-way link');
});

test('a registry that has never minted the agent id leaves the offer readable', async () => {
  // `readAgentBacklink` catches its own failures: an agent id that does not
  // exist is a finding to show, not an error that costs the page its records.
  const chain = published();
  delete chain.tokenUri;
  delete chain.owner;
  const result = await offerFrom(chain);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.backlink, {});
  assert.equal(result.linked, false);
  assert.equal(result.offer.price, '0.07', 'the records were lost with the backlink');
});

test('a resolver that is not the verified implementation is reported unverified', async () => {
  // The attack this defends against is a resolver that answers honestly for a
  // while and then lies. `verifyContract` proving a different implementation is
  // the only signal, and it must not be conflated with a failed read.
  const chain = published();
  chain.implementation = '0x1111111111111111111111111111111111111111';
  const result = await offerFrom(chain);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.offer.resolverVerified, false);
  assert.equal(result.offer.resolverImplementation, '0x1111111111111111111111111111111111111111');
});
