// A gateway that settles in front of us is let through; nobody else is.
//
// The case this pins down is Bazantic's (2026-09-11): its gateway charges the
// caller, then forwards the call with no payment header of any scheme. Before
// this, every forwarded call was answered with our own 402 and the caller got
// `payment_rejected`.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from './app.ts';
import { GATEWAY_KEY_HEADER, parseGatewayKeys } from './gateway.ts';
import { fakeAnalyst, testRegistry, withServer } from './testing.ts';

const POOL = '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640';
const KEY = 'a'.repeat(64);

function app(spec?: string) {
  return createApp({ registry: testRegistry(), analyst: fakeAnalyst(), gateways: parseGatewayKeys(spec) });
}

test('a call carrying a trusted gateway key is served without a 402', async () => {
  await withServer(app(`bazantic=${KEY}`), async baseUrl => {
    for (const path of [`/analyze/${POOL}`, `/analyze/${POOL}/attested`]) {
      const res = await fetch(`${baseUrl}${path}`, { headers: { [GATEWAY_KEY_HEADER]: KEY } });
      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get('x-turnstile-settled-by'), 'bazantic');
      // Nothing settled here, so no x402 receipt may claim otherwise.
      assert.equal(res.headers.get('payment-response'), null);
      const body = await res.json() as { verdict?: unknown };
      assert.ok(body.verdict, path);
    }
  });
});

test('a wrong key, or none, is challenged exactly as before', async () => {
  await withServer(app(`bazantic=${KEY}`), async baseUrl => {
    const wrong = await fetch(`${baseUrl}/analyze/${POOL}`, { headers: { [GATEWAY_KEY_HEADER]: 'b'.repeat(64) } });
    assert.equal(wrong.status, 402);
    const none = await fetch(`${baseUrl}/analyze/${POOL}`);
    assert.equal(none.status, 402);
  });
});

test('with no gateways configured, even a plausible key is challenged', async () => {
  await withServer(app(undefined), async baseUrl => {
    const res = await fetch(`${baseUrl}/analyze/${POOL}`, { headers: { [GATEWAY_KEY_HEADER]: KEY } });
    assert.equal(res.status, 402);
  });
});

test('a malformed or weak configuration refuses to start rather than opening the paywall', () => {
  assert.throws(() => parseGatewayKeys('bazantic'), /name=secret/);
  assert.throws(() => parseGatewayKeys('bazantic=short'), /shorter than 32/);
  assert.throws(() => parseGatewayKeys(`=${KEY}`), /name=secret/);
});

test('several gateways can be trusted, each identified by its own key', () => {
  const other = 'c'.repeat(40);
  const trust = parseGatewayKeys(`bazantic=${KEY}, other=${other}`);
  assert.deepEqual(trust.names, ['bazantic', 'other']);
  assert.equal(trust.identify(KEY), 'bazantic');
  assert.equal(trust.identify(other), 'other');
  assert.equal(trust.identify(undefined), null);
  assert.equal(trust.identify(''), null);
});
