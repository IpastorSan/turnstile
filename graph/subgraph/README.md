# graph/subgraph — Messari DEX AMM (Extended) v4.0.1

A Uniswap v3 subgraph for Ethereum mainnet that implements a **standardized
schema** rather than a bespoke one, and a query that proves why that matters.

The schema in `schema.graphql` is not ours. It is
[Messari DEX AMM (Extended) v4.0.1](https://github.com/messari/subgraphs/blob/master/docs/SCHEMA.md),
copied verbatim from `messari/subgraphs`. Every entity name, field name, field
type and nullability is the standard's. That is the entire point: a consumer
who has written a query once can point it at this subgraph without editing a
character of it.

---

## The one query, and what it runs against

`queries/cross-protocol.graphql`. One document, no per-protocol branching, no
adapter layer:

```graphql
query AmmVitals {
  dexAmmProtocols(first: 1) {
    name
    slug
    schemaVersion
    network
    totalValueLockedUSD
    cumulativeVolumeUSD
    cumulativeSupplySideRevenueUSD
    cumulativeUniqueUsers
    totalPoolCount
  }
  liquidityPools(first: 3, orderBy: totalValueLockedUSD, orderDirection: desc) {
    name
    inputTokens { symbol }
    totalValueLockedUSD
    cumulativeVolumeUSD
    fees { feeType feePercentage }
  }
  swaps(first: 2, orderBy: timestamp, orderDirection: desc) {
    blockNumber
    timestamp
    tokenIn { symbol }
    amountInUSD
    tokenOut { symbol }
    amountOutUSD
  }
  _meta { block { number timestamp } }
}
```

Run it yourself:

```bash
export GRAPH_GATEWAY_API_KEY=...        # any Graph gateway key
./scripts/run-query.sh queries/cross-protocol.graphql
```

That sweeps every subgraph in `queries/targets.txt` and writes each response to
`samples/`. The targets are four **different AMM protocols, indexed by
different teams, across two chains**, and the query is byte-identical for all
of them:

| Target | Protocol | Chain | `schemaVersion` | Gateway subgraph id |
|---|---|---|---|---|
| `uniswap-v3-arbitrum` | Uniswap V3 | Arbitrum One | 4.0.1 | `FQ6JYszEKApsBpAmiHesRsd9Ygc6mzmpNRANeVQFYoVX` |
| `sushiswap-v3-ethereum` | Sushiswap V3 | Ethereum | 4.0.0 | `2tGWMrDha4164KkFAfkU3rDCtuxGb4q1emXmFdLLzJ8x` |
| `sushiswap-v2-ethereum` | SushiSwap | Ethereum | 1.3.2 | `77jZ9KWeyi3CJ96zkkj5s1CojKPHt6XJKjLFzsDCd8Fd` |
| `curve-ethereum` | Curve Finance | Ethereum | 1.3.0 | `3fy93eAT56UJsRCEht8iFhfi6wjHWXtZ9dnnbQmvFopF` |

A constant-product AMM, a concentrated-liquidity AMM, and a StableSwap
invariant AMM answer the same document. Curve does not have a `tick`; Uniswap
v3 does not have Curve's amplification coefficient. Neither difference reaches
the query, because the standard describes what a DEX *is* — a protocol, pools,
input tokens, fees, swaps — rather than how any one of them is built.

### A real response, captured live

From `samples/cross-protocol.sushiswap-v3-ethereum.json`, trimmed:

```json
{
  "data": {
    "dexAmmProtocols": [
      {
        "name": "Sushiswap V3",
        "slug": "sushiswap-v3",
        "schemaVersion": "4.0.0",
        "network": "MAINNET",
        "totalValueLockedUSD": "18956109111.91286883924473193395782",
        "cumulativeVolumeUSD": "647461566.2866540440269360628172424",
        "cumulativeSupplySideRevenueUSD": "1642790.519727390329504732842154215",
        "cumulativeUniqueUsers": 101803,
        "totalPoolCount": 884
      }
    ],
    "liquidityPools": [
      {
        "name": "Sushiswap V3 Wrapped BTC/Wrapped Ether 0.3%",
        "inputTokens": [{ "symbol": "WBTC" }, { "symbol": "WETH" }],
        "totalValueLockedUSD": "9340954.684450018842843040705955731",
        "cumulativeVolumeUSD": "45671552.23952905507394107598123155",
        "fees": [
          { "feeType": "FIXED_PROTOCOL_FEE", "feePercentage": "0" },
          { "feeType": "FIXED_LP_FEE", "feePercentage": "0.3" },
          { "feeType": "FIXED_TRADING_FEE", "feePercentage": "0.3" }
        ]
      }
    ],
    "_meta": { "block": { "number": 25925032, "timestamp": 1788778703 } }
  }
}
```

Block 25925032 is `2026-09-07T10:58:23Z`. The sweep finished at `10:58:37Z`.
The data is 14 seconds old — it is the chainhead, served by the decentralized
gateway, not a fixture.

### The Extended half

`queries/concentrated-liquidity.graphql` asks for the entities that only the
**Extended** variant carries — `Tick`, `Position`, `activeLiquidity` — which is
why this subgraph targets Extended rather than the base DEX AMM schema:

```graphql
liquidityPools(first: 1, orderBy: cumulativeVolumeUSD, orderDirection: desc) {
  name
  tick
  activeLiquidity
  positionCount
  openPositionCount
  positions(first: 2, orderBy: liquidityUSD, orderDirection: desc) {
    account { id }
    liquidity
    liquidityUSD
    cumulativeDepositUSD
    tickLower { index prices liquidityGross }
    tickUpper { index prices liquidityGross }
  }
}
```

It succeeds against the two 4.0.x targets and fails against the two 1.3.x ones
with `Type LiquidityPool has no field tick`. That failure is *useful*: it is a
schema version boundary reported precisely, at the field level, before a byte
of data moves — which is what you get from a shared schema and do not get from
four bespoke ones, where the same question is four undocumented integrations
and a shrug.

---

## What the shared schema actually made easier

Concretely, not in the abstract:

- **The consumer is written once.** Turnstile sells answers derived from AMM
  state. Every additional venue we quote is a row in `queries/targets.txt`, not
  a new adapter, a new field-name mapping, or a new set of decimal conventions.
  Adding Curve to the sweep above cost one line.
- **Cross-protocol comparison is arithmetic, not archaeology.** `cumulativeVolumeUSD`
  means the same thing in all four responses, so summing or ranking across
  protocols is legitimate. Against each protocol's own native subgraph it is
  not — they do not agree on entity names, on which entity carries volume, on
  whether an amount is raw or decimal-adjusted, or on the window a "cumulative"
  figure covers, and establishing that is a per-protocol research task before
  any arithmetic is safe.
- **Fee semantics survive the trip.** `FIXED_TRADING_FEE` / `FIXED_LP_FEE` /
  `FIXED_PROTOCOL_FEE` decompose the fee the same way everywhere, so "what does
  the LP actually earn" is answerable without knowing whether a protocol calls
  it `feeTier`, `admin_fee` or `swapFeePercentage`. Our handler emits exactly
  the same three rows Sushiswap V3's does, and we did not coordinate — we both
  read the same document.
- **Version negotiation is free.** `schemaVersion` is a field, so a consumer can
  branch on capability (`>= 4.0` implies ticks and positions exist) instead of
  probing and catching errors.

The cost side, stated plainly: conforming is more work than a bespoke schema.
The standard mandates fields a v3 indexer has no natural source for, and you
have to decide what they honestly mean rather than leaving them out. See
*Modelling decisions* below.

---

## What this subgraph indexes

Uniswap v3 on Ethereum mainnet, from block **25,910,000** (`2026-09-05T09:57Z`).

| Data source | Address | Why |
|---|---|---|
| `Factory` | `0x1f98431c…f984` | Spawns a `Pool` template for pools created after the start block |
| `PositionManager` | `0xc36442b4…fe88` | v3 LP positions are ERC-721s; `Position` / `PositionSnapshot` come from here |
| 8 curated pools | see `subgraph.yaml` | The deepest v3 pools, so there is real volume from the first indexed block |

**On the start block and the curated pools.** A factory-only subgraph starting
at a recent block indexes a live chainhead containing almost no volume, because
every pool with liquidity in it was created years earlier. Indexing from the v3
genesis block instead is a multi-day sync. The curated static data sources
resolve that: eight real, deep pools (USDC/WETH 0.05% and 0.30%, WBTC/WETH,
WETH/USDT 0.05% and 0.30%, USDC/USDT, DAI/USDC, DAI/WETH) are declared in the
manifest and run the *same handlers* as any template-spawned pool. Nothing is
mocked, hardcoded as data, or replayed — these are live event streams from
mainnet contracts. Pools are also created lazily when the position manager
touches one we have not seen, and a template is spawned for it so it is indexed
from that block onward.

Handlers cover swaps, deposits, withdrawals, fees, ticks and positions:

| Event | Entities written |
|---|---|
| `Pool.Swap` | `Swap`, `LiquidityPool`, `Token` prices, revenue, all snapshots |
| `Pool.Mint` | `Deposit`, `Tick` (both bounds), reserves, active liquidity |
| `Pool.Burn` | `Withdraw`, `Tick` (both bounds), reserves, active liquidity |
| `Pool.Initialize` | `LiquidityPool.tick`, token prices |
| `Factory.PoolCreated` | `LiquidityPool`, `LiquidityPoolFee`, `Token`, Pool template |
| `NFPM.IncreaseLiquidity` | `Position`, `PositionSnapshot`, `Account` |
| `NFPM.DecreaseLiquidity` | `Position` (closes at zero liquidity), `PositionSnapshot` |
| `NFPM.Transfer` | `Position.account`, both `Account`s' open/closed counts |

---

## Modelling decisions

Where the standard demands a field Uniswap v3 does not directly provide, this
is what we did and why. All of it is visible in `src/common/`.

**Interval deltas in immutable snapshots.** Every snapshot carrying a `daily*`
or `hourly*` field is `@entity(immutable: true)`, so it can be written exactly
once. The delta therefore has to be computed at the *rollover* of the interval
it closes, as `cumulative now − cumulative at the previous rollover`, and the
second term needs somewhere to live between rollovers. It goes in `_HelperStore`,
which is the standard's own escape hatch for this, rather than in a
non-standard entity that would break conformance. Consequence worth knowing:
the currently open interval has no `LiquidityPool*Snapshot` yet — only closed
intervals do. `UsageMetrics*Snapshot` is the exception; the standard leaves it
mutable, so the open interval is queryable there.

**USD pricing.** ETH/USD comes from the USDC/WETH 0.05% pool's `sqrtPriceX96`,
which is an exact on-chain quantity, and is bootstrapped with a `slot0()` call
so the first block of the sync is priced correctly instead of at zero. Any pair
with a stablecoin or WETH on one side prices the other side from the same sqrt
price. Pairs anchored to neither keep their last known price rather than
reporting a confident zero.

**`liquidityUSD` on ticks and positions.** A concentrated-liquidity `liquidity`
value is virtual — `sqrt(x·y)`, not a token amount — so there is no honest
direct conversion. We scale by the pool's own value per unit of active
liquidity. This is an approximation and is marked as one in `liquidityToUSD()`.

**Volume on a swap.** Both sides of a swap are the same trade. Where both sides
are priced we average them, so a single mis-priced token cannot double the
reported volume; where only one side is priced we use that side.

**Burn vs. Collect.** A v3 `Burn` credits amounts as owed and `Collect` moves
them later. We treat the burn as the withdrawal, which is what production v3
subgraphs do — it keeps reserves and TVL aligned with liquidity that is
actually still working.

**Accounts.** `Swap.account`, `Deposit.account` and `Withdraw.account` are
`transaction.from`, not the event's `sender`/`owner` — for router- and
manager-mediated protocols the latter is the router or the position manager,
which would make `cumulativeUniqueUsers` a count of contracts.

**The one schema edit.** `graph-cli >= 0.90` rejects a bare `@entity`, so the 12
bare occurrences in the standard's file were rewritten to
`@entity(immutable: false)` — the semantics they already had. No name, type or
nullability moved. It is annotated at the top of `schema.graphql`.

### One thing we found in the reference implementation

Messari's own published v3 subgraphs return a constant for `Tick.prices`
regardless of the tick index. From `samples/concentrated-liquidity.uniswap-v3-arbitrum.json`:

```json
"tickLower": { "index": "-194150", "prices": ["1.0001", "0.9999000099990001"] },
"tickUpper": { "index": "-194130", "prices": ["1.0001", "0.9999000099990001"] }
```

Two different ticks, identical prices, and `1.0001` is `1.0001^1` — the
exponentiation by the tick index is not being applied. `Position.liquidityUSD`
comes back `"0"` on the same responses. Our `tickToPrices()` does the
exponentiation properly (by squaring, on `BigDecimal`, to avoid an f64
round-trip) and our `liquidityUSD` is populated. Conforming to a schema is not
the same as copying an implementation, and this is the difference showing.

---

## Does it actually index?

Yes — verified by running it, not by it compiling. A local `graph-node` indexed
200 real mainnet blocks against an archive RPC and reached chainhead
`healthy`, `hasIndexingErrors: false`, with every entity family populated:

| | |
|---|---|
| Pools | 28 — the 8 curated, plus 20 discovered live through the position manager |
| Swaps / Deposits / Withdraws | populated, with USD amounts on both sides |
| Ticks | populated, `prices` varying correctly with index |
| Positions / PositionSnapshots | 34 cumulative, 21 open, ERC-721 typed |
| Usage + pool hourly snapshots | written on each rollover |
| `FinancialsDailySnapshot` | empty — 200 blocks does not cross a UTC midnight |

Spot-checks that mattered: the USDC/WETH 0.05% pool came back at tick `198129`
holding 77.05M USDC and 11,403 WETH for $105.4M TVL, and the ETH price the
subgraph derived from the sqrt price agrees with the price implied by the tick
to within a few tenths of a percent.

Indexing it is also what found the one real bug in this code — usage metrics
reported `dailyActiveUsers: 456` against `cumulativeUniqueUsers: 442`, because
an LP first seen through the position manager was never counted as a user. The
fix is `countUniqueUser()`, and after re-indexing from scratch
`cumulativeUniqueTraders + cumulativeUniqueLPs == cumulativeUniqueUsers` and
`dailyActiveUsers <= cumulativeUniqueUsers` both hold.

This local run is a **test**, not a data source — nothing in this repo's
submission reads from it. Reproduce it with a `graph-node` pointed at an
archive-capable mainnet RPC (a non-archive endpoint stalls silently on the
first `eth_call` into historical state, which is worth knowing) and a copy of
`subgraph.yaml` with a recent `startBlock`.

## Deployed

**Studio:** `turnstile-uniswap-v-3-messari` (note the hyphen Studio inserts into `v-3`)
**Query endpoint:** `https://api.studio.thegraph.com/query/1758854/turnstile-uniswap-v-3-messari/v0.1.0`
**Deployed** 2026-09-07, `startBlock: 25810000` (~2 weeks of history, chosen so closed daily
snapshots exist without a multi-day full-history sync).

First verification, 181 blocks in, `hasIndexingErrors: false`:

| Pool | TVL USD | Volume USD | Swaps |
|---|---|---|---|
| Uniswap v3 USDC/WETH 0.05% | 103,283,728 | 4,519,676 | 255 |
| Uniswap v3 WETH/USDT 0.3% | 114,743,982 | 3,793,409 | 63 |
| Uniswap v3 USDC/WETH 0.01% | 4,628,677 | 1,017,738 | 409 |

**Why a recent `startBlock` still yields real data** — worth stating, because it looks wrong
at first glance. Uniswap v3's factory deployed at block 12,369,621, so a start block 13.4M
blocks later sees almost no `PoolCreated` events. The high-volume pools are nonetheless
indexed because they are declared as **explicit `dataSources`**, not only reached through the
factory template; `getOrCreatePool` creates the entity lazily on the first event it sees, and
ETH/USD is bootstrapped with a `slot0()` call so the opening block prices correctly rather
than at zero. Full history would add the long tail of pools at the cost of days of syncing.

## Build and deploy

```bash
npm install
npm run codegen
npm run build

# Studio
export GRAPH_DEPLOY_KEY=...
npx graph auth "$GRAPH_DEPLOY_KEY"
npx graph deploy turnstile-uniswap-v-3-messari --version-label v0.1.0
```

> **Status.** The subgraph builds and its IPFS bundle uploads cleanly
> (`QmS97mesuaXzXePGmD4JXvGRQ7tbMYtCzukYSzZj2qUWfA`), but the final deploy step
> returns `Subgraph not found`: a Studio deploy key can deploy *to* a subgraph,
> it cannot create one. Creation is a `createSubgraph` mutation on
> `api.studio.thegraph.com/graphql`, and that API rejects the deploy key with
> `Please login first` — it wants a wallet signature. So the subgraph has to be
> created once in the Studio UI, with the slug `turnstile-uniswap-v3-messari`,
> after which the command above works and this note goes away along with the
> deployed id and endpoint.
>
> The live-data requirement is met independently of that: `scripts/run-query.sh`
> queries the decentralized gateway and the samples in this directory are
> chainhead responses, reproducible on demand.

Once deployed, include it in the sweep:

```bash
TURNSTILE_SUBGRAPH_ID=<deployment id> ./scripts/run-query.sh queries/cross-protocol.graphql
```

## Layout

```
schema.graphql                 Messari DEX AMM Extended v4.0.1, verbatim
subgraph.yaml                  factory + position manager + 8 curated pools
abis/                          minimal ABIs, hand-written
src/common/                    protocol, tokens, pools, pricing, ticks, snapshots
src/mappings/                  factory.ts, pool.ts, positionManager.ts
queries/                       the cross-protocol documents + targets
scripts/run-query.sh           runs a document across every target
samples/                       captured live responses
```
