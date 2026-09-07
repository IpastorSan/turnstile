# The Graph — notes from building against it

Observations about The Graph's tooling, gathered while building `seller/analyst/`
(MOV-216). Kept **out of `FEEDBACK.md`**, which is a Uniswap deliverable read by
Uniswap judges against their $3,000 track; none of this is Uniswap's problem.
Some of it is worth stating in the Graph submission, but carefully, which is why
it is written down precisely rather than from memory.

Everything here was tested, not assumed. Dates are on every claim.

---

## The Subgraph MCP server

`github.com/graphops/subgraph-mcp`, hosted at
`https://subgraphs.mcp.thegraph.com/sse`. Our client is
`seller/analyst/subgraph-mcp.ts`.

### What it is, and what it is not

**It holds no language model.** This is the thing most likely to be misread in a
pitch, in either direction. The server does three mechanical things:

| Tool | Does |
|---|---|
| `search_subgraphs_by_keyword` | keyword match on subgraph display names, ordered by curation signal |
| `get_deployment_30day_query_counts` | query volume per deployment over 30 days |
| `get_schema_by_subgraph_id` / `_by_ipfs_hash` / `_by_deployment_id` | returns GraphQL SDL |
| `execute_query_by_subgraph_id` / `_by_ipfs_hash` / `_by_deployment_id` | runs a document, returns the response |
| `get_top_subgraph_deployments` | top 3 deployments for a contract address + chain |

It cannot decide which subgraph is the right one, cannot write a query, and
cannot read a result. All of that reasoning is ours. What it removes is having
to know a gateway URL, a deployment id and an auth scheme for every subgraph you
might want to ask — which is genuinely most of the integration cost, and is a
fair thing to claim.

It does ship a **prompt**, as an MCP resource at `graphql://subgraph`, which is
a long prose instruction sheet written for a model to follow. Its central rule
is worth adopting on its own merits:

> **IMPORTANT: ALWAYS verify query volumes using `get_deployment_30day_query_counts`
> for any potential subgraph candidate *before* selecting or querying it. This
> step is NON-OPTIONAL.**

That is right, because display names do not distinguish a maintained deployment
from an abandoned fork of it and query volume does. `SubgraphMcpClient` exposes
`instructions()` so we read the sheet from the server rather than hardcoding a
copy that can silently drift from it.

### Authentication — the precise version (verified 2026-09-07 13:49 UTC)

Five requests, same tool (`execute_query_by_subgraph_id`), same subgraph
(`FQ6JYszEKApsBpAmiHesRsd9Ygc6mzmpNRANeVQFYoVX`), varying only the header:

| `Authorization` header | Result |
|---|---|
| `Bearer $GRAPH_GATEWAY_API_KEY` (our real key) | served |
| *(header absent entirely)* | **served** |
| `Bearer ` (empty value) | **served** |
| `Bearer aaaa…` (32 hex chars, well-formed, not a real key) | rejected — `auth error: API key not found` |
| `Bearer not-a-real-key-0000` (wrong shape) | rejected — `auth error: malformed API key` |

So the accurate sentence is:

> **The hosted Subgraph MCP server validates an API key when one is supplied and
> rejects a bad one, but serves requests that supply none.** Our client sends
> `GRAPH_GATEWAY_API_KEY`; a self-hosted `subgraph-mcp` requires it; the hosted
> endpoint accepted requests without it when tested on 2026-09-07.

Use that phrasing. Do **not** write "the MCP client authenticates with our
gateway key and that is why it returns data" — an absent key returns the same
data, so the claim would not survive a judge repeating the test. Equally, do not
write "it ignores auth", because a wrong key is rejected, which the "malformed"
vs "not found" distinction shows is real validation rather than a blanket allow.

What we **cannot** determine from outside: whether an anonymous request is
served on the server's own gateway credential, or on an anonymous tier, or
against a free public endpoint. Any of those would produce what we observed.
Worth saying so rather than guessing, because the difference matters for whether
query fees flow to indexers on our behalf.

