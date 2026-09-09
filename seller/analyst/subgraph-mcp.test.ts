// The analyst has no knowledge source other than these two files, so every way
// the Subgraph MCP server can answer badly is a way the verdict can be wrong.
//
// The case this file exists for is the one that does not look like a failure: a
// successful tool call whose JSON payload carries a GraphQL `errors` array. The
// tool did not error, the transport did not error, the JSON parsed — and the
// `data` key is simply absent. If that returned an empty object the analyst
// would report a real pool as having no liquidity, which is a plausible answer
// and therefore worse than a crash. `query` and `queryByIpfsHash` are asserted
// to throw on it.
//
// Everything runs against a stubbed `globalThis.fetch` that speaks SSE and
// JSON-RPC back to the real MCP SDK client — no network, no Graph API key. The
// stub is worth the forty lines: it exercises the actual SSEClientTransport,
// including the `eventSourceInit` header override that `subgraph-mcp.ts`
// installs, which a hand-rolled fake client would skip entirely.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  HOSTED_SUBGRAPH_MCP_URL,
  SubgraphMcpClient,
  SubgraphMcpError,
} from './subgraph-mcp.ts';

/** A JSON-RPC reply body: either `{ result }` or `{ error }`. */
type Reply = Record<string, unknown>;

interface Call {
  method: string;
  params: { name?: string; arguments?: Record<string, unknown>; uri?: string };
}

/**
 * An in-memory MCP server reachable only through the `fetch` it returns.
 *
 * The SDK's SSE transport opens the session with a GET whose response body is a
 * live event stream, then sends every request as a POST to the endpoint that
 * stream announces. The stub answers both legs: the GET returns an open
 * `ReadableStream` that immediately emits the `endpoint` event, and each POST
 * pushes its reply back down that stream.
 */
