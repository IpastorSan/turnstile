# The payment flow — Hedera x402 via Blocky402

MOV-220. **A real paid request settled on Hedera testnet on 2026-09-07.** Every
number, address and response body below was captured from that run; the ones
that could be checked from a terminal have been, and the two that could not are
marked as such.

- **Transaction:** `0.0.7162784@1788791855.758948636`
- **HashScan:** <https://hashscan.io/testnet/transaction/0.0.7162784@1788791855.758948636>
- **Mirror node (verified):** <https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1788791855-758948636>
- **HCS receipt topic:** `0.0.10408013` — <https://hashscan.io/testnet/topic/0.0.10408013>
- 0.84367844 HBAR ($0.07) moved from `0.0.10408012` to `0.0.10403961`.
  The buyer paid **zero gas**: the 0.0024105 HBAR fee was charged to
  `0.0.7162784`, Blocky402's fee payer.

Reproduce it in one command:

```bash
node scripts/hedera-paid-request.ts --fixture
```

---

## What was verified, and what was not

Per `CLAUDE.md`: silence reads as confidence, so this is explicit.

| Claim | Status |
|---|---|
| Blocky402 needs no signup or API key on testnet | **Verified** 2026-09-07 — unauthenticated `GET /supported` and `/health` both answer |
| The facilitator settles `exact` on `hedera:testnet`, fee payer `0.0.7162784` | **Verified** — read off `/supported` |
| The payment reached consensus with `result: SUCCESS` | **Verified** — mirror node record above |
| The buyer paid no gas | **Verified** — the fee debit is on `0.0.7162784`, not on `0.0.10408012` |
| The HCS receipt is readable by a third party with no key | **Verified** — 6 messages on `0.0.10408013` via the public mirror node |
| The HashScan link renders | **Not verified.** `hashscan.io` answers 404 to curl for *every* path including its own root — it is a single-page app behind bot filtering, so a status code says nothing. The mirror node link is the one that has been checked end to end. **Open HashScan in a browser before putting it in front of a judge.** |
| Mainnet behaviour | **Not tested.** Everything here is testnet |

---

## Corrections to what this repo used to say

MOV-219 shipped the Hedera rail as a placeholder with two values marked
UNVERIFIED. One of them was not merely unverified, it was wrong.

**Correction (2026-09-07, MOV-220): the network is `hedera:testnet`, not
`eip155:296`.** Hedera testnet does have an EVM chain id of 296, and it is
irrelevant here. Blocky402's `/supported` advertises Hedera under Hedera's own
CAIP-2 namespace, and `@x402/hedera`'s `assertSupportedHederaNetwork()` accepts
only `hedera:mainnet` and `hedera:testnet`. A challenge on `eip155:296` is
rejected with `network_mismatch` before anything is signed. The instinct to
reach for the EVM chain id is exactly the trap, because Hedera *does* have a
JSON-RPC relay and an EVM chain id — they belong to a different execution path
than the one x402 uses.

**Correction (2026-09-07, MOV-220): the asset is native HBAR (`0.0.0`), not
USDC.** The placeholder advertised `USDC` and `PLACEHOLDER-hedera-testnet-usdc`.
Testnet USDC is real (`0.0.429274`, 6 decimals) and the rail can settle it —
pass `asset`/`decimals`/`usdPerUnit` to `createHederaRail`. We do not, because an
HTS transfer needs **both** sides associated with the token and the payer
holding a balance of it: two more transactions, a faucet we do not control, and
two more ways for the one payment that has to work on camera to fail with
`TOKEN_NOT_ASSOCIATED_TO_ACCOUNT`. Native HBAR needs none of it.

The consequence is that this rail is priced in a volatile asset, which is why
`PaymentRail.challenge()` is async — see **Pricing** below.

---

## Setup

### Accounts

| | Account | Holds | Set by |
|---|---|---|---|
| Seller payout | `0.0.10403961` | the operator identity; also writes the HCS receipts | `HEDERA_PAYOUT_ACCOUNT` |
| Buyer agent | `0.0.10408012` | 50 HBAR, the hot tier's whole balance | `HEDERA_BUYER_ID` / `HEDERA_BUYER_KEY` |
| Fee payer | `0.0.7162784` | Blocky402's. Not ours, and we hold no key for it | read off `/supported` |

