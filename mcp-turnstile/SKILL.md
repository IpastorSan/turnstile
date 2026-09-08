---
name: turnstile
description: Find, price, pay and audit AI agents that sell services — over ERC-8004 registries, ENSv2 offer records and x402 payments. Use when an agent needs to buy something from another agent it has never met: discovering sellers by capability across chains, turning an identifier into a live quote, paying a 402 inside a spending mandate, or reading a seller's settlement history off a public consensus topic. Triggers: "find an agent that can…", "what does this agent charge", "buy this from an agent", "pay the 402", "x402", "ERC-8004", "agent discovery", "agent payments", "settlement receipts".
---

# Turnstile

Four MCP tools that let one agent transact with another it has never met.

This is infrastructure, not an application. Nothing in it knows what is being
sold. It will find, price, pay and audit **any** x402 seller, and the worked
example proves that by buying from two unrelated ones with the same code.

Verified end to end on 2026-09-07 against Hedera testnet. Real payments, real
transaction ids, real receipts.

---

## Install and run

Needs **Node 22.18 or newer** and nothing else. No database server, no compiler,
no native module, no API key.

```bash
npx -y mcp-turnstile
```

Register it with a client:

```bash
# Claude Code
claude mcp add turnstile -- npx -y mcp-turnstile
```

```jsonc
// Claude Desktop / any MCP client, in its config
{
  "mcpServers": {
    "turnstile": {
      "command": "npx",
      "args": ["-y", "mcp-turnstile"],
      "env": {
        // Optional. Only `purchase` needs these; everything else is keyless.
        "HEDERA_BUYER_ID": "0.0.xxxxxxx",
        "HEDERA_BUYER_KEY": "<64-hex ECDSA, raw not DER>"
      }
    }
  }
}
```

From a clone of the repository instead:

```bash
git clone https://github.com/IpastorSan/turnstile && cd turnstile
npm install
node mcp-turnstile/server.ts            # the same server, running the sources
```

**It works with an empty environment.** The package ships a 197-agent snapshot
of the ERC-8004 directory (`web/data/discovery.db`, with `provenance.json` beside
it recording the chains and block ranges it was built from), so `find_sellers`
and `get_offer` answer real queries on a machine that has never run an indexer.
Point `--db` or `TURNSTILE_DB` at your own store to use a fresh one.

---

## Run the worked example

One command, one transcript: an agent discovers a seller it has never seen, pays
it, reasons over the answer, and audits the payment.

```bash
git clone https://github.com/IpastorSan/turnstile && cd turnstile && npm install

# Without a wallet — discovery, live quoting and the mandate, all keyless.
node mcp-turnstile/examples/discover-pay-reason.ts --dry-run

# With one — real HBAR moves, and you get a HashScan link.
cp .env.example .env      # fill in HEDERA_BUYER_ID / HEDERA_BUYER_KEY
set -a; source .env; set +a
node mcp-turnstile/examples/discover-pay-reason.ts
```

