// The parser exists because real registrations do not match the spec. These
// cases are all shapes actually observed in the live directory, so a "cleanup"
// that tightens the parser fails here rather than silently emptying the store.

import test from 'node:test';
import assert from 'node:assert/strict';

import { isBlockedAddress, ipfsGatewayUrls, parseAgentDocument } from './card.ts';

test('reads the spec shape', () => {
  const doc = parseAgentDocument({
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: 'Captain Dackie',
    description: 'A DeFAI agent',
    image: 'https://example.com/a.jpg',
    active: true,
    x402Support: true,
    supportedTrust: ['reputation'],
    services: [{ name: 'MCP', endpoint: 'https://example.com/mcp', version: '2025-01-15' }],
  });
  assert.equal(doc.name, 'Captain Dackie');
  assert.equal(doc.x402Support, true);
  assert.deepEqual(doc.supportedTrust, ['reputation']);
  assert.deepEqual(doc.endpoints, [
    { name: 'MCP', uri: 'https://example.com/mcp', version: '2025-01-15', skills: undefined, domains: undefined },
  ]);
});

test('reads the field names that drift from the spec', () => {
  // `endpoints` for `services` (31 of 441 service arrays), `x402support`
  // lowercase (41 of 1,200), `supportedTrusts` plural (31 of 1,200).
  const doc = parseAgentDocument({
    endpoints: [{ type: 'x402', url: 'https://example.com/api' }],
    x402support: true,
    supportedTrusts: ['crypto-economic', 'tee-attestation'],
  });
  assert.equal(doc.x402Support, true);
  assert.deepEqual(doc.supportedTrust, ['crypto-economic', 'tee-attestation']);
  assert.equal(doc.endpoints?.[0].name, 'x402');
  assert.equal(doc.endpoints?.[0].uri, 'https://example.com/api');
});

test('accepts every spelling of an endpoint URL', () => {
  for (const key of ['endpoint', 'url', 'serviceEndpoint', 'uri', 'value']) {
    const doc = parseAgentDocument({ services: [{ name: 'web', [key]: 'https://example.com/x' }] });
    assert.equal(doc.endpoints?.[0].uri, 'https://example.com/x', `failed for key ${key}`);
  }
});

test('an MCP service contributes its tools as skills, but not its protocol capabilities', () => {
  // `capabilities: ["tools","resources","prompts"]` is the MCP handshake,
  // identical on every MCP endpoint in the directory. Indexing it would file
  // thousands of agents under a capability nobody would search for.
  const doc = parseAgentDocument({
    services: [{
      name: 'MCP',
      endpoint: 'https://example.com/mcp',
      tools: ['execute_swap', 'check_balance'],
      capabilities: ['tools', 'resources', 'prompts'],
    }],
  });
  assert.deepEqual(doc.endpoints?.[0].skills, ['execute_swap', 'check_balance']);
});

test('a single service object is as good as an array of one', () => {
  const doc = parseAgentDocument({ services: { name: 'web', endpoint: 'https://example.com' } });
  assert.equal(doc.endpoints?.length, 1);
});

test('an unrecognised document is empty, not an error', () => {
  assert.deepEqual(parseAgentDocument({ something: 'else' }).name, undefined);
  assert.deepEqual(parseAgentDocument([]), {});
  assert.deepEqual(parseAgentDocument('a string'), {});
  assert.deepEqual(parseAgentDocument(null), {});
});

test('a price is read when published, and is expected to be absent', () => {
  // Zero of 1,200 live registrations carried a price: EIP-8004 registration-v1
  // has no price field. The parser handles one anyway so that the day an agent
  // publishes one we notice, rather than the field silently never firing.
  assert.equal(parseAgentDocument({ name: 'x' }).price, undefined);
  const priced = parseAgentDocument({ price: { amount: '70000', currency: 'USDC', network: 'base' } });
  assert.equal(priced.price?.amount, '70000');
  assert.equal(priced.price?.currency, 'USDC');
  // An x402-shaped requirement uses maxAmountRequired for the same thing.
  assert.equal(parseAgentDocument({ pricing: { maxAmountRequired: '1000' } }).price?.amount, '1000');
});

test('refuses to fetch private and metadata addresses', () => {
  // agentURI is attacker-controlled: anyone can register an agent pointing at
  // the sink's own network or at cloud metadata.
  for (const addr of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.0.1', '169.254.169.254', '::1', '0.0.0.0']) {
    assert.equal(isBlockedAddress(addr), true, `${addr} should be blocked`);
  }
  for (const addr of ['8.8.8.8', '1.1.1.1', '104.18.32.7']) {
    assert.equal(isBlockedAddress(addr), false, `${addr} should be allowed`);
  }
});

test('ipfs URIs fan out over gateways in order', () => {
  const urls = ipfsGatewayUrls('ipfs://bafyabc/card.json', ['https://a/ipfs/', 'https://b/ipfs/']);
  assert.deepEqual(urls, ['https://a/ipfs/bafyabc/card.json', 'https://b/ipfs/bafyabc/card.json']);
});