The buyer needs its own account: the seller's payout is the operator, and a
transfer from that account to itself nets to zero, which Blocky402 rejects —
`payTo` must receive a positive net transfer. It is also the honest shape, since
the hot tier is supposed to hold a small balance and nothing else.

```bash
node scripts/hedera-setup.ts     # once. Prints the .env lines; does not edit .env
```

That creates the buyer account and the receipt topic. The topic has **no submit
key**, on purpose: the receipt trail is meant to be verifiable by a third party,
and a topic anyone can read is worth more here than one only we can write.
`HcsReceiptTopic.read()` filters on a `kind: "turnstile.settlement"` marker so a
stranger's message cannot corrupt the trail.

### Environment

```bash
export HEDERA_OPERATOR_ID="0.0.10403961"
export HEDERA_OPERATOR_KEY="<raw 64-hex ECDSA — not the DER form>"
export HEDERA_PAYOUT_ACCOUNT="0.0.10403961"
export HEDERA_BUYER_ID="0.0.10408012"
export HEDERA_BUYER_KEY="<raw 64-hex ECDSA>"
export HEDERA_RECEIPT_TOPIC_ID="0.0.10408013"
export BLOCKY402_URL="https://api.testnet.blocky402.com"
# Optional: pins the HBAR/USD rate instead of reading it live.
# export HEDERA_HBAR_USD="0.08297"
```

### The facilitator

```console
$ curl -s https://api.testnet.blocky402.com/supported
{"kinds":[{"x402Version":2,"scheme":"exact","network":"eip155:80002"},
          {"x402Version":2,"scheme":"exact","network":"solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
           "extra":{"feePayer":"7B6Q2MvcJvNcy1A13wHmAzmmdo3L8DVriaXML7bvkojm"}},
          {"x402Version":2,"scheme":"exact","network":"hedera:testnet",
           "extra":{"feePayer":"0.0.7162784"}}],
 "extensions":[],
 "signers":{"eip155:*":["0xDCF7D72C2eE049DE4269ac6AAf925F33efdA18de"],
            "solana:*":["7B6Q2MvcJvNcy1A13wHmAzmmdo3L8DVriaXML7bvkojm"],
            "hedera:*":["0.0.7162784"]}}
```

No `Authorization` header, no signup, no key. Blocky402 is MIT-licensed and
open source (BlockyDevs); this is its hosted testnet deployment.

---

## Architecture

```
  buyer/watchdog/pay.ts                    seller/service/x402.ts
  ├─ enforceMandate()  which offer, and    ├─ challengeAll()  -> 402
  │  whether to pay at all                 ├─ matchesOffer()  amount >= quoted
  └─ @x402/fetch                           └─ routeOrThrow()  -> the rail
        │                                          │
  buyer/watchdog/hedera-signer.ts           rails/hedera-x402/
  └─ @x402/hedera createClientHederaSigner  ├─ challenge()  /supported + FX
        │                                   ├─ verify()     /verify
        │                                   ├─ settle()     /settle + HCS
        └───────── PAYMENT-SIGNATURE ─────► └─ receipt()    book | mirror node
                                                   │
                                            Blocky402 facilitator
                                            └─ co-signs, submits, waits
                                                   │
                                            Hedera testnet
```

Two properties are worth stating because they are the whole design:

**Nothing in `seller/service/` knows what a chain is.** The rail's entire
Hedera-ness travels in two opaque bags — `PaymentRequirement.extra` on the way
out, `PaymentPayload.payload` on the way back — and the service copies both
without reading either. Landing this rail changed **no file under
`seller/service/`**. `seller/service/no-chain-code.test.ts` enforces it
mechanically.

**The key that spends cannot raise its own limit.** The buyer's mandate is an
argument to `createPaidFetch`, and the dollar cap is computed with a rate the
*buyer* reads from Hedera's network exchange rate — not with the seller's
`extra.usdPerUnit`. A seller that quoted 12 HBAR for "seven cents" and declared a
matching rate would otherwise pass a cap computed from its own arithmetic.

