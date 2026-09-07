# seller/analyst — the Liquidity Analyst

Answers one question: **is this pool safe to LP?**

Not "what is its TVL". An LP is short volatility and long fees, exposed to the
pool's *inventory* rather than to its headline number, so the analyst combines
two sources that disagree in useful ways:

| Source | Answers | Weakness |
|---|---|---|
| A Messari DEX AMM subgraph, over the **Subgraph MCP server** or plain HTTP | what the pool *has been* — realized fee revenue, trading continuity, LP count | indexed, therefore behind; its USD prices are derived from pools, so checking a pool against them is circular |
| **Uniswap QuoterV2**, at the current block | what the pool *will do* — depth at size, slippage, ticks crossed | one instant, no history, no notion of whether that instant is typical |

Neither alone answers the question. Cumulative volume cannot tell you the pool
emptied yesterday; a quote cannot tell you it only ever trades for one hour a
day.

---

## The claim, on real data

The top three pools by TVL on our own subgraph, ranked as any dashboard ranks
them, then asked whether they are safe to LP:

```
$ node seller/analyst/analyst-cli.ts --top 3

The naive ranking — top 3 pools by TVL, as any dashboard shows them:

  $1945.56B  Uniswap v3 USDT/USDT 1%                         vol $0.00
     $3.20B  Uniswap v3 TRUMP/WETH 0.3%                      vol $1.53
     $1.24B  Uniswap v3 USDT/WETH 1%                         vol $4.93

SUMMARY — TVL rank against LP verdict

  #1  AVOID              14%  Uniswap v3 USDT/USDT 1%
  #2  AVOID              53%  Uniswap v3 TRUMP/WETH 0.3%
  #3  AVOID              26%  Uniswap v3 USDT/WETH 1%
```

The #1 pool by TVL is a scam token using the symbol `USDT` with 18 decimals,
paired against the real 6-decimal USDT, holding two trillion of the fake and
zero of the real. It cannot fill a $1,000 trade. A TVL ranking puts it first;
a quote puts it nowhere.

That gap — between what an index computes and what a trade can do — is what
this module sells.

---

## What a verdict looks like

Abridged, from a real run on Uniswap v3 USDC/WETH 0.05% at mainnet block
25,925,794. Full output is what the CLI prints.

```
VERDICT: ACCEPTABLE    confidence 75%

  Uniswap v3 USDC/WETH 0.05% looks safe to LP on the evidence available.
  Reserves are genuinely two-sided, live quotes execute at the sizes tested,
  and the fee return is realized rather than projected. The subgraph is 13.1d
  behind the chain head, so the historical half of this verdict describes the
  pool as it was, not as it is. Where the live quote and the history disagree,
  believe the quote. Confidence 75%.

  [PASS] Executable depth
         Real trades execute: $1.00M fills within 1% slippage, and $10.0k
         costs 0.003%.
         This is the only measurement here taken against the live pool rather
         than against indexed history, and it is the one an LP is actually
         exposed to: it is the flow this pool can win.

           $1.0k    0.398654 WETH, slippage 0.000%, 1 initialized tick crossed
           $10.0k   3.986406 WETH, slippage 0.003%, 1 initialized tick crossed
           $100.0k  39.850218 WETH, slippage 0.038%, 2 initialized ticks crossed
           $1.00M   397.118445 WETH, slippage 0.385%, 9 initialized ticks crossed
           $10.00M  3,793.724629 WETH, slippage 4.837%, 125 initialized ticks crossed

  [WARN] Depth against claimed TVL
         Only 0.944% of claimed TVL is reachable within 1% slippage.
         In concentrated liquidity most capital sits outside the active range
         by design, so a small ratio is normal — but it does mean the headline
         number overstates the fee-earning capital by two orders of magnitude,
         and an LP sizing a position off TVL will be disappointed.
```

