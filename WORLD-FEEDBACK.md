# World developer feedback

Written continuously, not reconstructed at the end — checklist item 14. The
Selfie Check prize requires this document as a deliverable, and it is explicitly
scored on the categories below, so each one gets entries as we go.

Append-only (`merge=union`): add at the end, never rewrite an existing entry.

**Entry format**

```
### YYYY-MM-DD — one-line summary
- **Where:** the exact page, screen, endpoint or SDK call
- **Expected / Actual:**
- **Cost:** how long it took to get past, and how
- **Fix we'd suggest:**
```

---

## Docs and integration flow

How the documentation reads end to end, and how it maps onto actually wiring
Selfie Check into a running app.

## Developer Portal

### Navigation

### Search

### Product discovery

### Debugging

## Sandbox

### States

### Proof flows

### Test users

### Errors

### Edge cases

## What was confusing

## What was missing

## What was broken

## What was hard to test

## The Graph — Subgraph Studio (MOV-215, 2026-09-07)

Not World, but this file is the catch-all for "confusing, missing, broken or
hard to test", and these cost real time.

- **A Studio deploy key cannot create the subgraph it deploys to.** `graph deploy`
  builds, uploads every file to IPFS, prints a build CID, and only then fails
  with `Subgraph not found`. Everything expensive happens before the check that
  was always going to fail. `graph create --node https://api.studio.thegraph.com/deploy/`
  answers `Method not found` — Studio's JSON-RPC exposes `subgraph_deploy` and
  nothing else. Creation is a `createSubgraph` mutation on
  `api.studio.thegraph.com/graphql`, which rejects a deploy key with
  `Please login first` and wants a wallet signature instead. So a CI-shaped
  "provision and deploy from a key" flow is not possible; a human has to click
  once in the UI first. Failing fast, or documenting it on the deploy page,
  would have saved the whole IPFS upload.
- **graph-cli >= 0.90 rejects a bare `@entity`.** Every published Messari
  schema uses bare `@entity`, so the standard's own file does not compile
  against current tooling without a mechanical edit. The error is at least
  clear and suggests the fix.
- **A non-archive RPC stalls a local graph-node silently.** With
  `ethereum-rpc.publicnode.com`, indexing stopped at
  `Scanning blocks [N, N]` and emitted no error, warning or retry log for
  minutes. The cause was `eth_call` into ~300-block-old state returning
  "Archive requests require a personal token", which graph-node never surfaced.
  A single WARN naming the failing provider would have made it obvious.

---

## Hedera x402 / Blocky402 (MOV-220, 2026-09-07)

Rough edges found while landing the Hedera rail. Everything below cost real time.

**`hedera:testnet`, not `eip155:296`, and nothing warns you.** Hedera has an EVM
chain id (296) and a JSON-RPC relay, so reaching for `eip155:296` is the obvious
first move — and it is wrong for x402. The `exact` scheme on Hedera lives under
Hedera's own CAIP-2 namespace and `@x402/hedera`'s
`assertSupportedHederaNetwork()` accepts only `hedera:mainnet` and
`hedera:testnet`. The failure is a bare `network_mismatch` from the facilitator
with no hint that a *different namespace* was meant. `GET /supported` is the only
place that tells you, and neither the Hedera blog post nor Blocky402's landing
page states it in prose.

**The `exact` Hedera spec is not linked from where you need it.**
`docs.hedera.com/solutions/ai/x402` describes x402 conceptually and points at the
spec and the reference package, but neither the payload shape
(`{ transaction: <base64> }`) nor the fee-payer mechanism appears on the page. The
authoritative answer is in the published `@x402/hedera` package. Reading a dist
bundle to learn a protocol's wire format is a poor first-run experience.

**`extra.feePayer` is load-bearing and reads like metadata.** On Hedera the
transaction id's *account* is the fee payer, so the payer has to call
`setTransactionId(TransactionId.generate(feePayer))` — an account it does not
control — for the facilitator to be willing to co-sign. Omit it and the client
SDK throws; get it wrong and the facilitator answers
`invalid_exact_hedera_payload_fee_payer_mismatch`. Nothing in the field name
suggests it changes who signs.

**Two spellings of a transaction id, one of them a silent 404.** The SDK and
HashScan use `0.0.7162784@1788791855.758948636`; the mirror node REST API wants
`0.0.7162784-1788791855-758948636`. Passing the `@` form to the mirror node
returns a 404 that is indistinguishable from "no such transaction", which is a
bad way to learn that a payment you thought failed actually succeeded.

**A self-payment is rejected in a way that reads as a protocol error.** Using one
account as both payer and payout nets to zero, and the facilitator refuses it —
correctly, since `payTo` must receive a positive net transfer. But the error does
not say "these are the same account", so the first guess is that the transaction
is malformed.

**`@x402/hedera` pins `@hiero-ledger/sdk` at an exact version and does not say so
loudly.** Installing a newer `@hiero-ledger/sdk` at the top level makes npm nest
a second copy; two copies of a chain SDK break `instanceof` in ways that surface
as protocol errors rather than as dependency errors. The pin is a `"//"` comment
in the package's own `package.json`.

**Credit where due:** Blocky402's hosted testnet facilitator really does need no
signup and no API key, exactly as advertised, and `/supported` returning the fee
payer per network is the right design — it let the rail ask rather than assume,
so a rotated fee payer would surface as a seller-side 503 instead of unpayable
quotes. `/settle` waits for consensus before answering, which removes a whole
class of "did it land?" polling.