---

## The flow, step by step

### 1. The 402

```json
{
  "scheme": "exact",
  "network": "hedera:testnet",
  "asset": "0.0.0",
  "amount": "84367844",
  "payTo": "0.0.10403961",
  "maxTimeoutSeconds": 300,
  "extra": {
    "feePayer": "0.0.7162784",
    "facilitator": "https://api.testnet.blocky402.com",
    "settlementModel": "facilitator-cosigned-transaction",
    "mirrorNode": "https://testnet.mirrornode.hedera.com",
    "decimals": 8,
    "symbol": "HBAR",
    "priceUsd": 0.07,
    "usdPerUnit": 0.08297,
    "rateSource": "hedera mirror node /api/v1/network/exchangerate (248910 cents per 30000 HBAR)",
    "resource": "http://127.0.0.1:33871/analyze/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
    "turnstileSettlement": "live"
  }
}
```

`extra.feePayer` is the only key the protocol requires, and it is not optional
garnish: `@x402/hedera`'s client signer throws without it, and the facilitator
rejects a transaction whose id names any other account.

`amount` is `"84367844"` tinybars — 8 decimals, not USDC's 6. Quoting 6 here
would underpay by a factor of 100.

The Arc entry sits alongside it in `accepts[]`, still `turnstileSettlement:
"stub"`. The 402 is honestly two-rail: one live, one placeholder, each saying
which it is.

### 2. The payer builds a partially-signed transaction

This is the step with no EVM analogue. x402's `exact` scheme on an EVM chain is
an EIP-3009 authorization: the payer signs a message and someone else turns it
into a transfer. Hedera has no EIP-3009, so the scheme does the same job
differently:

1. build a `TransferTransaction` debiting the buyer, crediting `payTo`;
2. **set the transaction id to one generated for `extra.feePayer`** — on Hedera
   the transaction id's account *is* the fee payer, so this is what makes
   Blocky402 pay the gas;
3. freeze, sign with the buyer's key only, serialize to base64.

The result is deliberately unsubmittable — valid in shape, missing the fee
payer's signature. The buyer cannot broadcast it and the seller cannot alter it.
That is the security property the whole scheme rests on.

We do not implement this ourselves. `buyer/watchdog/hedera-signer.ts` calls
`@x402/hedera`'s `createClientHederaSigner`, the x402 Foundation's reference
implementation, because the facilitator validates transaction shape strictly and
re-deriving it from our reading of the spec would be rewriting something its
authors already wrote.

The payload on the wire is one field:

```json
{ "transaction": "<base64 of the frozen, part-signed TransferTransaction>" }
```

### 3. Verify, work, settle

`seller/service/x402.ts` orders it **verify → do the work → settle**, so a payer
whose payment is bad is refused before any work happens, and value moves only
once there is an answer to hand over.

Three layers of checking, none of which subsumes the others:

| Check | Where | Catches |
|---|---|---|
| `amount >= quoted`, asset and payout match a freshly issued offer | `seller/service/x402.ts` | buying the $0.35 tier with a $0.07 payment |
| payout account, replay, resource binding | `rails/hedera-x402` `verify()` | a payment reused for a second answer |
| signature, transfer semantics, payer balance, fee-payer identity | Blocky402 `/verify` | anything about the transaction itself |

**On the resource binding, honestly.** `extra.resource` names the URL the
challenge was issued for, and `verify()` compares it. On this rail that check is
**advisory, not load-bearing**, and `rails/README.md` used to claim otherwise —
see the correction in it. A Hedera transaction commits to `payTo`, `amount`,
`asset` and `feePayer`; it does not commit to a URL. Blocky402's parity check
compares only those fields plus `maxTimeoutSeconds` between `payload.accepted`
and the requirements posted to it, so a payer is free to edit `extra.resource` in
their own copy. What actually stops a payment buying the wrong resource is the
pair of checks that do not depend on the payer's honesty: the service's amount
comparison, and the replay guard.

