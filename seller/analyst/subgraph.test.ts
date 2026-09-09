// This is the seam where a subgraph's decimal strings and raw integer token
// amounts become the plain numbers the scorer reasons over. The scorer is a pure
// function of typed data precisely because everything ambiguous is resolved
// here, which makes every mistake here a mistake the scorer cannot catch.
//
// Two of the cases below are the ones that matter:
//
//   - A 200 response carrying a GraphQL `errors` array. It is not an exception,
//     it is not a non-200, and the `data` key is simply absent. Handing `{}`
//     onward renders as "this pool has no liquidity", which is a plausible
//     sentence about a pool that may hold a hundred million dollars. `httpSource`
//     is asserted to throw on it.
//   - The difference between a price of zero and no price at all. The subgraph
//     writes `lastPriceUSD: "0"` for a token it could never anchor to a
//     stablecoin or to WETH. Flattening that into a plausible-looking zero would
//     let the scorer report a confident dollar figure it has no basis for.
//
// The Messari schema is the contract, so the rest is mostly about tolerance: a
// pool missing an optional field must still map, and a missing *required* entity
// must be reported as missing rather than mapped into an empty pool.
//
// No network: `SubgraphSource` is an interface, so every decoding test passes a
// fake one. Only the `httpSource` tests stub `globalThis.fetch`.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  NETWORK_SUBGRAPHS,
  POOL_FACTS_QUERY,
  TOP_POOLS_QUERY,
  TURNSTILE_SUBGRAPH_URL,
  feeTierToUint24,
  fetchPoolFacts,
  fetchTopPoolsByTvl,
  httpSource,
  mcpSource,
  type SubgraphSource,
} from './subgraph.ts';
import { SubgraphMcpClient } from './subgraph-mcp.ts';

const POOL = '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640';
const HEAD_TS = 1_787_631_581;

/** A source that answers with `body` and records what it was asked. */
function fakeSource(body: unknown, over: Partial<SubgraphSource> = {}) {
  const asked: { document: string; variables: Record<string, unknown> }[] = [];
  let closed = 0;
  const source: SubgraphSource = {
    label: 'fake subgraph',
    endpoint: 'fake://subgraph',
    transport: 'http',
    async query<T>(document: string, variables: Record<string, unknown>): Promise<T> {
      asked.push({ document, variables });
      return body as T;
    },
    async close() {
      closed += 1;
    },
    ...over,
  };
  return { source, asked, closed: () => closed };
}

/** A Messari `LiquidityPool` as the subgraph actually writes one. */
function rawPool(over: Record<string, unknown> = {}) {
  return {
    id: POOL.toLowerCase(),
    name: 'Uniswap V3 USDC/WETH 0.05%',
    createdTimestamp: '1620250931',
    totalValueLockedUSD: '104323456.7890123456789012345678',
    cumulativeVolumeUSD: '250000000.5',
    cumulativeSupplySideRevenueUSD: '125000.25',
    tick: '198432',
    positionCount: 250,
    openPositionCount: 100,
    inputTokens: [
      { id: '0xusdc', symbol: 'USDC', decimals: 6, lastPriceUSD: '1.0001' },
      { id: '0xweth', symbol: 'WETH', decimals: 18, lastPriceUSD: '2500.5' },
    ],
    inputTokenBalances: ['75000000000000', '11726265432198765432109'],
    inputTokenBalancesUSD: ['75007500.0', '29323456.789'],
    fees: [
      { feeType: 'FIXED_TRADING_FEE', feePercentage: '0.05' },
      { feeType: 'FIXED_PROTOCOL_FEE', feePercentage: '0' },
    ],
    ...over,
  };
}

function poolFactsResponse(over: Record<string, unknown> = {}) {
  return {
    dexAmmProtocols: [{ name: 'Uniswap V3', network: 'MAINNET' }],
    liquidityPool: rawPool(),
    liquidityPoolHourlySnapshots: [
      {
        hour: Math.floor(HEAD_TS / 3600),
        timestamp: String(HEAD_TS),
        hourlyVolumeUSD: '4000000.125',
        totalValueLockedUSD: '104323456.789',
        hourlySupplySideRevenueUSD: '2000.0625',
      },
    ],
    _meta: { block: { number: 25_831_581, timestamp: HEAD_TS } },
    ...over,
  };
}