### It cannot see a Subgraph Studio deployment

Every tool addresses the **decentralized network** — by subgraph id, deployment
id, or IPFS hash. Our own `turnstile-uniswap-v-3-messari` is published to
Studio, and asking for it by its exact IPFS hash returns:

```
MCP error -32603: GraphQL error: subgraph not found: QmS97mesuaXzXePGmD4JXvGRQ7tbMYtCzukYSzZj2qUWfA
```

Verified 2026-09-07. This is why `seller/analyst/subgraph.ts` carries two
sources behind one interface — `mcpSource()` for the network, `httpSource()` for
our Studio endpoint — rather than one. It is a design consequence, not a
workaround: the same GraphQL document runs over either, which is the Messari
schema doing its job.

If we ever publish to the network, `mcpSource({ subgraphId })` will reach our own
subgraph with no code change, and the HTTP source becomes optional.

### Two client-side gotchas worth keeping

**1. The SSE `GET` is a separate leg from the POST, and the SDK only puts your
headers on one of them.** `SSEClientTransport`'s `requestInit.headers` go on the
POST to the message endpoint. The `GET` that opens the event stream is built
from `eventSourceInit`, and without an explicit `fetch` override it goes out
with no `Authorization` at all:

```ts
new SSEClientTransport(url, {
  requestInit: { headers },
  eventSourceInit: {
    fetch: (u, init) => fetch(u, { ...init, headers: { ...(init?.headers ?? {}), ...headers } }),
  },
});
```

This is invisible against the hosted server — which, per the table above, serves
unauthenticated requests anyway — and fatal against a self-hosted instance
behind auth. A bug that only appears when you move to your own deployment is the
worst kind.

**2. Errors arrive on two different channels.** A GraphQL *validation* failure
(unknown field) comes back as a normal tool result with `isError: true` and the
message in the content. A *routing* failure (unknown deployment, unreachable
indexer) is thrown by the SDK as an `McpError`. Handling only the first leaves
an unhandled rejection in the second case, which is how a missing subgraph
crashes a process instead of reporting itself. `SubgraphMcpClient.#call`
normalizes both into `SubgraphMcpError`.

---

## The deployed subgraph, from a consumer's side

Fuller detail in `graph/subgraph/README.md`, under the MOV-216 corrections.
Two things a consumer must handle, summarized here because they will bite
anything else we build on it:

- **It is still backfilling.** 12.6 days behind chain head at 2026-09-07 13:44
  UTC (block 25,835,635 against 25,925,853), `hasIndexingErrors: false`. Read
  `_meta.block.timestamp` and report the lag; do not present indexed history as
  current.
- **Interval snapshot rows are sparse.** An hour with no event produces no
  `LiquidityPoolHourlySnapshot` at all, not a row of zeroes. `first: 24` returns
  the last 24 *snapshots*, not the last 24 *hours*, so anything dividing by row
  count will report a pool with three trades in a day as trading 100% of the
  time. Window by the `hour` field against `_meta.block.timestamp`, floored at
  `LiquidityPool.createdTimestamp`.

---

## For whoever writes the Graph submission

Claims that are true and that we can demonstrate on demand:

- The analyst **composes the Subgraph MCP server with our own subgraph**, and
  reaches the decentralized gateway underneath the MCP server. Verified against
  Messari's Uniswap v3 Arbitrum deployment at Arbitrum block 502,694,066.
- **One GraphQL document** runs unchanged against our deployment and against
  other teams' Messari deployments on another chain. Adding a venue is a
  subgraph id, not an adapter.
- The output is a **reasoned verdict**, not a query result: the top three pools
  by TVL on our subgraph all come back `AVOID`, and the #1 by TVL is a fake
  18-decimal `USDT` that cannot fill a $1,000 trade.

Claims to avoid:

- "Authenticated with our gateway key" — see the table above; say the precise
  sentence instead.
- Anything implying the MCP server does the reasoning. It does not, and saying
  so undersells the part that is actually ours.
