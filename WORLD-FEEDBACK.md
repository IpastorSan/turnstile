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
## Chainlink CRE — Confidential Workflows (MOV-227, 2026-09-07)

Built against `cre` CLI v1.32.0 and `@chainlink/cre-sdk@1.18.0`, from the
`hello-confidential-workflows-ts` template. The good news first: **the template
is excellent and the whole confidential path works in the simulator without any
private-beta enrollment.** `cre init` → `bun install` → `cre workflow simulate`
ran green on the first try, and the template's inline comments answered more
questions than the docs did — the `ConfidentialHTTPClient` warning in particular
saved a real dead end.

What cost time:

- **`CRE_API_KEY` silently breaks a working login.** The CLI prefers
  `CRE_API_KEY` over the credentials in `~/.cre/cre.yaml`, so an unrelated key
  sitting in `.env` — ours was a Data Streams key — makes *every* command fail
  `unauthorized: invalid token`, including `simulate`, which needs no account
  privileges at all. The error names neither the variable it used nor where it
  came from. `cre login --help` documents the precedence; nothing at the point
  of failure does. "Using CRE_API_KEY from /path/.env" in the error would have
  turned an hour into a minute.
- **The project `.env` also beats the shell environment**, which is the opposite
  of the usual precedence. `FOO=x cre workflow simulate …` does not override
  `FOO` in `.env`. This made a negative test pass for the wrong reason: we set a
  deliberately wrong secret, and the run succeeded with the right one.
- **`cre init --non-interactive` still demands a TTY** unless
  `--deployment-registry` and `--rpc-url` are also passed. It fails with
  "Interactive mode requires a terminal (TTY). Use --non-interactive with all
  required flags" — while `--non-interactive` is already set. Naming the two
  missing flags would be strictly better than naming the flag that is present.
- **Nothing documents whether the enclave's HTTP capability can reach
  localhost.** It can, in simulation, and that turned out to matter a lot: it
  let the seller's own evidence server be the real counterparty in the demo
  rather than a public paste. Worth a line in the Confidential Workflows page,
  because the alternative we nearly built — publishing the "confidential"
  evidence to a gist — would have been a much weaker demonstration.
- **`cre account access` cannot request access non-interactively.** It correctly
  reports "Deployment access is not yet enabled for your organization" and then
  fails with `could not open a new TTY`. A `--request` flag would let an agent
  or a CI job at least get into the queue.
- **The simulator returns a zero tx hash for `writeReport`** while
  `TxStatus.SUCCESS` comes back. That is a reasonable thing to do, and it is not
  said anywhere in the output — a line like "chain write simulated, not
  broadcast" next to the result would stop people hunting for the transaction.
- **A `writeReport` from a TEE handler requires crossing `usingTheDons()`
  first**, which the docs state, but no example shows a confidential workflow
  actually settling on chain. The keeper-bot template shows the write and the
  confidential template shows the enclave, and stitching them was guesswork that
  happened to be right. One example doing both would be the single most useful
  addition.