describe('httpSource', () => {
  async function withFetch<T>(
    impl: (url: string, init: RequestInit) => Response | Promise<Response>,
    body: (calls: { url: string; init: RequestInit }[]) => Promise<T>,
  ): Promise<T> {
    const calls: { url: string; init: RequestInit }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return impl(String(input), init ?? {});
    }) as unknown as typeof globalThis.fetch;
    try {
      return await body(calls);
    } finally {
      globalThis.fetch = original;
    }
  }

  test('a 200 carrying a GraphQL errors array is a failure, not an empty pool', async () => {
    // The case this file exists for. `response.ok` is true, the body is valid
    // JSON, and `data` is absent — every check short of this one passes. Passing
    // the body through would put `liquidityPool: undefined` into fetchPoolFacts
    // and render as "no liquidity" rather than as an error anyone can act on.
    await withFetch(
      () =>
        new Response(
          JSON.stringify({ errors: [{ message: 'Failed to decode `id` value: `not-an-address`' }] }),
          { status: 200 },
        ),
      async () => {
        await assert.rejects(
          () => httpSource().query(POOL_FACTS_QUERY, { pool: 'not-an-address' }),
          /subgraph: Failed to decode `id` value/,
        );
      },
    );
  });

  test('errors alongside partial data still fails', async () => {
    // GraphQL may answer with both. Scoring half a pool as a whole one is the
    // same plausible-but-wrong verdict, so the presence of `errors` decides.
    await withFetch(
      () =>
        new Response(
          JSON.stringify({
            data: { liquidityPool: { id: '0xpool' } },
            errors: [{ message: 'indexing_error' }],
          }),
          { status: 200 },
        ),
      async () => {
        await assert.rejects(() => httpSource().query(POOL_FACTS_QUERY, {}), /subgraph: indexing_error/);
      },
    );
  });

  test('a 200 with neither data nor errors is named rather than returned as undefined', async () => {
    await withFetch(
      () => new Response('{}', { status: 200 }),
      async () => {
        await assert.rejects(
          () => httpSource().query(POOL_FACTS_QUERY, {}),
          /subgraph: response carried no data/,
        );
      },
    );
  });

  test('a non-200 reports the status and quotes the body, truncated', async () => {
    // Studio answers a bad deployment path with an HTML page. The status is the
    // diagnosis; the body is the evidence, and a few hundred characters of it is
    // all a log line can carry.
    const html = `<html><body>${'deployment not found '.repeat(50)}</body></html>`;
    await withFetch(
      () => new Response(html, { status: 404 }),
      async () => {
        await assert.rejects(
          () => httpSource().query(POOL_FACTS_QUERY, {}),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /^subgraph HTTP 404: <html>/);
            assert.ok(error.message.length < 250, `message was ${error.message.length} chars`);
            return true;
          },
        );
      },
    );
  });

  test('a 500 is a failure even when the body is a valid GraphQL envelope', async () => {
    // A gateway under load answers 500 with a JSON body. Checking `errors` before
    // `ok` would report the gateway's outage as the subgraph's opinion.
    await withFetch(
      () => new Response(JSON.stringify({ data: { liquidityPool: null } }), { status: 500 }),
      async () => {
        await assert.rejects(() => httpSource().query(POOL_FACTS_QUERY, {}), /subgraph HTTP 500/);
      },
    );
  });

  test('the document and variables are POSTed as JSON to the configured url', async () => {
    await withFetch(
      () => new Response(JSON.stringify({ data: { ok: true } }), { status: 200 }),
      async (calls) => {
        const source = httpSource({ url: 'https://gateway.test/subgraphs/id/Qm', label: 'a label' });
        assert.equal(source.label, 'a label');
        assert.equal(source.endpoint, 'https://gateway.test/subgraphs/id/Qm');
        assert.equal(source.transport, 'http');

        assert.deepEqual(await source.query(POOL_FACTS_QUERY, { pool: '0xabc', hours: 48 }), {
          ok: true,
        });
        assert.equal(calls[0]!.url, 'https://gateway.test/subgraphs/id/Qm');
        assert.equal(calls[0]!.init.method, 'POST');
        assert.deepEqual(calls[0]!.init.headers, { 'content-type': 'application/json' });
        assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
          query: POOL_FACTS_QUERY,
          variables: { pool: '0xabc', hours: 48 },
        });

        // Closing an HTTP source is a no-op, but it has to exist: analyst-cli
        // closes the source in a finally block whichever source it built.
        await source.close();
      },
    );
  });

  test('the default url and label are the Studio deployment, not the network', async () => {
    // Our own subgraph is published to Studio, which the Subgraph MCP server
    // cannot see at all — that is why this second source exists. The label says
    // Studio so a verdict's provenance says where the data actually came from.
    const source = httpSource();
    assert.equal(source.endpoint, TURNSTILE_SUBGRAPH_URL);
    assert.match(source.endpoint, /api\.studio\.thegraph\.com/);
    assert.match(source.label, /Studio/);
  });
});

