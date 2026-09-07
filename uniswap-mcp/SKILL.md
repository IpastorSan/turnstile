---
name: uniswap-mcp
description: >
  Answer questions about Uniswap pool depth, liquidity and execution from live on-chain state.
  Use when asked "is this pool deep enough", "what will X tokens cost me", "which fee tier
  should I use", "is this pool safe to LP", "how much can I trade without moving the price",
  or when a TVL figure needs checking against what a pool can actually fill. Covers Uniswap v3
  and v4 quoting, factory pool discovery, and Messari DEX AMM subgraph history.
license: MIT
---

# Uniswap depth and execution

This skill goes with the `uniswap-mcp` server. It answers one family of question
well: **what will a Uniswap pool actually do**, as opposed to what it looks like
it holds.

## The distinction the whole skill turns on

TVL is not depth, and a routed quote is not a pool.

- **TVL is not depth.** Uniswap v3 and v4 liquidity is concentrated: an LP
  chooses a price range, and liquidity outside the current tick cannot fill
  anything. A pool can hold a very large notional and still fail a modest trade.
  The only way to know is to quote the size you care about.
- **A routed quote is not a pool.** A swap router splits an order across several
  pools to get the best execution. That is the right answer to "what will I
  receive" and the wrong answer to "how deep is this pool" — you learn about a
  route, not about any one venue. Every tool here quotes **one pool**.

When someone asks whether a pool is worth providing liquidity to, or whether a
$50M TVL number means anything, they are asking a depth question. Reach for
`uniswap_pool_depth`.

## The number to look at: `initializedTicksCrossed`

`uniswap_quote` and `uniswap_pool_depth` return it on v3, and nothing else in
the Uniswap surface area gives you an equivalent. It counts how many discrete
bands of liquidity the trade consumed.

It converts a vague observation into a mechanical one. "The price got worse" is
an impression; "this trade walked through 164 initialized ticks while a trade a
thousand times smaller crossed 1" is a measurement, and it is comparable across
pools and across chains. Read it like this:

| Across a 1x → 10,000x ladder | Reading |
|---|---|
| Tick count barely moves | Liquidity is dense around the current price. Genuinely deep. |
| Tick count climbs steadily | Ordinary. Impact is roughly proportional to size. |
| Tick count jumps sharply at one rung | Liquidity runs out there. The pool is thin and merely looks large. |
| A rung reverts | The pool cannot fill that size at all. This is the measurement, not an error. |

V4Quoter does **not** return a tick count, so a v4 depth reading is a price
curve without the mechanical explanation behind it. Say so rather than implying
the two are equivalent.

## Order of operations

1. **`uniswap_token`** on each address first. `decimals` cannot be guessed —
   assuming 18 for 6-decimal USDC understates an amount by a factor of a
   trillion, and the result still looks like a number. This tool also flags a
   token whose symbol impersonates a well-known one.
2. **`uniswap_find_pools`** to see which fee tiers exist and which hold
   liquidity. Do this before quoting: QuoterV2 reports "no pool at this tier",
   "pool with zero liquidity" and "tokenIn == tokenOut" with the *same* opaque
   `Unexpected error` string, so a failed quote alone will not tell you which
   of the three happened.
3. **`uniswap_quote`** for a single size, or **`uniswap_pool_depth`** for the
   curve. Prefer the ladder whenever the question is about size at all.
4. **`uniswap_amm_query`** for history the chain cannot give you — volume over
   time, fee revenue, positions.

## Calling a quoter yourself

If you are writing code rather than using this server, the thing to know is that
**Uniswap's quoter functions are not `view`**. QuoterV2 and V4Quoter start the
swap and deliberately revert, then read the amounts out of their own revert
data. V4Quoter.sol says so in its NatSpec:

> These functions are not marked view because they rely on calling non-view
> functions and reverting to compute the result.

So you must simulate rather than send. **The library-neutral statement is: call
it through `eth_call`.** Every library can do that; only the spelling differs.

```ts
// viem
const [amountOut, , ticks, gas] = await publicClient.readContract({
  address: QUOTER_V2, abi, functionName: 'quoteExactInputSingle', args: [params],
});

// ethers v6
const [amountOut] = await quoter.quoteExactInputSingle.staticCall(params);

// ethers v5 (legacy)
const [amountOut] = await quoter.callStatic.quoteExactInputSingle(params);
```

Much Uniswap documentation still gives only the third form. `callStatic` was
**removed in ethers v6** — `contract.callStatic` is `undefined` there, so the
documented call throws `TypeError: Cannot read properties of undefined` — and
viem has no `callStatic` under any name. If you are working in a viem codebase,
do not translate `callStatic` literally; `readContract` is the equivalent.

## Reading a subgraph answer honestly

`uniswap_amm_query` speaks the **Messari DEX AMM (Extended)** schema, which is a
published standard rather than a Uniswap-specific one. The same document answers
against Uniswap v3, Sushiswap v2 and v3, and Curve, so cross-protocol comparison
is arithmetic instead of a per-protocol research project.

Two traps, both of which produce confident wrong answers:

- **Staleness.** A subgraph is behind the chain by anywhere from seconds to
  weeks. Every response here reports the lag. A figure from an indexer is a
  historical claim — date it, and never compare it to a live quote without
  saying which is which.
- **Sparse snapshots.** A `*HourlySnapshot` row exists only for an hour in which
  something happened. `first: 24` returns the last 24 *rows*, not the last 24
  *hours*. Dividing by the row count reports a pool with three trades in a day
  as trading all day. Window by the `hour` or `day` field instead.

## Do not rank pools by TVL alone

On mainnet the highest-TVL v3 pools include impersonator tokens: a worthless
token paired against real USDT inherits a plausible price from the anchor side,
and a large balance times a plausible price is a large TVL. Those pools revert
when you try to quote them.

The check has to come from outside the index — a pool's own derived price is not
evidence about that pool. Rank by TVL if you like, then confirm with
`uniswap_pool_depth` that a trade can actually execute.

## What this cannot tell you

Say these plainly rather than implying otherwise:

- A quote is a **simulation at one block**, not a guaranteed fill. The pool can
  move before a swap lands.
- It ignores **gas, MEV and sandwiching**. The `gasEstimate` is the quoter's own
  and is not a transaction cost estimate.
- `maxSizeWithinSlippage` is usually **interpolated between two rungs**, and
  concentrated liquidity is piecewise — it can fall off a cliff in between.
  Treat it as where to look, not as a limit to trade on.
- It says nothing about whether a **token** is safe: no honeypot, transfer-fee
  or upgradeability checks are performed.