Every signal prints a claim, the reasoning behind it, and the numbers it rests
on. The query result is present, but as **evidence for a conclusion** rather
than as the output. That is the difference between an analyst and a formatter,
and it is the line the Graph AI track draws.

The analyst also prints what it does not know. Confidence is not decoration: it
falls when there is no live quote, when the subgraph is stale, when a token is
unpriced, and when the depth ladder had to be sized using a price the subgraph
derived from the very pool under examination.

---

## Layout

```
types.ts            The data contract. Imported by everything, imports nothing.
scoring.ts          The judgement. PURE — see below.
subgraph-mcp.ts     Subgraph MCP client (SSE to the hosted server, or stdio to a self-hosted one)
subgraph.ts         SubgraphSource interface, the one GraphQL document, and decoding
uniswap-quotes.ts   Live depth-at-size: QuoterV2, and the Trading API behind a key
analyst.ts          Orchestration and rendering. The importable API.
analyst-cli.ts      Terminal front end
scoring.test.ts     15 tests, most pinning a bug that live data found
```

### `scoring.ts` is pure, and that is a requirement rather than a style

`assess(input)` is a total function of its argument: no network, no clock, no
filesystem, no randomness, no module state. It imports `types.ts` and nothing
else, and takes `now` as a field on its input.

**MOV-227 moved this file into a Chainlink TEE enclave** (2026-09-07 — see
`docs/cre-confidential-workflow.md` and `seller/cre/`). An attested verdict is
only worth something if the same input provably produces the same output, so the
purity is the deliverable. The seam is explicit:

```
gatherInput(...)  ->  AnalystInput  ->  assess(...)  ->  Verdict
^ does the I/O         ^ plain JSON      ^ pure
```

`gatherInput` keeps running outside the enclave, serializes, and the enclave
scores. Nothing in `analyst.ts` changes. If you find yourself wanting
`Date.now()` inside `scoring.ts`, add a field to `AnalystInput` instead.

Two measurements MOV-227 wanted, taken on a real run against USDC/WETH 0.05%
with 48 hours of snapshots (2026-09-07):

- a complete `AnalystInput` serializes to **9,210 bytes** — small enough to pass
  as a single enclave argument, with no need to stream or to fetch from inside;
- `assess(input)` and `assess(JSON.parse(JSON.stringify(input)))` produce
  byte-identical verdicts, so the round trip through the boundary is lossless.

**Correction (2026-09-07, MOV-227):** both held, with one refinement worth
recording. The 9,210-byte figure is per-capture, not fixed — the bundle
`seller/cre/fixtures/usdc-weth-500.json`, taken a few hours later, is **9,218
bytes**. Nothing depends on the exact number, but the on-chain verdict commits
to `keccak256` of the bytes *as served*, so a re-capture is a different
commitment and a buyer checking an old hash against a new bundle will see a
mismatch. `verdict.test.ts` pins both halves: the JSON round trip is stable, and
a reformat is a different bundle.

### `assess()` takes a second argument now

**Correction (2026-09-07, MOV-227):** this section previously implied `THRESHOLDS`
is fixed. It is now the *reference* calibration, and `assess(input, calibration)`
folds an override onto it:

```ts
export type Calibration = { [K in keyof typeof THRESHOLDS]: number };
export function assess(input: AnalystInput, calibration?: Partial<Calibration> | null): Verdict;
```

Nothing else changed — omitting the argument reproduces the old behaviour
exactly, which is why all the existing tests passed unedited, and the function
is still pure. The reason for the change is that the workflow binary running in
the enclave is **not confidential**: the DON supplies it, so a threshold
compiled into it is a published threshold. The seller's real calibration
therefore arrives as a Vault DON secret, released only into the attested
enclave. The public set stays here, and stays public, because the *shape* of the
judgement is what makes a verdict auditable.

---

## Use it

Importable on its own. It needs no HTTP server, no database, and nothing else in
Turnstile — the Graph AI track asks for reusable infrastructure, not one app.