describe('mcpSource', () => {
  test('delegates to the client with the subgraph id it was built for', async () => {
    const asked: { id: string; document: string; variables: unknown }[] = [];
    const client = {
      describe: 'https://subgraphs.mcp.thegraph.com/sse',
      async query(id: string, document: string, variables: unknown) {
        asked.push({ id, document, variables });
        return { ok: true };
      },
      async close() {},
    } as unknown as SubgraphMcpClient;

    const source = mcpSource({ subgraphId: NETWORK_SUBGRAPHS['uniswap-v3-arbitrum']!, client });
    assert.equal(source.transport, 'mcp');
    assert.equal(source.endpoint, 'https://subgraphs.mcp.thegraph.com/sse');
    assert.match(source.label, /via Subgraph MCP/);

    assert.deepEqual(await source.query(TOP_POOLS_QUERY, { first: 10 }), { ok: true });
    assert.deepEqual(asked, [
      {
        id: 'FQ6JYszEKApsBpAmiHesRsd9Ygc6mzmpNRANeVQFYoVX',
        document: TOP_POOLS_QUERY,
        variables: { first: 10 },
      },
    ]);
  });

  test('closing does not close a client the caller owns', async () => {
    // Ownership is decided by whether a client was passed in. Closing a borrowed
    // one would tear down a live SSE session out from under whoever else is
    // holding it, and the symptom would be a "Not connected" throw somewhere
    // unrelated.
    let closes = 0;
    const client = {
      describe: 'x',
      async query() {
        return {};
      },
      async close() {
        closes += 1;
      },
    } as unknown as SubgraphMcpClient;

    await mcpSource({ subgraphId: 'Qm', client }).close();
    assert.equal(closes, 0, 'a borrowed client must survive the source that used it');
  });

  test('closing does close a client the source made for itself', async () => {
    const source = mcpSource({ subgraphId: 'Qm', label: 'own client' });
    assert.equal(source.label, 'own client');
    assert.equal(source.endpoint, 'https://subgraphs.mcp.thegraph.com/sse');
    // Never connected, so `close()` is the no-op path; the point is that it is
    // reached at all rather than skipped as borrowed.
    await source.close();
  });
});