function stubServer(handle: (call: Call) => Reply) {
  let push!: (chunk: string) => void;
  let endStream!: () => void;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (chunk) => controller.enqueue(encoder.encode(chunk));
      endStream = () => {
        try {
          controller.close();
        } catch {
          // Already closed by the transport's abort. Nothing to do.
        }
      };
      push('event: endpoint\ndata: /messages?sessionId=turnstile-test\n\n');
    },
  });

  const getHeaders: Headers[] = [];
  const postHeaders: Headers[] = [];
  const calls: Call[] = [];

  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'GET') {
      getHeaders.push(new Headers(init?.headers as HeadersInit));
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }

    postHeaders.push(new Headers(init?.headers as HeadersInit));
    const message = JSON.parse(String(init!.body)) as Call & { id?: number };
    // A notification (`notifications/initialized`) has no id and expects no
    // reply — answering one would be a protocol error, not a nicety.
    if (message.id === undefined) return new Response(null, { status: 202 });

    // `initialize` is the SDK's handshake, not a call our code chose to make.
    if (message.method !== 'initialize') calls.push({ method: message.method, params: message.params ?? {} });
    const reply = handle({ method: message.method, params: message.params ?? {} });
    // Queued rather than awaited: a real server acknowledges the POST first and
    // delivers the result on the stream afterwards.
    queueMicrotask(() =>
      push(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, ...reply })}\n\n`),
    );
    return new Response(null, { status: 202 });
  }) as unknown as typeof globalThis.fetch;

  return { fetchImpl, getHeaders, postHeaders, calls, endStream };
}

const INITIALIZE: Reply = {
  result: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    serverInfo: { name: 'subgraph-mcp', version: '0.1.1' },
  },
};

/** A server that answers `initialize` and delegates everything else. */
function mcpServer(handle: (call: Call) => Reply) {
  return stubServer((call) => (call.method === 'initialize' ? INITIALIZE : handle(call)));
}

/** One text part, which is how every subgraph-mcp tool answers. */
const textResult = (text: string, isError = false): Reply => ({
  result: { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) },
});

/**
 * Runs `body` with the stub installed as `globalThis.fetch`, then restores it.
 * The client under test reads global `fetch` on both legs — the POST directly,
 * and the SSE GET through the `eventSourceInit` override — so swapping the
 * global is the only seam, and leaking it would break every later test.
 */
async function withServer<T>(
  handle: (call: Call) => Reply,
  body: (
    client: SubgraphMcpClient,
    server: ReturnType<typeof stubServer>,
  ) => Promise<T>,
  options: { apiKey?: string } = {},
): Promise<T> {
  const server = mcpServer(handle);
  const original = globalThis.fetch;
  globalThis.fetch = server.fetchImpl;
  const client = new SubgraphMcpClient({
    url: 'http://subgraph-mcp.test/sse',
    apiKey: options.apiKey ?? 'test-key',
  });
  try {
    return await body(client, server);
  } finally {
    await client.close();
    globalThis.fetch = original;
    server.endStream();
  }
}

describe('transport wiring', () => {
  test('the SSE session and the POSTs both carry the gateway key', async () => {
    // `subgraph-mcp.ts` overrides `eventSourceInit.fetch` purely so the GET that
    // opens the session is authenticated too. The hosted server does not check,
    // so nothing about our own runs would notice if that override were deleted
    // — a self-hosted server behind auth would, by failing at connect with an
    // error that names neither the key nor the GET.
    await withServer(
      () => textResult('{"subgraphs":[]}'),
      async (client, server) => {
        await client.searchSubgraphs('uniswap');
        assert.equal(server.getHeaders[0]!.get('authorization'), 'Bearer test-key');
        assert.equal(server.postHeaders[0]!.get('authorization'), 'Bearer test-key');
      },
    );
  });

  test('no key configured means no Authorization header, not an empty Bearer', async () => {
    // An `Authorization: Bearer ` with nothing after it is a malformed header
    // that some gateways reject outright, which would turn "no key" into a
    // connection failure rather than an anonymous request.
    const server = mcpServer(() => textResult('{"subgraphs":[]}'));
    const original = globalThis.fetch;
    globalThis.fetch = server.fetchImpl;
    const client = new SubgraphMcpClient({ url: 'http://subgraph-mcp.test/sse', apiKey: '' });
    try {
      await client.searchSubgraphs('uniswap');
      assert.equal(server.getHeaders[0]!.has('authorization'), false);
      assert.equal(server.postHeaders[0]!.has('authorization'), false);
    } finally {
      await client.close();
      globalThis.fetch = original;
      server.endStream();
    }
  });

  test('describe names the endpoint, because the verdict quotes it as provenance', () => {
    // `mcpSource` copies `describe` straight into `PoolFacts.source.endpoint`, so
    // a buyer reading a verdict is reading this string.
    assert.equal(new SubgraphMcpClient().describe, HOSTED_SUBGRAPH_MCP_URL);
    assert.equal(new SubgraphMcpClient({ url: 'http://x.test/sse' }).describe, 'http://x.test/sse');
    // The stdio branch is constructed but never connected here: connecting would
    // spawn a `subgraph-mcp` binary that is not installed in CI. Construction is
    // the half that is ours; the spawn is the SDK's.
    assert.equal(
      new SubgraphMcpClient({ command: 'subgraph-mcp', args: ['--stdio'] }).describe,
      'stdio:subgraph-mcp',
    );
  });

  test('close before connect is a no-op rather than a throw', async () => {
    // `analyst-cli.ts` closes the source in a finally block, which runs even when
    // the failure was the connect itself.
    await new SubgraphMcpClient({ url: 'http://unused.test/sse' }).close();
  });

  test('a second call reuses the session instead of opening another', async () => {
    await withServer(
      () => textResult('{"subgraphs":[]}'),
      async (client, server) => {
        await client.searchSubgraphs('a');
        await client.searchSubgraphs('b');
        assert.equal(server.getHeaders.length, 1, 'one SSE session for two calls');
        assert.equal(server.calls.filter((c) => c.method === 'tools/call').length, 2);
      },
    );
  });
});

describe('failure modes', () => {
  test('a 200 carrying a GraphQL errors array is a failure, not an empty pool', async () => {
    // The case this file exists for. The tool call succeeded, `isError` is unset,
    // the JSON parsed — and there is no `data`. Returning `{}` here would send
    // the analyst into `fetchPoolFacts` with `liquidityPool: undefined` and, one
    // layer up, render as "this pool has no liquidity": a plausible sentence
    // about a pool that may hold a hundred million dollars.
    await withServer(
      () => textResult(JSON.stringify({ errors: [{ message: 'Type `LiquidityPool` has no field `tikc`' }] })),
      async (client) => {
        await assert.rejects(
          () => client.query('QmSubgraph', 'query { liquidityPool { tikc } }'),
          (error: unknown) => {
            assert.ok(error instanceof SubgraphMcpError);
            assert.equal(error.name, 'SubgraphMcpError');
            assert.equal(error.tool, 'execute_query_by_subgraph_id');
            assert.match(error.message, /has no field `tikc`/);
            return true;
          },
        );
      },
    );
  });

  test('the pinned-deployment path treats an errors array the same way', async () => {
    // `queryByIpfsHash` is a second copy of the same twelve lines. A fix applied
    // to one and not the other would leave the pinned path — the one used when a
    // caller cares *which* deployment answered — silently returning nothing.
    await withServer(
      () => textResult(JSON.stringify({ errors: [{ message: 'store error: pool not indexed' }] })),
      async (client) => {
        await assert.rejects(
          () => client.queryByIpfsHash('QmHash', 'query { liquidityPool { id } }'),
          (error: unknown) => {
            assert.ok(error instanceof SubgraphMcpError);
            assert.equal(error.tool, 'execute_query_by_ipfs_hash');
            assert.match(error.message, /pool not indexed/);
            return true;
          },
        );
      },
    );
  });

  test('errors alongside partial data still fails rather than reporting the partial', async () => {
    // GraphQL is allowed to answer with both. Half a pool scored as a whole one
    // is exactly the plausible-but-wrong verdict the errors check exists to stop,
    // so the presence of `errors` decides, not the presence of `data`.
    await withServer(
      () =>
        textResult(
          JSON.stringify({
            data: { liquidityPool: { id: '0xpool' }, liquidityPoolHourlySnapshots: null },
            errors: [{ message: 'null value resolved for non-null field' }],
          }),
        ),
      async (client) => {
        await assert.rejects(
          () => client.query('QmSubgraph', 'query {}'),
          /null value resolved/,
        );
      },
    );
  });

  test('a well-formed response with no data key is named, not returned as undefined', async () => {
    await withServer(
      () => textResult('{}'),
      async (client) => {
        await assert.rejects(
          () => client.query('QmSubgraph', 'query {}'),
          (error: unknown) => {
            assert.ok(error instanceof SubgraphMcpError);
            assert.match(error.message, /response carried no data/);
            return true;
          },
        );
      },
    );
  });

  test('the pinned path names a missing data key too', async () => {
    // Same duplicated twelve lines as the errors check above, same reason to
    // assert both copies.
    await withServer(
      () => textResult('{}'),
      async (client) => {
        await assert.rejects(
          () => client.queryByIpfsHash('QmHash', 'query {}'),
          /subgraph-mcp execute_query_by_ipfs_hash: response carried no data/,
        );
      },
    );
  });

  test('a tool result flagged isError becomes a named error carrying the server text', async () => {
    // A GraphQL *validation* error arrives this way: a normal tool result with
    // `isError: true`. The server's own words are the only diagnosis available,
    // so they have to survive into the message.
    await withServer(
      () => textResult('GraphQL error: Unknown field `totalValueLocked` on type `LiquidityPool`', true),
      async (client) => {
        await assert.rejects(
          () => client.schema('QmSubgraph'),
          (error: unknown) => {
            assert.ok(error instanceof SubgraphMcpError);
            assert.equal(error.tool, 'get_schema_by_subgraph_id');
            assert.match(error.message, /Unknown field `totalValueLocked`/);
            return true;
          },
        );
      },
    );
  });

  test('isError with no text still says which tool failed', async () => {
    // Otherwise the operator gets an empty string and has to guess which of the
    // five tools produced it.
    await withServer(
      () => ({ result: { content: [], isError: true } }),
      async (client) => {
        await assert.rejects(
          () => client.schema('QmSubgraph'),
          /subgraph-mcp get_schema_by_subgraph_id: tool reported an error/,
        );
      },
    );
  });

  test('a JSON-RPC error — the routing failure — is wrapped rather than escaping raw', async () => {
    // Unknown deployment or unreachable indexer comes back as a JSON-RPC error
    // from the SDK, not as a tool result. Both paths have to land on
    // SubgraphMcpError or a caller catching one of them leaves the other as an
    // unhandled rejection.
    await withServer(
      () => ({ error: { code: -32603, message: 'GraphQL error: subgraph not found' } }),
      async (client) => {
        await assert.rejects(
          () => client.query('QmMissing', 'query {}'),
          (error: unknown) => {
            assert.ok(error instanceof SubgraphMcpError);
            assert.equal(error.tool, 'execute_query_by_subgraph_id');
            assert.match(error.message, /subgraph not found/);
            return true;
          },
        );
      },
    );
  });

  test('a non-JSON body is reported as such, with the body quoted and truncated', async () => {
    // A gateway that answers a tool call with an HTML error page used to produce
    // `SyntaxError: Unexpected token '<'`, which names neither the tool nor the
    // gateway. The truncation matters too: an HTML page is thousands of
    // characters and this string ends up in a log line.
    const html = `<html><body>${'gateway timeout '.repeat(60)}</body></html>`;
    await withServer(
      () => textResult(html),
      async (client) => {
        await assert.rejects(
          () => client.searchSubgraphs('uniswap'),
          (error: unknown) => {
            assert.ok(error instanceof SubgraphMcpError);
            assert.equal(error.tool, 'search_subgraphs_by_keyword');
            assert.match(error.message, /response was not JSON: <html>/);
            assert.ok(error.message.length < 300, `message was ${error.message.length} chars`);
            return true;
          },
        );
      },
    );
  });

  test('an empty tool result is a JSON failure, not an empty result set', async () => {
    // `textOf` returns '' for a result with no content parts, and '' is not JSON.
    // Mapping it to `[]` instead would report "no subgraph matches that keyword"
    // for a server that in fact said nothing at all.
    await withServer(
      () => ({ result: { content: [] } }),
      async (client) => {
        await assert.rejects(() => client.searchSubgraphs('uniswap'), /response was not JSON/);
      },
    );
  });

  test('a content part with no text is skipped rather than stringified', async () => {
    // An image or resource part alongside the text one must not paste
    // `[object Object]` into the middle of the JSON.
    await withServer(
      () => ({
        result: {
          content: [
            { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
            { type: 'text', text: '{"subgraphs":[]}' },
          ],
        },
      }),
      async (client) => {
        assert.deepEqual(await client.searchSubgraphs('uniswap'), []);
      },
    );
  });
});

describe('search_subgraphs_by_keyword', () => {
  test('maps a hit and fills in what the registry left out', async () => {
    // Every field below `id` is optional in the registry's metadata, and a
    // subgraph published without a display name is common. Throwing on one would
    // lose the whole result set for a cosmetic gap.
    await withServer(
      () =>
        textResult(
          JSON.stringify({
            subgraphs: [
              {
                id: 'FQ6JYszEKApsBpAmiHesRsd9Ygc6mzmpNRANeVQFYoVX',
                metadata: { displayName: 'Uniswap V3 Arbitrum' },
                currentVersion: { subgraphDeployment: { ipfsHash: 'QmDeployment' } },
              },
              { id: 'bare' },
              { id: 'partial', metadata: {}, currentVersion: {} },
            ],
          }),
        ),
      async (client, server) => {
        assert.deepEqual(await client.searchSubgraphs('uniswap v3'), [
          {
            id: 'FQ6JYszEKApsBpAmiHesRsd9Ygc6mzmpNRANeVQFYoVX',
            displayName: 'Uniswap V3 Arbitrum',
            ipfsHash: 'QmDeployment',
          },
          { id: 'bare', displayName: '(unnamed)', ipfsHash: null },
          { id: 'partial', displayName: '(unnamed)', ipfsHash: null },
        ]);
        assert.deepEqual(server.calls[0]!.params.arguments, { keyword: 'uniswap v3' });
      },
    );
  });

  test('a response with no subgraphs key is an empty result, not a crash', async () => {
    await withServer(
      () => textResult('{}'),
      async (client) => {
        assert.deepEqual(await client.searchSubgraphs('nothing matches this'), []);
      },
    );
  });
});

describe('get_deployment_30day_query_counts', () => {
  test('asks nothing when there is nothing to ask about', async () => {
    // The early return is not an optimisation: the server rejects an empty
    // `ipfs_hashes`, so without it a search that found no deployments would fail
    // on the follow-up call rather than reporting no deployments.
    await withServer(
      () => {
        throw new Error('the server must not be called for an empty hash list');
      },
      async (client, server) => {
        assert.deepEqual(await client.queryCounts([]), {});
        assert.equal(server.getHeaders.length, 0, 'no session was even opened');
      },
    );
  });

  test('reads the count out of all three shapes the server has been seen to use', async () => {
    // snake_case, camelCase and a `deployments` wrapper. The tolerance is
    // deliberate — query volume is how the analyst tells a maintained deployment
    // from an abandoned fork of it, and a shape change that silently zeroed every
    // count would make the two indistinguishable rather than raising anything.
    await withServer(
      () =>
        textResult(
          JSON.stringify([
            { ipfs_hash: 'QmA', total_query_count: 1_200_000 },
            { ipfsHash: 'QmB', query_count: 42 },
          ]),
        ),
      async (client) => {
        assert.deepEqual(await client.queryCounts(['QmA', 'QmB']), { QmA: 1_200_000, QmB: 42 });
      },
    );

    await withServer(
      () => textResult(JSON.stringify({ deployments: [{ ipfs_hash: 'QmC', total_query_count: 7 }] })),
      async (client) => {
        assert.deepEqual(await client.queryCounts(['QmC']), { QmC: 7 });
      },
    );
  });

  test('a hashless row is dropped and a countless row is zero, which are different claims', async () => {
    // Zero queries is a finding about the deployment. A row we cannot attribute
    // to a deployment is a finding about the response, and folding it into the
    // map under `undefined` would put a key nobody asked for next to the real
    // ones.
    await withServer(
      () =>
        textResult(
          JSON.stringify([
            { total_query_count: 99 },
            { ipfs_hash: 'QmSilent' },
            { ipfs_hash: 'QmZero', total_query_count: 0 },
          ]),
        ),
      async (client) => {
        assert.deepEqual(await client.queryCounts(['QmSilent', 'QmZero']), {
          QmSilent: 0,
          QmZero: 0,
        });
      },
    );
  });

  test('a response that is neither an array nor a deployments wrapper yields no counts', async () => {
    await withServer(
      () => textResult('{"unexpected":true}'),
      async (client) => {
        assert.deepEqual(await client.queryCounts(['QmA']), {});
      },
    );
  });
});

describe('schema, instructions and listTools', () => {
  test('the schema comes back as raw SDL, not parsed', async () => {
    // It is GraphQL SDL and JSON.parse would reject it, so `schema` must use the
    // text path. Asking for a field that does not exist is the mistake this
    // method exists to prevent, and it cannot prevent it if it throws first.
    const sdl = 'type LiquidityPool { id: ID! totalValueLockedUSD: BigDecimal! }';
    await withServer(
      () => textResult(sdl),
      async (client, server) => {
        assert.equal(await client.schema('QmSubgraph'), sdl);
        assert.deepEqual(server.calls[0]!.params.arguments, { subgraph_id: 'QmSubgraph' });
      },
    );
  });

  test('the instruction sheet is read from the resource, and a blob answer reads as empty', async () => {
    // The union is `{ text }` or `{ blob }`. Asserting `.text` on a blob would
    // put `undefined` into a prompt; '' at least fails visibly upstream.
    await withServer(
      (call) =>
        call.params.uri === 'graphql://subgraph'
          ? { result: { contents: [{ uri: 'graphql://subgraph', text: 'ALWAYS check query volume.' }] } }
          : { error: { code: -32602, message: `unknown resource ${call.params.uri}` } },
      async (client) => {
        assert.equal(await client.instructions(), 'ALWAYS check query volume.');
      },
    );

    await withServer(
      () => ({ result: { contents: [{ uri: 'graphql://subgraph', blob: 'AAAA' }] } }),
      async (client) => {
        assert.equal(await client.instructions(), '');
      },
    );

    await withServer(
      () => ({ result: { contents: [] } }),
      async (client) => {
        assert.equal(await client.instructions(), '');
      },
    );
  });

  test('listTools returns names only', async () => {
    await withServer(
      () => ({
        result: {
          tools: [
            { name: 'search_subgraphs_by_keyword', inputSchema: { type: 'object' } },
            { name: 'execute_query_by_subgraph_id', inputSchema: { type: 'object' } },
          ],
        },
      }),
      async (client) => {
        assert.deepEqual(await client.listTools(), [
          'search_subgraphs_by_keyword',
          'execute_query_by_subgraph_id',
        ]);
      },
    );
  });
});

describe('query argument construction', () => {
  test('variables are omitted entirely when there are none', async () => {
    // Not the same as sending `variables: undefined`, which JSON.stringify drops
    // anyway — the branch exists so `variables: null` never reaches a server that
    // validates the field's type before looking at the document.
    await withServer(
      () => textResult('{"data":{"ok":true}}'),
      async (client, server) => {
        await client.query('QmSubgraph', 'query { ok }');
        assert.deepEqual(server.calls[0]!.params.arguments, {
          subgraph_id: 'QmSubgraph',
          query: 'query { ok }',
        });
        assert.equal(server.calls[0]!.params.name, 'execute_query_by_subgraph_id');
      },
    );
  });

  test('variables are passed through untouched, including a falsy one', async () => {
    // `hours: 0` and `first: 0` are legitimate and both are falsy, so any
    // truthiness check on the variables object would drop them.
    await withServer(
      () => textResult('{"data":{"ok":true}}'),
      async (client, server) => {
        const data = await client.query<{ ok: boolean }>('QmSubgraph', 'query { ok }', {
          pool: '0xabc',
          hours: 0,
        });
        assert.deepEqual(data, { ok: true });
        assert.deepEqual(server.calls[0]!.params.arguments, {
          subgraph_id: 'QmSubgraph',
          query: 'query { ok }',
          variables: { pool: '0xabc', hours: 0 },
        });
      },
    );
  });

  test('the pinned path addresses the deployment by hash, not by subgraph id', async () => {
    // Sending `subgraph_id` to `execute_query_by_ipfs_hash` is accepted as a
    // missing-argument error by the server, i.e. it fails, but it fails looking
    // like the deployment is gone.
    await withServer(
      () => textResult('{"data":{"ok":true}}'),
      async (client, server) => {
        await client.queryByIpfsHash('QmHash', 'query { ok }', { first: 1 });
        assert.equal(server.calls[0]!.params.name, 'execute_query_by_ipfs_hash');
        assert.deepEqual(server.calls[0]!.params.arguments, {
          ipfs_hash: 'QmHash',
          query: 'query { ok }',
          variables: { first: 1 },
        });
      },
    );

    await withServer(
      () => textResult('{"data":{"ok":true}}'),
      async (client, server) => {
        await client.queryByIpfsHash('QmHash', 'query { ok }');
        assert.deepEqual(server.calls[0]!.params.arguments, {
          ipfs_hash: 'QmHash',
          query: 'query { ok }',
        });
      },
    );
  });

  test('a data payload survives the round trip unchanged', async () => {
    const payload = {
      liquidityPool: { id: '0xpool', totalValueLockedUSD: '1234567.891011121314' },
      _meta: { block: { number: 25_831_581, timestamp: 1_787_631_581 } },
    };
    await withServer(
      () => textResult(JSON.stringify({ data: payload })),
      async (client) => {
        assert.deepEqual(await client.query('QmSubgraph', 'query {}'), payload);
      },
    );
  });
});

// Not covered here, deliberately:
//
// - The stdio transport past construction. `connect()` on it spawns a
//   `subgraph-mcp` binary; there is no such binary in this repo or in CI, and
//   stubbing the spawn would test Node's child_process rather than our code.
//   The branch that is ours — which env vars the child is handed — is asserted
//   only as far as `describe` above.
// - A connect-time failure (the SSE GET answering non-200). `#call` awaits
//   `connect()` outside its try, so that failure escapes as the SDK's own
//   `SseError` rather than a `SubgraphMcpError`. That is a real gap in the
//   naming this file otherwise asserts, but pinning today's unnamed throw in a
//   test would make the gap harder to close rather than easier. Reported
//   instead.
