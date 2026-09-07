# Architecture

Date: 2026-09-07
Issue: MOV-230
Asset: [`architecture.svg`](./architecture.svg) (source) · [`architecture.png`](./architecture.png) (embedded in the root `README.md`)

![Turnstile architecture: the three key tiers, and the request path](./architecture.png)

Two things are drawn here because they are the two things a reader has to hold
at once: **where the keys sit**, and **what happens when an agent buys an
answer**. They are not independent — step 05 of the request path is the only
step the hot key touches, and it is the reason the hot key is allowed to exist
at all.

---

## A. The three key tiers

Three wallet vendors is not three ways to do one thing. Each sits where it is
actually best, and together they are one cold/warm/hot hierarchy.

| Tier | Vendor | Holds | Frequency | May authorize |
|---|---|---|---|---|
| **Cold** | Ledger Key Ring (`wallet-cli ring`) | Seller operator identity; owns the ENSv2 name; seals upstream API keys | Once per lifecycle | Hot-key rotation, payout address change, price-ceiling raise |
| **Warm** | Privy | Buyer **organization** wallet + mandate policy | Occasional | Issuing a mandate, raising a cap (quorum), adding an agent |
| **Hot** | Circle / Arc Agent Stack | Buyer agent's spending wallet | Every query | Nothing. Spends *within* the mandate; **signs offchain and never submits a transaction**, so it pays exactly zero gas |

**Correction (2026-09-07, MOV-225):** the Hot row previously read "holds zero
native token (Paymaster)". That is **wrong on Arc, and not fixable by rewording**
— it describes a mechanism that does not exist in this design.

**Why it is wrong.** USDC *is* Arc's native gas token. `eth_getBalance(a)` and
`USDC.balanceOf(a)` are two views of one balance at two precisions, and the
ERC-20 view is the truncated one. Measured against a live Arc address on
2026-09-07:

```
eth_getBalance   285144556003000000   (18 dp) = 0.285144556003 USDC
USDC.balanceOf              285144   ( 6 dp) = 0.285144       USDC
```

So a wallet holding zero native token holds zero USDC and can pay nobody. There
is no Paymaster anywhere in Turnstile, and there never was one — the word was
carried over from a chain where gas and payment are different assets.

**What is true, and is a stronger claim.** The hot wallet signs an EIP-3009
authorization **offchain and never submits a transaction**, so it pays exactly
zero gas. Circle Gateway's batcher submits, and pays. The evidence is the hot
wallet's **nonce**: `eth_getTransactionCount` staying `0` across every settled
payment is unforgeable on-chain proof that it never broadcast anything.
`scripts/arc-paid-request.ts` prints it before and after every run.

Its Gateway balance is funded by the **warm tier** calling
`depositFor(amount, agent)` — the org wallet pays the deposit's gas and the
resulting balance belongs to the agent. That is this table's own hierarchy
expressed in one contract call: the hot key cannot deposit, cannot withdraw, and
cannot widen its own allowance, because each of those is a transaction and a
transaction needs gas it does not have.

**What is unchanged:** every other row, and the invariant below the table. Only
the mechanism named in the Hot row was wrong.


### The invariant

**The key that spends can never raise its own limit.**

Authority flows downward only. If a change would let the hot tier widen its own
mandate, rotate a key, or move a payout address, the change is wrong — take it
to the tier above. Device-backed security is central here, not decorative; there
is no "convenience" path that bypasses the Ledger.

This is visible on chain rather than only in prose. `turnstile:price` is written
by the hot key; `turnstile:price-ceiling` is written by the cold key. A hot key
that tries to price above the ceiling is rejected by the resolver's write
permissions, not by a policy document. See
[`ens-offer-records.md`](./ens-offer-records.md).

### Where each tier is implemented today

| Tier | State on 2026-09-07 |
|---|---|
| Cold | **Live.** `liquidity.turnstile.eth` on Sepolia, resolver `0xb1B4Da2C49814c8CbF975E7a48fbB014EA0b075B`, operator proof `ledger-key-ring` published as a resolver record. |
| Warm | **Not built.** MOV-228 (Privy) has not been started. `/mandate` in the web app is a labelled placeholder. |
| Hot | **Built (MOV-225), and it is the Arc rail's buyer half.** `buyer/watchdog/arc-signer.ts` is the spending wallet: it signs EIP-3009 authorizations against Circle Gateway and submits nothing, so its nonce stays 0. Funded by the warm tier through `depositFor`. **Correction (2026-09-07, MOV-225):** this row previously read "Not built. The Arc/Circle spending wallet lands with the rails work." — that was accurate when written and the rails work has now landed. The **Warm** row above is unchanged and still accurate: MOV-228 (Privy) is not started, and the `depositFor` caller is a plain key today rather than an org wallet with a quorum. |