describe('fetchPoolFacts', () => {
  test('maps a full pool, resolving strings and raw amounts at the edge', async () => {
    const { source, asked } = fakeSource(poolFactsResponse());
    const facts = await fetchPoolFacts(source, POOL, 48);

    // The address is lower-cased before it becomes a GraphQL `ID!`. Messari
    // writes pool ids lower-cased, so the checksummed form a user pastes in
    // matches nothing and comes back as "no such pool" — a wrong answer that
    // looks like a right one.
    assert.deepEqual(asked, [
      {
        document: POOL_FACTS_QUERY,
        variables: { pool: POOL.toLowerCase(), poolRef: POOL.toLowerCase(), hours: 48 },
      },
    ]);

    assert.equal(facts.address, POOL.toLowerCase());
    assert.equal(facts.name, 'Uniswap V3 USDC/WETH 0.05%');
    assert.equal(facts.protocol, 'Uniswap V3');
    assert.equal(facts.network, 'MAINNET');
    assert.equal(facts.createdTimestamp, 1_620_250_931);
    assert.equal(facts.totalValueLockedUSD, 104_323_456.78901234);
    assert.equal(facts.cumulativeVolumeUSD, 250_000_000.5);
    assert.equal(facts.cumulativeSupplySideRevenueUSD, 125_000.25);
    assert.equal(facts.feeTierPct, 0.05);
    assert.equal(facts.positionCount, 250);
    assert.equal(facts.openPositionCount, 100);
    assert.equal(facts.tick, 198_432);

    assert.deepEqual(facts.hourly, [
      {
        hour: Math.floor(HEAD_TS / 3600),
        timestamp: HEAD_TS,
        volumeUSD: 4_000_000.125,
        totalValueLockedUSD: 104_323_456.789,
        supplySideRevenueUSD: 2_000.0625,
      },
    ]);

    // The provenance a buyer reads. It is copied from the source and from
    // `_meta`, so it says which endpoint answered and at which block.
    assert.deepEqual(facts.source, {
      label: 'fake subgraph',
      endpoint: 'fake://subgraph',
      transport: 'http',
      blockNumber: 25_831_581,
      blockTimestamp: HEAD_TS,
    });
  });

  test('an 18-decimal balance keeps its digits instead of rounding through a double', async () => {
    // 11726.265432198765432109 WETH in raw units is well past 2^53, so
    // `Number(raw) / 1e18` loses digits before the division ever happens. The
    // BigInt divide is why the balance below is right to the fifteenth digit
    // rather than the ninth.
    const { source } = fakeSource(poolFactsResponse());
    const facts = await fetchPoolFacts(source, POOL);

    assert.equal(facts.tokens[0]!.balance, 75_000_000);
    assert.equal(facts.tokens[1]!.balance, 11_726.265432198765);
    assert.ok(
      Math.abs(facts.tokens[1]!.balance - 11_726.265432198765432109) < 1e-11,
      `balance was ${facts.tokens[1]!.balance}`,
    );
  });

  test('the subgraph own USD figure wins over balance times price', async () => {
    // The subgraph computed its figure at the block the balance was written.
    // Recomputing it from a `lastPriceUSD` read at a different block produces a
    // number that is close enough to look right and is not the same claim.
    const { source } = fakeSource(poolFactsResponse());
    const facts = await fetchPoolFacts(source, POOL);
    assert.equal(facts.tokens[0]!.balanceUSD, 75_007_500);
    assert.equal(facts.tokens[1]!.balanceUSD, 29_323_456.789);
    // Not the product, which would be ~29,320,543.
    assert.notEqual(facts.tokens[1]!.balanceUSD, facts.tokens[1]!.balance * 2500.5);
  });

  test('a missing USD figure falls back to balance times price', async () => {
    const { source } = fakeSource(
      poolFactsResponse({ liquidityPool: rawPool({ inputTokenBalancesUSD: ['75007500.0'] }) }),
    );
    const facts = await fetchPoolFacts(source, POOL);
    assert.equal(facts.tokens[0]!.balanceUSD, 75_007_500);
    assert.equal(facts.tokens[1]!.balanceUSD, facts.tokens[1]!.balance * 2500.5);
  });

  test('an unpriced token is null everywhere, never a plausible zero', async () => {
    // `lastPriceUSD: "0"` means the subgraph could not anchor this token to
    // anything, not that it is worthless. A zero would flow into TVL-shaped
    // reasoning as a real number; `null` makes the scorer say it does not know.
    // The reported USD figure is discarded with it — a dollar total for a token
    // with no price is not a figure anyone should act on.
    const { source } = fakeSource(
      poolFactsResponse({
        liquidityPool: rawPool({
          inputTokens: [
            { id: '0xnew', symbol: 'NEW', decimals: 18, lastPriceUSD: '0' },
            { id: '0xnull', symbol: 'NULL', decimals: 18, lastPriceUSD: null },
            { id: '0xnan', symbol: 'NAN', decimals: 18, lastPriceUSD: 'not-a-number' },
          ],
          inputTokenBalances: ['1000000000000000000', '2000000000000000000', '3000000000000000000'],
          inputTokenBalancesUSD: ['1234.5', '2345.6', '3456.7'],
        }),
      }),
    );
    const facts = await fetchPoolFacts(source, POOL);
    assert.deepEqual(
      facts.tokens.map((t) => [t.symbol, t.priceUSD, t.balance, t.balanceUSD]),
      [
        ['NEW', null, 1, null],
        ['NULL', null, 2, null],
        ['NAN', null, 3, null],
      ],
    );
  });

  test('a balance the subgraph did not write is zero, not NaN', async () => {
    // `inputTokenBalances` shorter than `inputTokens` happens on a pool indexed
    // mid-migration. `undefined / 1e18` is NaN, and NaN propagates through every
    // downstream ratio silently.
    const { source } = fakeSource(
      poolFactsResponse({
        liquidityPool: rawPool({ inputTokenBalances: [], inputTokenBalancesUSD: [] }),
      }),
    );
    const facts = await fetchPoolFacts(source, POOL);
    assert.equal(facts.tokens[0]!.balance, 0);
    assert.equal(facts.tokens[1]!.balance, 0);
    assert.equal(facts.tokens[0]!.balanceUSD, 0);
  });

  test('a decimal balance falls back to float division rather than throwing', async () => {
    // `BigInt("1.5")` throws. A subgraph that writes an already-scaled decimal
    // where a raw integer belongs is wrong, but taking the whole pool down for it
    // would turn one bad field into no verdict at all.
    const { source } = fakeSource(
      poolFactsResponse({
        liquidityPool: rawPool({ inputTokenBalances: ['1500000.5', 'garbage'] }),
      }),
    );
    const facts = await fetchPoolFacts(source, POOL);
    assert.equal(facts.tokens[0]!.balance, 1.5000005);
    // Unparseable falls through `num()` to 0 rather than NaN.
    assert.equal(facts.tokens[1]!.balance, 0);
  });

  test('a token with zero decimals is scaled by one, not by ten', async () => {
    // `10n ** 0n` is 1n, so the whole/remainder split has to survive a zero
    // scale. Getting it wrong divides by zero in the remainder term.
    const { source } = fakeSource(
      poolFactsResponse({
        liquidityPool: rawPool({
          inputTokens: [{ id: '0xgas', symbol: 'GAS', decimals: 0, lastPriceUSD: '3' }],
          inputTokenBalances: ['4200'],
          inputTokenBalancesUSD: [],
        }),
      }),
    );
    const facts = await fetchPoolFacts(source, POOL);
    assert.equal(facts.tokens[0]!.balance, 4200);
    assert.equal(facts.tokens[0]!.balanceUSD, 12_600);
  });

  test('an optional field the schema allows to be null still maps', async () => {
    // The Messari schema marks `name` and `tick` nullable, and an uninitialised
    // v3 pool has no tick. Both are cosmetic to the verdict; throwing on either
    // would lose a pool that is otherwise fully described.
    const { source } = fakeSource(
      poolFactsResponse({
        liquidityPool: rawPool({ name: null, tick: null, fees: [] }),
        dexAmmProtocols: [],
      }),
    );
    const facts = await fetchPoolFacts(source, POOL);
    assert.equal(facts.name, POOL.toLowerCase(), 'the address stands in for a missing name');
    assert.equal(facts.tick, null);
    assert.equal(facts.feeTierPct, null, 'no fee row is unknown, not zero');
    assert.equal(facts.protocol, 'unknown');
    assert.equal(facts.network, 'unknown');
  });

  test('a pool with no hourly snapshots maps to an empty history', async () => {
    // A pool indexed in the last hour has none. That is a real finding about the
    // pool — the scorer treats a thin history as low confidence — and it has to
    // reach the scorer rather than being turned into an exception here.
    const { source } = fakeSource(poolFactsResponse({ liquidityPoolHourlySnapshots: [] }));
    const facts = await fetchPoolFacts(source, POOL);
    assert.deepEqual(facts.hourly, []);
  });

  test('a missing LiquidityPool is reported as missing, and names the source', async () => {
    // The required entity. `liquidityPool: null` is what the subgraph answers for
    // an address it has never indexed, and the two reasons — wrong address, or
    // right address on the wrong subgraph — are indistinguishable without the
    // label, so the label is in the message.
    const { source } = fakeSource(poolFactsResponse({ liquidityPool: null }));
    await assert.rejects(
      () => fetchPoolFacts(source, POOL),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          error.message,
          `no LiquidityPool ${POOL.toLowerCase()} in fake subgraph`,
        );
        return true;
      },
    );
  });

  test('an LP fee stands in when there is no trading fee row', async () => {
    // Not every Messari deployment writes FIXED_TRADING_FEE. FIXED_LP_FEE is the
    // same number on a v3 pool, and preferring it to `null` keeps the fee tier
    // available for the depth ladder.
    const { source } = fakeSource(
      poolFactsResponse({
        liquidityPool: rawPool({
          fees: [
            { feeType: 'FIXED_PROTOCOL_FEE', feePercentage: '0' },
            { feeType: 'FIXED_LP_FEE', feePercentage: '0.3' },
          ],
        }),
      }),
    );
    assert.equal((await fetchPoolFacts(source, POOL)).feeTierPct, 0.3);
  });

  test('a trading fee row wins over an LP fee row regardless of order', async () => {
    const { source } = fakeSource(
      poolFactsResponse({
        liquidityPool: rawPool({
          fees: [
            { feeType: 'FIXED_LP_FEE', feePercentage: '0.3' },
            { feeType: 'FIXED_TRADING_FEE', feePercentage: '0.05' },
          ],
        }),
      }),
    );
    assert.equal((await fetchPoolFacts(source, POOL)).feeTierPct, 0.05);
  });

  test('the hours argument defaults to 48 and is passed through when given', async () => {
    // 48 is two days of hourly buckets, which is what the scorer's activity and
    // trend tests are calibrated against.
    const a = fakeSource(poolFactsResponse());
    await fetchPoolFacts(a.source, POOL);
    assert.equal(a.asked[0]!.variables.hours, 48);

    const b = fakeSource(poolFactsResponse());
    await fetchPoolFacts(b.source, POOL, 168);
    assert.equal(b.asked[0]!.variables.hours, 168);
  });

  test('a non-finite numeric string reads as zero rather than NaN', async () => {
    // Every USD field goes through the same guard. One NaN in TVL makes every
    // ratio derived from it NaN, and NaN compares false against every threshold,
    // so the pool would quietly pass tests it should fail.
    const { source } = fakeSource(
      poolFactsResponse({
        liquidityPool: rawPool({
          totalValueLockedUSD: 'Infinity',
          cumulativeVolumeUSD: '',
          cumulativeSupplySideRevenueUSD: 'null',
        }),
      }),
    );
    const facts = await fetchPoolFacts(source, POOL);
    assert.equal(facts.totalValueLockedUSD, 0);
    assert.equal(facts.cumulativeVolumeUSD, 0);
    assert.equal(facts.cumulativeSupplySideRevenueUSD, 0);
    assert.ok(!Number.isNaN(facts.totalValueLockedUSD));
  });
});

