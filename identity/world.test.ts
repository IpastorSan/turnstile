// The signal check: is a proof bound to the listing the request names?

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hashSignal } from '@worldcoin/idkit-core/hashing';

import { checkSignal } from './world.ts';

const LISTING = 'liquidity.turnstile.eth';

function result(...signalHashes: (string | undefined)[]) {
  return {
    protocol_version: '3.0',
    nonce: 'n',
    environment: 'sandbox',
    responses: signalHashes.map(signal_hash => ({ identifier: 'selfie', proof: '0x', merkle_root: '0x', nullifier: '0xn', signal_hash })),
  };
}

test('a proof made for the named listing passes and says it was checked', () => {
  assert.deepEqual(checkSignal(result(hashSignal(LISTING)), LISTING), { ok: true, checked: true });
});

test('a proof made for a different listing is refused', () => {
  const check = checkSignal(result(hashSignal('depth.turnstile.eth')), LISTING);
  assert.equal(check.ok, false);
});

test('the check is on the exact string: the canonical uid is not the signal', () => {
  // The client signs the name it picked. The server stores under the uid, but
  // must check the proof against the name, or every real proof would fail.
  const check = checkSignal(result(hashSignal(LISTING)), 'eip155:11155111:0x8004a818bfb912233c491871b3d84c89a494bd9e/10127');
  assert.equal(check.ok, false);
});

test('every signal hash present has to match', () => {
  assert.equal(checkSignal(result(hashSignal(LISTING), hashSignal('other')), LISTING).ok, false);
});

test('no signal hash at all is let through, flagged as unchecked', () => {
  assert.deepEqual(checkSignal(result(undefined), LISTING), { ok: true, checked: false });
  assert.deepEqual(checkSignal({}, LISTING), { ok: true, checked: false });
});