```ts
import { analyzePool, renderVerdict } from './seller/analyst/analyst.ts';

const verdict = await analyzePool({ pool: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640' });
console.log(verdict.rating);      // 'ACCEPTABLE' | 'CAUTION' | 'AVOID' | 'INSUFFICIENT_DATA'
console.log(renderVerdict(verdict));
```

Against any Messari-conformant subgraph on the decentralized network, through
the MCP server — no new code, because the document is the same:

```ts
import { analyzePool, mcpSource } from './seller/analyst/analyst.ts';

const source = mcpSource({ subgraphId: 'FQ6JYszEKApsBpAmiHesRsd9Ygc6mzmpNRANeVQFYoVX' });
const verdict = await analyzePool({
  pool: '0x2f5e87c9312fa29aed5c179e456625d79015299c',   // WBTC/WETH 0.05% on Arbitrum
  source,
  quoter: { rpcUrl: 'https://arbitrum-one-rpc.publicnode.com' },
});
await source.close();
```

Score without fetching, which is the shape MOV-227 needs:

```ts
import { gatherInput } from './seller/analyst/analyst.ts';
import { assess } from './seller/analyst/scoring.ts';

const input = await gatherInput({ pool: '0x88e6...' });   // network
const verdict = assess(JSON.parse(JSON.stringify(input))); // pure; runs anywhere
```

### CLI

```bash
node seller/analyst/analyst-cli.ts --pool 0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640
node seller/analyst/analyst-cli.ts --top 5
node seller/analyst/analyst-cli.ts --pool 0x... --json
node seller/analyst/analyst-cli.ts --subgraph-id FQ6JY... --rpc https://arbitrum-one-rpc.publicnode.com --top 2
```

| Flag | |
|---|---|
| `--pool <address>` | the pool to assess |
| `--top <n>` | rank by TVL, then put a verdict beside each row |
| `--subgraph-id <id>` | read through the Subgraph MCP server instead of our Studio endpoint |
| `--endpoint <url>` | a different HTTP query URL |
| `--rpc <url>` | RPC for the quoter — required when the subgraph is on another chain |
| `--sizes 1000,10000,...` | override the depth ladder |
| `--hours <n>` | snapshots to pull (default 48) |
| `--no-depth` | subgraph only; the verdict will say it is flying blind |
| `--json` | machine-readable |

---

## The two data paths, and why there are two

