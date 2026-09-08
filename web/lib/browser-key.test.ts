// The signature-format conversion, checked against Node's own verifier.
//
// This is the one piece of the browser flow that fails silently when wrong: a
// raw r‖s signature is the right length and well-formed, and Privy simply
// rejects it. So rather than trust the encoding by eye, every case here signs
// with WebCrypto (which emits raw, exactly as a browser does), converts, and
// asks Node's `crypto.verify` — a completely independent implementation, and
// the same one Privy's server side is equivalent to — whether the DER is valid.

import assert from 'node:assert/strict';
import { createPublicKey, verify as ecdsaVerify, webcrypto } from 'node:crypto';
import { test } from 'node:test';

import { derFromRaw } from './browser-key.ts';

const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const;

function pem(base64: string): string {
  return `-----BEGIN PUBLIC KEY-----\n${(base64.match(/.{1,64}/g) ?? []).join('\n')}\n-----END PUBLIC KEY-----\n`;
}

function toBase64(buffer: ArrayBuffer): string {
  return Buffer.from(new Uint8Array(buffer)).toString('base64');
}

async function signAndVerify(message: string): Promise<boolean> {
  const pair = await webcrypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);
  const spki = await webcrypto.subtle.exportKey('spki', pair.publicKey);
  const raw = new Uint8Array(
    await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(message)),
  );

  // The bug this guards: handing the raw signature straight to a DER verifier.
  const der = derFromRaw(raw);
  const publicKey = createPublicKey({ key: pem(toBase64(spki)), format: 'pem' });
  return ecdsaVerify('sha256', Buffer.from(message), publicKey, Buffer.from(der));
}

test('a converted WebCrypto signature verifies against Node, which is what Privy does', async () => {
  // Many iterations on purpose. The high-bit and leading-zero cases below are
  // reached by chance in roughly one signature in 256 per half, so a single
  // round trip would pass while the encoder was still wrong.
  for (let i = 0; i < 64; i += 1) {
    assert.equal(await signAndVerify(`payload ${i}`), true, `signature ${i} did not verify`);
  }
});

test('a raw r‖s signature is NOT accepted, which is why the conversion exists', async () => {
  const pair = await webcrypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);
  const spki = await webcrypto.subtle.exportKey('spki', pair.publicKey);
  const message = 'the same payload, unconverted';
  const raw = new Uint8Array(
    await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(message)),
  );
  const publicKey = createPublicKey({ key: pem(toBase64(spki)), format: 'pem' });
  assert.equal(
    ecdsaVerify('sha256', Buffer.from(message), publicKey, Buffer.from(raw)),
    false,
    'raw r‖s verified, so this whole conversion would be unnecessary — check the assumption',
  );
});

test('a high bit in either half gets the 0x00 prefix that keeps it positive', () => {
  const raw = new Uint8Array(64);
  raw.fill(0xff, 0, 32); // r starts 0xff
  raw.fill(0x7f, 32); // s starts 0x7f, no prefix needed
  const der = derFromRaw(raw);
  assert.equal(der[0], 0x30, 'a DER signature is a SEQUENCE');
  assert.equal(der[2], 0x02, 'first element is an INTEGER');
  assert.equal(der[3], 33, 'r is 33 bytes: 32 plus the sign-guard prefix');
  assert.equal(der[4], 0x00, 'and that prefix is a zero byte');
  const sOffset = 4 + 33;
  assert.equal(der[sOffset], 0x02, 'second element is an INTEGER');
  assert.equal(der[sOffset + 1], 32, 's stays 32 bytes because 0x7f is positive already');
});

test('leading zeros are stripped rather than encoded', () => {
  const raw = new Uint8Array(64);
  raw[31] = 0x01; // r is 31 zero bytes then 0x01
  raw[63] = 0x02;
  const der = derFromRaw(raw);
  assert.equal(der[3], 1, 'r encodes as a single byte');
  assert.equal(der[4], 0x01);
});

test('a signature that is not 64 bytes is refused rather than mangled', () => {
  assert.throws(() => derFromRaw(new Uint8Array(63)), /64-byte/);
});
