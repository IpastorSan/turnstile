# Worked example — the transcript

`node mcp-turnstile/examples/discover-pay-reason.ts`, run on **2026-09-07**
against Hedera testnet, and captured verbatim — per `CLAUDE.md`, because
re-running an on-chain flow later for a demo is not always possible.

Both settlements below are real and checkable by anyone, with no key:

| | transaction | HashScan |
|---|---|---|
| act 1, Turnstile's Liquidity Analyst, $0.07 | `0.0.7162784@1788801237.872557846` | [hashscan](https://hashscan.io/testnet/transaction/0.0.7162784@1788801237.872557846) |
| act 2, `strangergas.example`, $0.02 | `0.0.7162784@1788801247.205890679` | [hashscan](https://hashscan.io/testnet/transaction/0.0.7162784@1788801247.205890679) |

Or straight off the mirror node, which needs nothing at all:

```bash
curl -s https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1788801237-872557846 | jq '.transactions[0] | {result, transfers}'
```

Three things in the transcript are worth reading twice.

**Step 1.1 fails, and that is the point.** The seller publishes an exact price on
an ENSv2 name and the endpoint that name points at does not resolve.
`get_offer` reports the price *and* refuses to call it purchasable. A tool that
treated a published price as a quote would have the agent paying a dead host.

**Act 2 changes nothing on the buyer's side.** `strangergas.example` sells a
different product, at a different price, on a different URL shape, from a
hand-rolled x402 handler that imports none of Turnstile's seller code. The buyer
function is the same one act 1 ran.

**The dollar figure in the quote is the seller's own.** `get_offer` says so, in
those words, and `purchase` re-prices the offer with the buyer's own HBAR rate
before the mandate is applied.

Both sellers run on `127.0.0.1` here. That is not a shortcut — it is the finding
in step 1.1: the address published on chain is not deployed. Both are paid with
real HBAR through the public Blocky402 facilitator either way, and the buyer
learns each seller's payout account from its 402 rather than from configuration.

Both are paid at `0.0.10403961` because this repository has funded one testnet
payout account. The buyer never has that address configured, so the sharing is
invisible to the code path under test — but it does mean the `byPayee` breakdown
in `receipts` cannot tell the two sellers apart.

---

```

============================================================================
SETUP
============================================================================
buyer wallet     hedera 0.0.10408012
API keys in use  none. Not for discovery, not for pricing, not for payment, not for receipts.
analyst          fixture (pass --live for the real one)
mode             live payment
turnstile seller http://127.0.0.1:34761  (the service behind liquidity.turnstile.eth)
stranger seller  http://127.0.0.1:33621  (strangergas.example — shares no seller code with it)
mcp server       find_sellers, get_offer, purchase, receipts

============================================================================
ACT 1 — a seller the buyer has never heard of
============================================================================
The buyer asks for a capability, not for a name. Everything it learns below —
the seller, its ENS name, its price, its payout account — arrives from the
directory and from the seller's own 402.

--- 1.1  discovery, then pricing at the address published ON CHAIN

[find_sellers]
  1 of 1 matching agents, from 197 in the store across 3 chains (base:119, sepolia:40, mainnet:38).
  Ranking: registration_recency — PLACEHOLDER, not a reputation signal.
  25 agents in the store have a registration document that could not be fetched (404, timeout or unreachable gateway). They are listed with documentState "failed": their capabilities are unknown, not absent.
  1 of the 1 returned carry a price that can be compared to a budget. None of these numbers is payable as it stands — a price here is either published in advance or cached from an earlier probe. Pass a seller's agentUid to get_offer to turn it into a live quote, and read that quote's `purchasable` before calling purchase.

[get_offer]
  liquidity.turnstile.eth — resolved from agent uid.
  Published price $0.07 (0.07 USD), from turnstile, under a cold-key ceiling of $0.5. A published price is what the seller intends to charge, not a quote.
  Resource: https://mcp-eu.turnstile.xyz/liquidity.turnstile.eth/sse
  Purchasable: NO — https://mcp-eu.turnstile.xyz/liquidity.turnstile.eth/sse did not return a payable 402 (POST: fetch failed). A published price is not a quote: nothing can be paid until the endpoint answers.
  ENS records read from the store; resolver verified against ENS VerifiableFactory; rails x402, usdc-arc.
  WARNING: this agent publishes an exact price on chain but the endpoint it names does not answer. The record is real; the service behind it is not reachable from here.

[the agent's conclusion]
  liquidity.turnstile.eth cannot be bought from right now: https://mcp-eu.turnstile.xyz/liquidity.turnstile.eth/sse did not return a payable 402 (POST: fetch failed). A published price is not a quote: nothing can be paid until the endpoint answers.

  ^ This is the finding, not a failure. The seller publishes an exact price on
    an ENSv2 name and the endpoint that name points at does not resolve. The
    tool reports the price AND refuses to call it buyable. An agent that treated
    a published price as a quote would now be trying to pay a dead host.

--- 1.2  the same seller, at the address it actually serves

[find_sellers]
  1 of 1 matching agents, from 197 in the store across 3 chains (base:119, sepolia:40, mainnet:38).
  Ranking: registration_recency — PLACEHOLDER, not a reputation signal.
  25 agents in the store have a registration document that could not be fetched (404, timeout or unreachable gateway). They are listed with documentState "failed": their capabilities are unknown, not absent.
  1 of the 1 returned carry a price that can be compared to a budget. None of these numbers is payable as it stands — a price here is either published in advance or cached from an earlier probe. Pass a seller's agentUid to get_offer to turn it into a live quote, and read that quote's `purchasable` before calling purchase.

[get_offer]
  liquidity.turnstile.eth — resolved from agent uid.
  Published price $0.07 (0.07 USD), from turnstile, under a cold-key ceiling of $0.5. A published price is what the seller intends to charge, not a quote.
  Live quote: 86630090 0.0.0 on hedera:testnet to 0.0.10403961 — about $0.07.
  That dollar figure is the SELLER's own arithmetic and is NOT safe to check a budget against. `purchase` re-prices the same offer with the buyer's own rate before the mandate sees it.
  Resource: http://127.0.0.1:34761/analyze/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640
  Purchasable: YES — http://127.0.0.1:34761/analyze/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640 answered 402 with a payable quote
  ENS records read from the store; resolver verified against ENS VerifiableFactory; rails x402, usdc-arc.
  Note: amount published without a currency — not comparable $0.07 is the SELLER's own conversion of 86630090 — informative, not checkable. purchase re-prices this with the buyer's own rate before the mandate sees it.

[purchase]
  PURCHASED: paid ~$0.0700 on hedera:testnet and received HTTP 200. Settlement 0.0.7162784@1788801237.872557846 — https://hashscan.io/testnet/transaction/0.0.7162784@1788801237.872557846
  Seller offered 2 way(s) to pay (read from the header): exact/hedera:testnet 86630090 0.0.0 | exact/eip155:0-PLACEHOLDER-arc 70000 PLACEHOLDER-arc-usdc
  Refused: exact/eip155:0-PLACEHOLDER-arc — no signer for exact on eip155:0-PLACEHOLDER-arc
  Settled 86630090 on hedera:testnet, transaction 0.0.7162784@1788801237.872557846
  https://hashscan.io/testnet/transaction/0.0.7162784@1788801237.872557846
  WARNING: exact on eip155:0-PLACEHOLDER-arc is advertised as a placeholder that settles nothing

[the agent's conclusion]
  verdict.rating = ACCEPTABLE
  verdict.confidence = 0.75
  verdict.summary = A fixture verdict.

[settlement] {"transaction":"0.0.7162784@1788801237.872557846","network":"hedera:testnet","payer":"0.0.10408012","amount":"86630090","success":true,"explorer":"https://hashscan.io/testnet/transaction/0.0.7162784@1788801237.872557846"}

============================================================================
ACT 2 — the same buyer, a seller with nothing in common
============================================================================
strangergas.example sells an hourly gas-fee window for $0.02, on a URL shape
Turnstile does not use, from a hand-rolled x402 handler that imports none of
Turnstile's seller code. The buyer function below is byte-identical to act 1's.

--- 2.1  quote and buy, from a URL alone

[get_offer]
  http://127.0.0.1:33621/v1/gas-window/base — resolved from url.
  Live quote: 24751454 0.0.0 on hedera:testnet to 0.0.10403961 — about $0.02.
  That dollar figure is the SELLER's own arithmetic and is NOT safe to check a budget against. `purchase` re-prices the same offer with the buyer's own rate before the mandate sees it.
  Resource: http://127.0.0.1:33621/v1/gas-window/base
  Purchasable: YES — http://127.0.0.1:33621/v1/gas-window/base answered 402 with a payable quote
  Note: amount published without a currency — not comparable $0.02 is the SELLER's own conversion of 24751454 — informative, not checkable. purchase re-prices this with the buyer's own rate before the mandate sees it.

[purchase]
  PURCHASED: paid ~$0.0200 on hedera:testnet and received HTTP 200. Settlement 0.0.7162784@1788801247.205890679 — https://hashscan.io/testnet/transaction/0.0.7162784@1788801247.205890679
  Seller offered 1 way(s) to pay (read from the header): exact/hedera:testnet 24751454 0.0.0
  Settled 24751454 on hedera:testnet, transaction 0.0.7162784@1788801247.205890679
  https://hashscan.io/testnet/transaction/0.0.7162784@1788801247.205890679

[the agent's conclusion]
  recommendation = submit below 8 gwei to land within the hour at p50
  note = A fixture payload. What is real here is the payment, not the gas data.

[settlement] {"transaction":"0.0.7162784@1788801247.205890679","network":"hedera:testnet","payer":"0.0.10408012","amount":"24751454","success":true,"explorer":"https://hashscan.io/testnet/transaction/0.0.7162784@1788801247.205890679"}

============================================================================
THE AUDIT TRAIL — read with no key, checked against the ledger
============================================================================
11 receipt(s) on topic 0.0.10408013, $0.77 settled in total, via hedera-x402×11.
Consensus window 1788791339.578776104 … 1788801245.525821104.
  0.0.10403961: 11 payment(s), $0.77
Ledger check: 11 confirmed.
Read through the public mirror node with no API key and no wallet — the same route a third party auditing these numbers would take. That is the property that makes settled volume worth ranking on.
No on-chain record binds a seller to a receipt topic: turnstile:rails names rails, not topics. The topic id has to be supplied, so a caller is trusting whoever supplied it.
The topic has NO submit key: anyone can append to it. A receipt read from it is a CLAIM, not proof. Set verify to cross-check each one against the ledger.

============================================================================
WHAT THIS PROVED
============================================================================
  discovery      1 of 1 matching agents, from 197 in the store across 3 chains (base:119, sepolia:40, mainnet:38).
  act 1 bought   yes   {"transaction":"0.0.7162784@1788801237.872557846","network":"hedera:testnet","payer":"0.0.10408012","amount":"86630090","success":true,"explorer":"https://hashscan.io/testnet/transaction/0.0.7162784@1788801237.872557846"}
  act 2 bought   yes   {"transaction":"0.0.7162784@1788801247.205890679","network":"hedera:testnet","payer":"0.0.10408012","amount":"24751454","success":true,"explorer":"https://hashscan.io/testnet/transaction/0.0.7162784@1788801247.205890679"}

  The same buyer, unchanged, bought from two unrelated services. It knew
  neither seller's name, price, payout account or response schema before it ran.
  No API key was used at any point by either the buyer or the MCP server.
```