**The replay guard.** `verify()` refuses a signed transaction this seller has
already settled. Hedera would eventually reject a duplicate transaction id
itself — but only *after* we had done the work and handed over the answer, which
is precisely the outcome worth preventing. It has to live on the seller: a
correct client mints a fresh transaction per call and cannot demonstrate the
failure.

```
first send  -> HTTP 200  0.0.7162784@1788791871.396045089
second send -> HTTP 402
               payment rejected by hedera-x402: already_settled —
               this transaction has already been settled by this seller
```

### 4. The 200

```json
PAYMENT-RESPONSE (decoded):
{
  "success": true,
  "transaction": "0.0.7162784@1788791855.758948636",
  "network": "hedera:testnet",
  "payer": "0.0.10408012",
  "amount": "84367844"
}
```

Confirmed on chain:

```console
$ curl -s https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1788791855-758948636
{"transactions":[{
  "name":"CRYPTOTRANSFER",
  "result":"SUCCESS",
  "consensus_timestamp":"1788791864.361892104",
  "charged_tx_fee":241050,
  "transfers":[
    {"account":"0.0.802","amount":241050},          <- node/network fee
    {"account":"0.0.7162784","amount":-241050},     <- the FACILITATOR paid it
    {"account":"0.0.10403961","amount":84367844},   <- seller credited
    {"account":"0.0.10408012","amount":-84367844}   <- buyer debited, and nothing else
  ]}]}
```

The buyer's account moves by exactly the price. Not one tinybar of gas.

> **Gotcha.** Hedera writes a transaction id two ways and they are not
> interchangeable. The SDK and HashScan use `0.0.7162784@1788791855.758948636`;
> the mirror node REST API wants `0.0.7162784-1788791855-758948636` in a path
> segment. Getting it wrong produces a 404 that is indistinguishable from "the
> transaction does not exist". `toMirrorNodeTransactionId()` converts.

### 5. The HCS receipt

Every settled payment writes one message to topic `0.0.10408013`:

```json
{
  "v": 1,
  "kind": "turnstile.settlement",
  "railId": "hedera-x402",
  "network": "hedera:testnet",
  "transaction": "0.0.7162784@1788791855.758948636",
  "payer": "0.0.10408012",
  "payTo": "0.0.10403961",
  "amount": "84367844",
  "asset": "0.0.0",
  "priceUsd": 0.07,
  "resource": "http://127.0.0.1:33871/analyze/0x88e6...5640",
  "settledAt": 1788791866251
}
```

Read it back with no key at all:

```bash
curl -s 'https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10408013/messages?limit=100&order=asc'
```

**Why a topic and not a database row.** Settled volume is the one number an agent
cannot fake, which is why `seller/service/discovery.ts` wants to rank on it — and
a ranking is worth exactly as much as the evidence under it. A seller keeping its
own receipts in its own SQLite can write whatever it likes there. An HCS message
is ordered, timestamped and signed by the network, and readable by anyone. So the
receipt goes on chain and the database becomes a cache of something checkable.

The message names what was **bought**, never what was **sold**. The topic is
public; writing the analyst's verdict into it would give away, permanently and to
everyone, the thing the buyer just paid for.

A failed HCS write does **not** fail the payment. `settle()` records the outcome
in `Receipt.extra.hcs` either way, so a missing receipt is visible rather than
silent — refusing to deliver an answer over a bookkeeping failure would punish
the buyer for our problem.

### 6. Into the ranking

```bash
node graph/sink/ingest-receipts.ts --ens liquidity.turnstile.eth
```

Reads the topic off the public mirror node and fills `settlement_receipt`. That
is the seam MOV-222 left open: with the table empty, discovery ranks by
registration recency and **labels itself a placeholder**; with one row, it ranks
by settled volume and stops apologising.

It reads the mirror node rather than our own `settle()` returns on purpose — the
seller already knows what it took, and a seller's claim about its own revenue,
kept in the seller's own database, is worth strictly less than the same number
recomputed by the route a third party would use.

---

## Pricing

The rail settles in HBAR and the seller prices in dollars, so something converts.
The rate comes from **Hedera's own network exchange rate** — the number the
network uses to price its fees — served by the public mirror node:

```console
$ curl -s https://testnet.mirrornode.hedera.com/api/v1/network/exchangerate
{"current_rate":{"cent_equivalent":248910,"hbar_equivalent":30000,...}}
#  248910 / 30000 / 100 = $0.08297 per HBAR
#  $0.07 / 0.08297 * 1e8 = 84367844 tinybars
```

Two reasons over a price API: no key, and a payer can check our arithmetic
against a source neither side controls. It is quantized and hourly, so it is not
a market price — fine on testnet, and something to revisit before mainnet.

`usdToAtomic()` scales through an integer, because `0.07 * 1e6` in IEEE 754 is
`69999.99999999999` and a payment one unit light gets rejected by a facilitator,
on a rail nobody is watching, during a demo.

The rate is cached (10 minutes). That is not only politeness to the mirror node:
the service re-issues the challenge on the paid request and compares the payer's
amount against it, so a rate that moved between the two would quote a different
number of tinybars for the same seven cents. The service's comparison is
`paid >= quoted`, which absorbs a move in one direction; the cache absorbs both.
`HEDERA_HBAR_USD` pins it outright, and whichever source was used is reported in
`extra.rateSource` rather than left to be assumed.

---

## Failure modes and what they mean

`verify()` returns a reason code rather than a boolean, because the buyer's next
move differs. The mapping from `@x402/hedera`'s codes is in
`rails/hedera-x402/facilitator.ts` and pinned by a test.

| Reason | What happened | Buyer should |
|---|---|---|
| `insufficient_funds` | preflight found the payer short | stop |
| `invalid_signature` | the payer did not sign, or signed with the wrong key | stop |
| `wrong_amount` | the transfer does not move exactly `amount`, or parity failed | re-fetch the challenge |
| `wrong_recipient` | `payTo` is not this seller, or the binding failed | re-fetch |
| `unsupported_rail` | network, scheme or fee payer not settled here | try the other `accepts[]` entry |
| `already_settled` | this transaction already bought an answer | mint a fresh payment |
| `expired` | the transaction's validity window closed | re-fetch and re-sign |
| `facilitator_unavailable` | **thrown**, not returned — the service answers 503 | retry later |

That last row is the distinction worth keeping: a rejected payment is a 402 and
tells the buyer to do something different; a facilitator we could not reach is a
503 and is our problem, not theirs.

An unknown code from a future facilitator release maps to `unknown` rather than
being forced into a neighbouring bucket, because a buyer that retries on a
misclassified code wastes a payment.

---

## Dependency gotcha

`@x402/hedera` pins `@hiero-ledger/sdk` **2.85.0** exactly and its own
`package.json` notes that `@hiero-ledger/proto` must stay in lockstep with it.
Installing a newer `@hiero-ledger/sdk` at the top level makes npm nest a second
copy under `@x402/hedera`, and two copies of a chain SDK is how `instanceof`
checks start failing in ways that read as protocol errors. `package.json` pins
`2.85.0` with `--save-exact` so the two dedupe. If you bump it, check
`ls node_modules/@x402/hedera/node_modules/@hiero-ledger/` still shows only
`proto`.

---

## Files

| | |
|---|---|
| `rails/hedera-x402/index.ts` | the rail — the four `PaymentRail` methods |
| `rails/hedera-x402/config.ts` | verified constants, and the corrections above |
| `rails/hedera-x402/facilitator.ts` | the Blocky402 client and the reason-code table |
| `rails/hedera-x402/rate.ts` | HBAR/USD from the network exchange rate |
| `rails/hedera-x402/hcs.ts` | receipt topic: write with a key, read without one |
| `rails/hedera-x402/testing.ts` | fixtures copied from real responses |
| `buyer/watchdog/hedera-signer.ts` | the buyer's `RailSigner`, over `@x402/hedera` |
| `graph/sink/ingest-receipts.ts` | topic → `settlement_receipt` → ranking |
| `scripts/hedera-setup.ts` | one-time: buyer account + receipt topic |
| `scripts/hedera-paid-request.ts` | the end-to-end run that produced this document |
