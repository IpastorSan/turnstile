# uniswap-mcp

An MCP server over the Uniswap stack: **per-pool quotes with
`initializedTicksCrossed`, depth-at-size ladders, factory pool discovery, and
Messari DEX AMM subgraph queries.**

No API key. Every tool is either an `eth_call` against a public contract or a
POST to a public subgraph endpoint.

```bash
npm install
node server.ts

# register it
claude mcp add uniswap -- node "$PWD/server.ts"
```

**Standalone by construction, and checked rather than claimed.** Nothing in this
directory imports anything outside it. Copy the folder out of this repository,
`npm install`, and it runs — there is no Turnstile context to carry along. That
is deliberate: it was extracted to be reusable, not vendored to look reusable.

Verified on 2026-09-07 by doing exactly that: copied to a directory outside the
repo, fresh `npm install`, then `npm test` (60 passing), `npm run typecheck`
(clean) and `node test/live-smoke.ts` against mainnet. The check is worth
running after any change here, because the failure it catches — an import that
reaches back into the parent repo — is invisible from inside the repo.

---

## What it is for

One family of question, answered well: **what will a Uniswap pool actually do**,
as opposed to what it looks like it holds.

Two distinctions do most of the work:

- **TVL is not depth.** v3 and v4 liquidity is concentrated — an LP picks a
  price range, and liquidity outside the current tick cannot fill anything. A
  pool can hold a large notional and still fail a modest trade.
- **A routed quote is not a pool.** A router splits an order across pools for
  best execution. That answers "what will I receive" and not "how deep is this
  pool". Every tool here quotes **one pool**.

## Tools

| Tool | Answers |
|---|---|
| `uniswap_token` | symbol / name / decimals, read from the token. Flags symbol impersonation. |
| `uniswap_find_pools` | which v3 fee tiers exist for a pair, their addresses, liquidity and tick |
| `uniswap_quote` | one exact-input quote against one pool, v3 (QuoterV2) or v4 (V4Quoter) |
| `uniswap_pool_depth` | a ladder of sizes against one v3 pool, all at one block: the curve |
| `uniswap_amm_query` | indexed history through a Messari DEX AMM (Extended) subgraph |

Chains: `mainnet`, `arbitrum`, `optimism`, `base`, `polygon`. Every address in
`src/chains.ts` was checked with `eth_getCode` on 2026-09-07; a chain that has
not been checked is absent rather than guessed.

## It works — here is it working

Live against mainnet, block 25926800, via `test/live-smoke.ts`:

```
=== uniswap_pool_depth ===
Depth of the WETH/USDC 0.05% pool on mainnet, all rungs at block 25926800.
  sizeIn                 out    impact  ticks
       1         2479.761982    0.000%  1
      10        24795.448845    0.009%  1
     100       247735.449049    0.097%  3
    1000      2455419.048573    0.982%  20
   10000      22453014.79877    9.455%  164
```

Read the last column. A trade 10,000x larger than the reference walks through
**164 initialized ticks instead of 1** — that is the pool's depth expressed
mechanically, rather than as an impression that the price got worse. Nothing in
a routed quoting API returns an equivalent number.

Reproduce it:

```bash
node test/live-smoke.ts
```

## `initializedTicksCrossed`, and why it is the point

QuoterV2 returns it and it is the most informative single field in this server.
Each initialized tick crossed is a discrete band of liquidity consumed.

| Across a 1x → 10,000x ladder | Reading |
|---|---|
| Tick count barely moves | Dense liquidity around the price. Genuinely deep. |
| Tick count climbs steadily | Ordinary; impact roughly proportional to size. |
| Tick count jumps at one rung | Liquidity runs out there. Thin, but looks large. |
| A rung reverts | Cannot fill that size. This is the measurement, not an error. |

V4Quoter returns `(amountOut, gasEstimate)` and no tick count, so a v4 depth
reading is a price curve without the mechanical explanation. The output says so
rather than letting the absence pass as a zero.

## Design decisions worth knowing

**Every rung of a ladder is pinned to one block.** Quoting five sizes across
five blocks measures the pool moving as much as it measures the pool's depth.
`profileDepth` reads the block number once and passes it into every quote.

**A revert is a data point.** The size at which a pool stops filling is exactly
what a depth profile is looking for, so a reverting rung is recorded as "cannot
fill" and the walk continues.

**Impact is measured against the smallest filling rung, not against spot.** Spot
is the marginal price of an infinitesimal trade and nobody executes at it;
measuring against it charges every trade for the fee tier and the first tick
crossing. The reference here answers the question a trader actually has — what
does going bigger cost me, relative to going small.

