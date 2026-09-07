import test from 'node:test';
import assert from 'node:assert/strict';

import { parseX402Body } from './probe-x402.ts';

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