---

## B. The request path

```
01 Discover  →  02 Read the offer  →  03 Ask  →  04 402  →  05 Pay  →  06 Answer
```

| Step | What happens | Where it lives | State |
|---|---|---|---|
| **01 Discover** | ERC-8004 Identity Registry registrations, streamed cross-chain via Substreams into a queryable store | `graph/substreams/`, `graph/sink/` | **Live** — 197 agents, 3 chains |
| **02 Read the offer** | The seller's ENSv2 resolver is read for `turnstile:price`, `turnstile:rails`, `agent-endpoint[mcp]` | `graph/sink/ens.ts`, `web/lib/ens.ts` | **Live** — read from Sepolia per request |
| **03 Ask** | Buyer's agent calls the MCP endpoint named in `agent-endpoint[mcp]` | `mcp-turnstile/`, `seller/service/` | Tool live; **seller endpoint not deployed** (MOV-219/220) |
| **04 402** | The endpoint answers `HTTP 402 Payment Required` with a quote that must match the posted price | `seller/service/` | **Not built** (MOV-219/220) |
| **05 Pay** | The hot key settles on x402 or USDC on Arc, inside the mandate | `rails/PaymentRail.ts` | **Not built** |
| **06 Answer** | The result is returned. The method that produced it is not. | `seller/analyst/`, `seller/cre/` | **Not built** |

Steps 01 and 02 are live and demonstrable today; the market and seller pages in
`web/` run on them. Steps 03–06 are the settlement half and are not built. This
table is the honest state, not the intended one.

### Step 02 is the leg the registry cannot supply

This is the load-bearing claim of the whole project, and it is measured rather
than asserted.

EIP-8004 registration-v1 **has no price field**, and under x402 the quote is
returned dynamically in the HTTP 402 response, so there is nothing on-chain for
a registry to carry. Of the 197 live agents in the discovery store:

| Price source | Agents |
| --- | ---: |
| `turnstile` — an ENSv2 `turnstile:price` record | **1** |
| `x402` — a live 402 quote we fetched | 0 |
| `document` — a price in the registration document | 0 |
| `ask_x402` — advertises x402, price knowable but unquoted | 97 |
| `none` — no price and no way to get one | 99 |

The one readable price is ours. 97 agents advertise `x402Support`; only 13
publish an endpoint that can be asked, and **none of the 13 returned a 402**.

*(Counts verified 2026-09-07 against the live store; see the correction note in
[`discovery-api.md`](./discovery-api.md) — they drift by a few agents between
runs as unreachable document origins come back.)*

**The registry tells you who exists; Turnstile tells you what they cost.**

---

## What sits where

| Path | Role in the diagram |
|---|---|
| `graph/substreams/` | Step 01 — the ERC-8004 normalization module |
| `graph/sink/` | Step 01 — the store, plus off-module document resolution and ENS hydration |
| `seller/service/discovery.ts` | Step 01 — `find_sellers`, the ranked query |
| `mcp-turnstile/` | Step 03 — the MCP tool a buyer's agent calls |
| `contracts/` | Step 02 — the ENSv2 name, resolver and ENSIP-25/26 offer records |
| `rails/PaymentRail.ts` | Step 05 — the rail seam |
| `web/` | Steps 01–02 as a browsable surface: market and seller pages, live reads |

---

## Not verified

- **The MCP endpoint published on chain does not answer.**
  `agent-endpoint[mcp]` resolves to `https://mcp-eu.turnstile.xyz/...`, which is
  a placeholder host. The ENS record is real and readable; the service behind it
  is MOV-219/220 and is not deployed. The seller page says so on the page rather
  than only here.
- **Steps 04–06 have never been executed end to end.** There is no settlement
  receipt anywhere in the system, which is also why discovery's ranking is a
  labelled placeholder rather than settled volume.
- **The warm and hot tiers are drawn from the design, not from running code.**
  Panel A describes where each vendor sits; only the cold tier is deployed.
