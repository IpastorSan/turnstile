import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { CHAINS, UnknownChain, resolveChain, rpcUrlFor } from '../src/chains.ts';

const saved = { ...process.env };
afterEach(() => {
  for (const k of ['MAINNET_RPC_URL', 'BASE_RPC_URL', 'RPC_URL', 'RPC_CHAIN']) delete process.env[k];
  Object.assign(process.env, saved);
});

describe('resolveChain', () => {
  test('resolves by name, case-insensitively, and by chain id', () => {
    assert.equal(resolveChain('base').id, 8453);
    assert.equal(resolveChain('BASE').id, 8453);
    assert.equal(resolveChain(8453).name, 'base');
    assert.equal(resolveChain('8453').name, 'base');
  });

  test('defaults to mainnet when nothing is given', () => {
    assert.equal(resolveChain().name, 'mainnet');
    assert.equal(resolveChain('').name, 'mainnet');
  });

  test('throws on an unknown chain rather than falling back to mainnet', () => {
    // A silent fallback would answer a Base question with mainnet data, which
    // is a plausible-looking wrong answer.
    assert.throws(() => resolveChain('zora'), UnknownChain);
    assert.throws(() => resolveChain(999_999), UnknownChain);
  });
});

describe('chain table', () => {
  test('Base is the exception: its factory and quoter differ from the shared ones', () => {
    // The shape of this table is the point — "same on every chain except one"
    // is exactly the assumption that produces a wrong answer if hardcoded.
    assert.equal(CHAINS.mainnet!.v3Factory, CHAINS.arbitrum!.v3Factory);
    assert.equal(CHAINS.mainnet!.quoterV2, CHAINS.polygon!.quoterV2);
    assert.notEqual(CHAINS.base!.v3Factory, CHAINS.mainnet!.v3Factory);
    assert.notEqual(CHAINS.base!.quoterV2, CHAINS.mainnet!.quoterV2);
  });

  test('every chain has distinct v4 quoters and a well-formed config', () => {
    const v4 = Object.values(CHAINS).map((c) => c.v4Quoter.toLowerCase());
    assert.equal(new Set(v4).size, v4.length, 'v4 quoter addresses must not be duplicated');
    for (const c of Object.values(CHAINS)) {
      for (const addr of [c.v3Factory, c.quoterV2, c.v4Quoter, c.usdStable.address, c.wrappedNative.address]) {
        assert.match(addr, /^0x[0-9a-fA-F]{40}$/, `${c.name}: ${addr}`);
      }
      assert.ok(c.id > 0);
      assert.ok(c.usdStable.decimals > 0 && c.wrappedNative.decimals > 0);
    }
  });
});

describe('rpcUrlFor', () => {
  const mainnet = CHAINS.mainnet!;
  const base = CHAINS.base!;

  test('an explicit url beats everything', () => {
    process.env.MAINNET_RPC_URL = 'https://from-env.example';
    assert.equal(rpcUrlFor(mainnet, 'https://explicit.example'), 'https://explicit.example');
  });

  test('a chain-specific variable is used', () => {
    process.env.BASE_RPC_URL = 'https://base.example';
    assert.equal(rpcUrlFor(base), 'https://base.example');
  });

  test('a bare RPC_URL is IGNORED unless RPC_CHAIN says which chain it is for', () => {
    // The bug being prevented: one RPC_URL pointing at mainnet, silently used
    // to answer a Base question. The caller cannot see that happen.
    process.env.RPC_URL = 'https://ambiguous.example';
    assert.equal(rpcUrlFor(base), base.defaultRpcUrl);

    process.env.RPC_CHAIN = 'mainnet';
    assert.equal(rpcUrlFor(base), base.defaultRpcUrl, 'still not for base');
    assert.equal(rpcUrlFor(mainnet), 'https://ambiguous.example');

    process.env.RPC_CHAIN = 'BASE';
    assert.equal(rpcUrlFor(base), 'https://ambiguous.example');
  });

  test('falls back to the public default', () => {
    assert.equal(rpcUrlFor(mainnet), mainnet.defaultRpcUrl);
  });
});
