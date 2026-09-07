// Shared fixtures for the service tests. Not imported by anything that ships.

import type { AddressInfo } from 'node:net';
import type { Express } from 'express';

import { RailRegistry } from '../../rails/registry.ts';
import { createStubRail } from '../../rails/stub-rail.ts';
import type { AnalystInput, Verdict } from '../analyst/types.ts';
import type { AnalystPort } from './app.ts';

/**
 * Two rails on fictional networks, matching neither real rail.
 *
 * A test that passed only because it named the chains the real rails use would
 * be pinning the wrong property. What is asserted here is that the service works
 * for *any* two rails.
 */
export function testRegistry(): RailRegistry {
  return new RailRegistry([
    createStubRail({
      id: 'rail-one', label: 'Test rail one', scheme: 'exact', network: 'testnamespace:one',
      asset: { id: 'test-asset-one', symbol: 'TUSD', decimals: 6 },
      ensRailToken: 'one', payTo: 'payout-account-one',
    }),
    createStubRail({
      id: 'rail-two', label: 'Test rail two', scheme: 'exact', network: 'testnamespace:two',
      asset: { id: 'test-asset-two', symbol: 'TUSD', decimals: 6 },
      ensRailToken: 'two', payTo: 'payout-account-two',
    }),
  ]);
}

const POOL = '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640';

export function fakeAnalystInput(overrides: Partial<AnalystInput> = {}): AnalystInput {
  return {
    now: 1_757_000_000,
    depth: null,
    pool: {
      address: POOL,
      name: 'Testswap v3 TKA/TKB 0.05%',
      protocol: 'Testswap V3',
      network: 'MAINNET',
      tokens: [
        { address: '0xaaa1', symbol: 'TKA', decimals: 6, priceUSD: 1, balance: 1000, balanceUSD: 1000 },
        { address: '0xbbb2', symbol: 'TKB', decimals: 18, priceUSD: 2500, balance: 0.4, balanceUSD: 1000 },
      ],
      createdTimestamp: 1_600_000_000,
      totalValueLockedUSD: 2000,
      cumulativeVolumeUSD: 500_000,
      cumulativeSupplySideRevenueUSD: 250,
      feeTierPct: 0.05,
      positionCount: 40,
      openPositionCount: 20,
      tick: 0,
      hourly: [],
      source: {
        label: 'test', endpoint: 'http://test.invalid', transport: 'http',
        blockNumber: 25_925_794, blockTimestamp: 1_756_990_000,
      },
    },
    ...overrides,
  };
}

/**
 * An analyst that does no I/O, and records how it was called so a test can
 * assert that the premium tier asked for a live quote and the standard one
 * did not.
 */
export function fakeAnalyst(): AnalystPort & { calls: { pool: string; liveDepth: boolean }[] } {
  const calls: { pool: string; liveDepth: boolean }[] = [];
  return {
    calls,
    async analyze(pool, { liveDepth }) {
      calls.push({ pool, liveDepth });
      const input = fakeAnalystInput();
      const verdict: Verdict = {
        pool: input.pool.name,
        poolAddress: pool,
        rating: 'ACCEPTABLE',
        confidence: 0.75,
        summary: 'A fixture verdict.',
        signals: [],
        provenance: {
          subgraph: 'test', subgraphTransport: 'http', subgraphBlock: 25_925_794,
          subgraphLagSeconds: 10_000, depthProvider: liveDepth ? 'quoter-v2' : null,
          depthBlock: null, assessedAt: input.now,
        },
        caveats: [],
      };
      return { verdict, input };
    },
  };
}

/** Run `fn` against a listening instance of `app`, then close it. */
export async function withServer<T>(app: Express, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>(resolve => server.close(() => { resolve(); }));
  }
}