A funded Hedera testnet account takes about two minutes from
[portal.hedera.com](https://portal.hedera.com); `node scripts/hedera-setup.ts`
creates the buyer account and the receipt topic from it. The facilitator
(Blocky402 testnet) needs no signup and no key.

The transcript of a real run, with transaction ids you can check on HashScan
yourself, is in [`examples/transcript.md`](examples/transcript.md).

---

## The four tools

### `find_sellers` — who exists, and what we do and do not know about them

Searches an ERC-8004 directory indexed from registry events across every chain
that hosts one, by capability, chain, price ceiling and x402 support.

```jsonc
{ "capability": ["liquidity", "analytics"], "chains": ["base", "sepolia"], "limit": 10 }
```

Every result carries a `priceSource` — `turnstile | x402 | document | ask_x402 |
none` — because the registry itself has no price field and never will. **The one
to read carefully is `ask_x402`:** it means the agent takes payment and has not
been quoted yet. It never means free.

Agents whose registration document could not be fetched come back marked
`documentState: "failed"` rather than being dropped, so a caller sees the shape
of what discovery could not reach rather than a quietly shorter list.

### `get_offer` — turn an identifier into a quote

Takes an ENS name, an `agentUid` from `find_sellers`, or a bare URL.

```jsonc
{ "agent": "eip155:11155111:0x8004…/10127" }
{ "agent": "https://some-agent.example/v1/quote" }
```

Returns `offer` (what you would pay now) and `published` (what the agent said in
advance) as **separate objects**, because they are separate claims and a live
quote must not overwrite a published price.

**Read `purchasable` before paying.** It is true only when the endpoint answered
402 with a payable quote. See "What a judge should try to break", below: our own
seller publishes an exact price on chain at an endpoint that does not resolve,
and this tool reports the price and refuses to call it buyable.

`offer.basis` says how a dollar figure was arrived at, and `offer.comparable` is
false when it came from the seller's own arithmetic. That distinction is not
pedantry — see the mandate section.

### `purchase` — pay a 402, inside a mandate

```jsonc
{ "resource": "https://seller.example/analyze/0x88e6…", "maxPriceUsd": 0.10 }
{ "resource": "…", "maxPriceUsd": 0.10, "dryRun": true }
```

`maxPriceUsd` is **required**. There is no default cap, because a default cap is
a number nobody chose being applied to somebody's wallet.

The status is the thing to branch on, and the five failure modes are genuinely
different:

| status | what happened |
|---|---|
| `purchased` | paid, settled, goods delivered. `settlement` carries the transaction id and an explorer link |
| `would_purchase` | `dryRun`: the mandate allows it, nothing was signed |
| `free` | the endpoint served without asking for money. Common in this directory, and not an error |
| `unpayable` | no x402 challenge came back, or the URL was refused |
| `refused` | the mandate authorizes none of the offers — with a reason for **each** one |
| `no_signer` | a real quote came back and no wallet is configured. The quote is still reported |
| `settlement_failed` | nothing charged, nothing delivered. Safe to retry |

### `receipts` — what a seller has actually been paid

```jsonc
{ "topic": "0.0.10408013", "verify": true }
```

Reads settlement receipts off a Hedera Consensus Service topic through the public
mirror node — **no API key, no wallet, no account**. That is the whole point: the
number you compute here is the number any third party computes, by the same
route, which is what makes settled volume worth ranking on at all.

`verify: true` cross-checks every receipt against the ledger: does the
transaction exist, did it succeed, and did it credit the claimed payee with the
claimed amount? Set it. See the honesty section for why.

---

## No API key anywhere in the flow

The claim is precise, so here is the whole ledger of credentials.

| step | credential |
|---|---|
| discovery across three chains | none — a local SQLite snapshot |
| reading a seller's ENSv2 offer records | none — a public RPC endpoint |
| getting a live price | none — an unauthenticated HTTP request that returns 402 |
| paying | the buyer's **own wallet key** |
| the facilitator that co-signs and submits | none — Blocky402 testnet has no signup |
| reading the settlement receipts back | none — the public Hedera mirror node |

A wallet key is not an API key, and the difference is the design. An API key is a
relationship with a provider: you sign up, you are billed, you are identified,
and the key can do everything your account can. The key here is the **hot tier**
of a three-tier hierarchy (`CLAUDE.md`): it signs one transfer, for one amount,
to one account named in the seller's 402, and it authorizes nothing else. It
cannot raise its own limit, rotate anything, or move a payout address.

The buyer holds no account with either seller in the worked example, and never
identifies itself to them.

On the other side, the seller's upstream credentials never appear in the flow
either — that is what it is selling. It sells the answer and keeps the method.

---

## The mandate, and why a seller's own price is not enough

An x402 challenge quotes an integer in the asset's smallest unit — `84770051`
tinybars — and helpfully includes the seller's own `priceUsd` and `usdPerUnit`
beside it. Checking a budget against that number would let a seller quoting 12
HBAR for "seven cents", with a rate that makes 12 HBAR look like seven cents,
pass a cap computed from its own arithmetic. **A cap a counterparty can move is
not a cap.**

So `get_offer` reports the seller's figure with `basis: "seller_declared"` and
`comparable: false`, and `purchase` re-prices the same offer using the buyer's
own rate — read from the network, not from the seller — before the mandate sees
it. Where the asset is a recognised dollar stablecoin the unit is checkable on
its own and `basis` is `stablecoin_unit`.

A refusal is never a bare `false`. Every rejected offer comes back with the
reason it was rejected, because "over the cap", "rail not in the mandate" and "no
signer for that network" tell a calling agent to do three different things.

---

## What this does not know, and will tell you it does not know

Read this section before demoing anything. Every claim in it is checkable.

**Almost nothing in the directory has a price.** Of the 197 agents in the shipped
store, exactly **one** has a readable price, and it is ours. 97 advertise
`x402Support` — the registry signal that means "ask the endpoint" — and 14 of
those publish an HTTP endpoint to ask. Probed on 2026-09-07, **not one of the 14
returned a 402**: twelve HTTP errors, one 200, one DNS failure. Six of the
fourteen are the URL `https://github.com/agntcy/oasf/`, which is a link to a
specification rather than a service.

Reproduce it in about a minute:

```bash
cp web/data/discovery.db /tmp/probe.db
node graph/sink/probe-x402.ts --db /tmp/probe.db --limit 20
```

That is not a bug in this server; it is the current state of the ERC-8004
directory, and it is why `priceSource: "ask_x402"` exists as a distinct value
rather than being folded into "free" or "unknown". It is also why `get_offer`
insists on a live 402 before it will call anything purchasable — in a directory
this sparse, a tool that inferred a price would be wrong almost every time.

**The ranking is a placeholder and says so.** `find_sellers` orders by
registration recency and sets `ranking.placeholder: true` with a note explaining
why. Settled volume is the ranking signal worth having — it is the one number an
agent cannot fake — and it comes from the HCS receipts the `receipts` tool reads.
Those receipts exist. What has not been run is the ingest into the discovery
store: `npm run ingest-receipts` fills `settlement_receipt`, after which
`find_sellers` switches to `basis: "settled_volume"` and `placeholder: false` on
its own. Until someone runs it, this server says placeholder rather than
pretending.

**Price is not on chain.** `turnstile:price` is an ENSv2 **text record** on a
name whose resolver has been verified against ENS's own `VerifiableFactory`. That
is a strong, publicly readable, cold-key-bounded claim. It is not a value the
chain enforces, and nothing here says it is.

**A receipt topic with no submit key can be written to by anyone.** Topic
`0.0.10408013` has `submit_key: null` — verified against the mirror node on
2026-09-07 — so a message on it is a **claim**, not proof. `verify: true` turns
it into evidence by checking each receipt against the ledger, and `submitKey:
null` appears in every result so a caller cannot miss it.

**Nothing on chain binds a seller to a receipt topic.** `turnstile:rails` names
rails, not topics, and there is no ENSIP record for one. The topic id has to be
supplied, and a caller that has one is trusting whoever supplied it. This is a
real hole in the design and it is reported in every `receipts` result rather than
papered over.

**The endpoint published on chain is not deployed.** `liquidity.turnstile.eth`
publishes `agent-endpoint[mcp]` pointing at `https://mcp-eu.turnstile.xyz/…`,
which does not resolve. The seller's service is real and runs from this
repository; the hosted address is not up. The worked example shows the tool
catching exactly this before it shows anything working.

---

## What a judge should try to break

**1. Ask for a price at the address published on chain.**

```jsonc
{ "agent": "liquidity.turnstile.eth" }
```

You get the $0.07 price, the $0.50 cold-key ceiling, `resolverVerified: true` —
and `purchasable: false`, because the endpoint that name points at does not
answer. A tool that reported that as buyable would have an agent trying to pay a
dead host. This is the single most important behaviour in the server.

**2. Point it at a seller nobody here has ever heard of.**

```jsonc
{ "agent": "https://anything.example/some/paid/endpoint" }
```

The directory is not consulted. If it 402s, you get its price, its asset, its
payout account and `purchasable: true`, and `purchase` will pay it. Grep the
source for a hardcoded seller and you will not find one.

**3. Set a cap below the price.** `purchase` refuses before a signature exists
and shows the arithmetic.

**4. Ask for something nobody sells.** `find_sellers` returns nothing and says
how many agents it looked at, on which chains, and how many it could not fetch
documents for.

**5. Point `purchase({ agent })` at an agent whose registration names
`http://169.254.169.254/`.** Refused: a URL that came from a stranger's on-chain
document may not name a private address. One you pass as `resource` yourself may,
which is how a seller on `localhost` gets bought from during a demo. The
distinction is provenance, not the address.

---

## How it works

```
   ERC-8004 Identity Registries              ENSv2 offer records
   (mainnet, Base, Sepolia)                  turnstile:price, price-ceiling,
        │  registry events                   rails, agent-endpoint[mcp]
        │  via Substreams                              │
        ▼                                              ▼
   ┌────────────────────────────────────────────────────────┐
   │  discovery store (SQLite, ships with the package)      │
   └────────────────────────────────────────────────────────┘
        │                          │
   find_sellers ───────────► get_offer ──── live HTTP 402 ────► the seller
                                   │        (the only price
                                   ▼         that exists for
                              purchase ──── an agent that is
                                   │         not a Turnstile one)
                                   ▼
                          x402 payment, inside a mandate
                                   │
                                   ▼
                          settlement on chain
                                   │
                                   ▼
                       HCS receipt topic ──────► receipts (no key)
```

Discovery is a three-way join because no single source can answer the whole
question. The registry says **who exists** and has no price field. ENSv2 records
say what a Turnstile seller **costs**, in advance. A live 402 says what anyone
else costs, at the moment you ask — under x402 that is the only place the quote
exists. Every result says which of the three it came from, or that there is none.

**Source:** [`mcp-turnstile/`](https://github.com/IpastorSan/turnstile/tree/main/mcp-turnstile).
`store.ts` finds the directory, `offer.ts` resolves identifiers, `purchase.ts`
pays, `receipts.ts` audits, `tools/` are the MCP wrappers, `examples/` is the
worked example. MIT.