describe('fetchTopPoolsByTvl', () => {
  test('maps the ranking and falls back to the address for an unnamed pool', async () => {
    const { source, asked } = fakeSource({
      liquidityPools: [
        {
          id: '0xpool1',
          name: 'Uniswap V3 USDC/WETH 0.05%',
          totalValueLockedUSD: '104323456.789',
          cumulativeVolumeUSD: '250000000.5',
          inputTokens: [{ symbol: 'USDC' }, { symbol: 'WETH' }],
        },
        {
          id: '0xpool2',
          name: null,
          totalValueLockedUSD: '1e21',
          cumulativeVolumeUSD: 'not a number',
          inputTokens: [],
        },
      ],
    });

    assert.deepEqual(await fetchTopPoolsByTvl(source, 2), [
      {
        address: '0xpool1',
        name: 'Uniswap V3 USDC/WETH 0.05%',
        totalValueLockedUSD: 104_323_456.789,
        cumulativeVolumeUSD: 250_000_000.5,
        symbols: ['USDC', 'WETH'],
      },
      {
        address: '0xpool2',
        name: '0xpool2',
        totalValueLockedUSD: 1e21,
        cumulativeVolumeUSD: 0,
        symbols: [],
      },
    ]);
    assert.deepEqual(asked, [{ document: TOP_POOLS_QUERY, variables: { first: 2 } }]);
  });

  test('defaults to the top ten', async () => {
    const { source, asked } = fakeSource({ liquidityPools: [] });
    assert.deepEqual(await fetchTopPoolsByTvl(source), []);
    assert.equal(asked[0]!.variables.first, 10);
  });
});