`mcpSource()` speaks to [`graphops/subgraph-mcp`](https://github.com/graphops/subgraph-mcp),
hosted at `https://subgraphs.mcp.thegraph.com/sse` or self-hosted over stdio.
`httpSource()` posts to a query URL directly.

Both are needed, for a reason found by testing rather than assumed:

> **The Subgraph MCP server cannot see a Subgraph Studio deployment.**
> Every one of its tools addresses the decentralized network — by subgraph id,
> deployment id, or IPFS hash — and Turnstile's own
> `turnstile-uniswap-v-3-messari` is published to Studio. Asking for it by its
> exact IPFS hash returns `GraphQL error: subgraph not found`
> (verified 2026-09-07).

So: our subgraph over HTTP, everyone else's over MCP, one GraphQL document
either way. That the same document works against both is the Messari schema
paying off — the same field names answer on our deployment, on Messari's Uniswap
v3 Arbitrum one, and on Sushiswap V3's, so the analyst is written once and
pointed anywhere.

### Where the reasoning lives

**The MCP server holds no language model.** It does three mechanical things —
keyword search over subgraph names, schema lookup, query execution — and nothing
else. It cannot choose which subgraph to trust, cannot write the query, and
cannot read the result. All of that is ours, in `analyst.ts` and `scoring.ts`.
What the server removes is knowing a gateway URL, a deployment id and an auth
scheme for every subgraph you might want to ask.

Two further things verified against the live hosted server on 2026-09-07:

- **It answers identically with and without `Authorization: Bearer`.** We send
  `GRAPH_GATEWAY_API_KEY` because the documented contract asks for it and a
  self-hosted instance needs it, but we do not claim the hosted endpoint
  authenticates us: tested both ways, same data, no 401.
- The SDK's `SSEClientTransport` sends `requestInit` headers on the POST leg
  only. The SSE `GET` that opens the session needs its own `fetch` override or
  it goes out unauthenticated — invisible against the hosted server, fatal
  against a self-hosted one behind auth. `subgraph-mcp.ts` does the override.

---

## The signals

Seven, chosen because they are the ones that decide whether an LP loses money.
Thresholds are named in one block at the top of `scoring.ts`, each with a note
saying what it defends against.

| Signal | Structural | Asks |
|---|---|---|
| `inventory-balance` | yes | Is the pool two-sided, or a pile of one token? |
| `executable-depth` | yes | Does a real trade fill, and at what cost? |
| `depth-vs-tvl` | yes | How much of the claimed TVL can a trade actually reach? |
| `slippage-curve` | no | Where does liquidity run out? |
| `fee-return` | no | What are LPs realized to have been paid, annualized? |
| `activity-continuity` | yes | Continuous flow, or one burst and silence? |
| `lp-concentration` | no | How many LPs — or is it one person's inventory? |

**Structural** means the signal describes whether the pool is a *venue* at all.
One structural failure is enough for `AVOID`. A non-structural failure is a
reason to be careful, not to walk away. Two structural questions left
*unanswered* give `INSUFFICIENT_DATA` rather than a cautious-sounding guess —
a missing measurement must not be able to masquerade as a measured concern.

Subgraph lag never fails a pool. It lowers confidence and is stated in the
summary, because "the data is old" and "the pool is bad" are different problems
and conflating them produces a verdict nobody can act on.

### Depth is quoted in the direction that drains the thinner side

Deliberate. That is the side that runs out, so it is the direction that finds
the failure. Quoting TRUMP/WETH the other way — buying the abundant token with
the scarce one — makes an empty pool look bottomless. Override with
`direction: 'in0' | 'in1'`.

---

## Gotchas worth knowing before you edit this

- **Hourly snapshots are sparse.** An hour with no event produces no row at
  all, not a row of zeroes, so `first: 24` returns the last 24 *snapshots*, not
  the last 24 *hours*. Counting rows reports a pool with three trades in a day
  as trading 100% of the time. `historyWindow()` in `scoring.ts` windows by
  `hour` against the subgraph head and floors at `createdTimestamp`. We shipped
  this bug and caught it against live data.
- **A subgraph-derived price is not evidence about the pool it came from.** The
  depth ladder is sized in USD using `lastPriceUSD`, which for a thin pool the
  subgraph derived from that same pool. The token amounts quoted are exact; the
  dollar labels on them are only as good as that price. The scorer costs
  confidence for it and says so in the caveats.
- **`readContract` does work on QuoterV2**, despite the functions being
  `nonpayable` — viem simulates through `eth_call` quite happily. We use
  `call` + manual decode anyway, because a chain-agnostic `PublicClient` (which
  we need: the analyst is pointed at mainnet or Arbitrum from a flag) collapses
  `readContract`'s return type to `never`.
- **The Uniswap Trading API needs a key we do not have.** `POST
  /v1/quote` answers `401 Unauthenticated api key or session`. The provider is
  wired and unverified end to end; set `UNISWAP_API_KEY` and `fetchDepth`'s
  `auto` mode prefers it. See `FEEDBACK.md` for why it took two tries to find
  that out.

## Test

```bash
npm test          # includes seller/analyst/scoring.test.ts
npx tsc --noEmit
```

The tests are all against `scoring.ts` and run offline. Most of them exist
because a live run produced a wrong answer and they now pin the fix — sparse
snapshots, the zero-to-90% slippage cliff, a pool where every rung reverts, two
sides sharing a symbol.
