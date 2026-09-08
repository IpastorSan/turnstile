import test from 'node:test';
import assert from 'node:assert/strict';

import { agentRegistrationKey, encodeErc7930 } from './ens.ts';

test('reproduces the ENSIP-25 specification example byte for byte', () => {
  // The specification's own worked example. A malformed key still stores and
  // still reads back — it is just invisible to every ENSIP-25 client — so the
  // only way to catch drift is to check against the spec rather than against
  // ourselves. contracts/test/OfferRecords.t.sol asserts the same string from
  // the Solidity side, which is what keeps the writer and the reader in step.
  assert.equal(
    agentRegistrationKey(1, '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432', 42),
    'agent-registration[0x000100000101148004a169fb4a3325136eb29fa0ceb6d2e539a432][42]',
  );
});

test('encodes the live Sepolia record we actually published', () => {
  // Read back from liquidity.turnstile.eth; see docs/ens-offer-records.md.
  assert.equal(
    agentRegistrationKey(11155111, '0x8004A818BFB912233c491871b3d84c89A494BD9e', 10127),
    'agent-registration[0x0001000003aa36a7148004a818bfb912233c491871b3d84c89a494bd9e][10127]',
  );
});

test('the chain reference is minimally encoded, with its own length prefix', () => {
  // 1 is one byte, 11155111 (0xaa36a7) is three, 8453 (0x2105) is two. A fixed
  // width would be wrong for all three.
  const addr = '0x' + '11'.repeat(20);
  assert.equal(encodeErc7930(1, addr).slice(0, 14), '0x000100000101');
  assert.equal(encodeErc7930(8453, addr).slice(0, 16), '0x00010000022105');
  assert.equal(encodeErc7930(11155111, addr).slice(0, 18), '0x0001000003aa36a7');
});

test('addresses are lowercased and length-prefixed', () => {
  const encoded = encodeErc7930(1, '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  assert.ok(encoded.endsWith('14' + 'aa'.repeat(20)), encoded);
});