describe('feeTierToUint24', () => {
  test('converts a percentage to the uint24 QuoterV2 wants', () => {
    assert.equal(feeTierToUint24(null), null);
    assert.equal(feeTierToUint24(0.01), 100);
    assert.equal(feeTierToUint24(0.05), 500);
    assert.equal(feeTierToUint24(0.3), 3_000);
    assert.equal(feeTierToUint24(1), 10_000);
  });

  test('a tier that is not one of the four canonical ones is returned anyway', () => {
    // Pinning what the code does, not what the whitelist suggests it does: the
    // ternary is `includes(raw) ? raw : raw`, so both arms are the same value and
    // the check has no effect. Asserted rather than described because the shape
    // of the expression reads as a filter, and a future reader deleting the dead
    // `includes` would be right to.
    assert.equal(feeTierToUint24(0.07), 700);
    assert.equal(feeTierToUint24(2.5), 25_000);
    // Rounding is real, though: 0.30000000000000004 must not become 3000.0000001,
    // which is not a valid uint24 and would revert the quote.
    assert.equal(feeTierToUint24(0.1 + 0.2), 3_000);
  });
});

// Not covered here, deliberately:
//
// - `data._meta` missing. `fetchPoolFacts` reads `data._meta.block.number`
//   unguarded, so a source answering without `_meta` throws a TypeError naming
//   neither the pool nor the subgraph. Every deployment in NETWORK_SUBGRAPHS
//   serves `_meta` and it is in the document, so the case needs a broken server
//   to reach; pinning today's TypeError would make it harder to replace with a
//   named failure. Reported instead.