**`maxSizeWithinSlippage` is labelled `interpolated`.** It is linear
interpolation between the last rung inside the budget and the first outside, and
concentrated liquidity is piecewise — it can fall off a cliff between two rungs.
The flag is there so the number is used as a place to look rather than as a
limit to trade on. When no rung leaves the budget, it returns the largest rung
with `interpolated: false`, meaning "at least this much".

**A chain mismatch is refused, not absorbed.** The client checks the RPC's own
`eth_chainId` against the configured chain once and throws on disagreement. A
mainnet RPC quietly answering a Base question does not produce a wrong-*looking*
answer — it produces a plausible one, which is worse.

**A bare `RPC_URL` is ignored unless `RPC_CHAIN` names its chain.** Same reason.
Use `MAINNET_RPC_URL`, `BASE_RPC_URL`, and so on.

**`decimals` is always read and never defaulted.** Assuming 18 for a 6-decimal
token is wrong by a factor of a trillion and still returns a number.

**Amount conversion goes through the shortest round-tripping decimal**, not
`toFixed`. `(0.1).toFixed(18)` is `"0.100000000000000006"`, so a toFixed-based
conversion invents digits for small amounts; multiplying in a double loses them
for large ones. See the comment on `splitDecimal` in `src/amounts.ts` — this is
the single easiest way for a quoting tool to be silently wrong.

## The quoter is not a `view` function

The thing everyone hits first. QuoterV2 and V4Quoter start the swap and
deliberately revert, then read the amounts out of their own revert data.
`V4Quoter.sol` says so in its NatSpec:

> These functions are not marked view because they rely on calling non-view
> functions and reverting to compute the result.

So you simulate rather than send. **The library-neutral statement is: call it
through `eth_call`.** Only the spelling differs:

| Library | Spelling |
|---|---|
| viem | `publicClient.readContract({ ... })` |
| ethers v6 | `contract.fn.staticCall(params)` |
| ethers v5 | `contract.callStatic.fn(params)` |

Much of Uniswap's documentation gives only the last form. `callStatic` was
**removed in ethers v6** — verified against 6.17.0, where `contract.callStatic`
is `undefined` and the documented call throws `TypeError: Cannot read properties
of undefined` — and viem has no `callStatic` under any name. Verified live on
2026-09-07 against mainnet V4Quoter for the ETH/USDC 0.05% pool: viem
`readContract` and ethers v6 `.staticCall` both return **2477.420516 USDC** for
1 ETH, agreeing to the last decimal, while the documented `callStatic` throws.

This is fixed upstream in `Uniswap/uniswap-ai` — see the repository root
`FEEDBACK.md`.

## Cross-protocol history

`uniswap_amm_query` speaks the [Messari DEX AMM (Extended) v4.0.1
schema](https://github.com/messari/subgraphs/blob/master/docs/SCHEMA.md), which
is a published standard rather than a Uniswap-specific one. The same document
answers against Uniswap v3, Sushiswap v2 and v3, and Curve, on two chains,
without a per-protocol adapter — so `cumulativeVolumeUSD` means the same thing
everywhere and ranking across protocols is arithmetic rather than archaeology.

The default endpoint is a Uniswap v3 mainnet subgraph implementing that schema.
Point `url` (or `AMM_SUBGRAPH_URL`) at any conformant one.

Every response carries how far behind the chain the subgraph is, and a standing
warning that snapshot series are **sparse** — a `*HourlySnapshot` row exists only
for an hour in which an event occurred, so `first: 24` is the last 24 rows, not
the last 24 hours, and dividing by the row count reports a pool with three
trades a day as trading all day.

## Layout

```
server.ts           stdio entry point
src/chains.ts       verified addresses per chain; RPC precedence
src/client.ts       viem client + the chain-id mismatch check
src/tokens.ts       ERC-20 metadata, bytes32 fallback, impersonation warnings
src/amounts.ts      exact decimal <-> raw conversion
src/pools.ts        factory pool discovery
src/quotes.ts       QuoterV2 and V4Quoter
src/depth.ts        the ladder, the curve, the slippage estimate
src/subgraph.ts     Messari DEX AMM queries, _meta injection, staleness
src/format.ts       the prose summary that precedes every JSON payload
tools/index.ts      MCP tool registrations
test/               60 offline tests; live-smoke.ts is separate and needs network
```

## Tests

```bash
npm test          # 60 tests, no network
node test/live-smoke.ts   # drives the real server over stdio against mainnet
```

The offline tests stub the client and encode real ABI return data, so what is
tested is this server's handling of the quoter's contract — including the
failure paths, which is where the interesting behaviour is.

## What it will not tell you

- A quote is a **simulation at one block**, not a guaranteed fill.
- **Gas, MEV and sandwiching** are out of scope. `gasEstimate` is the quoter's
  own figure, not a transaction cost.
- Nothing here checks whether a **token** is safe — no honeypot, transfer-fee or
  upgradeability analysis.

MIT.
