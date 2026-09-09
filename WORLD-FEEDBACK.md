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

### 2026-09-09 — the integration path is right, but it is assembled from four pages that do not link to each other
- **Where:** `world-id/idkit/integrate`, `world-id/idkit/credentials`, `world-id/id/testing`, `api-reference/create-incognito-action`
- **Expected / Actual:** expected one page taking me from credentials to a verified proof. Actually the four facts I needed were on four pages: `signRequest` lives on *integrate*, `selfieCheckLegacy()` on *credentials*, the verify URL on *testing*, and the action on an *api-reference* page I only found by search. None links to the next.
- **Cost:** about forty minutes of reading, most of it spent not knowing whether I had all the pieces. The failure mode is not being stuck, it is *believing you are done* and finding out at the widget.
- **Fix we'd suggest:** one "Selfie Check, end to end" page: create the app, register the RP, create the action, sign a context, mount the widget, verify. Even as a list of links in order.

### 2026-09-09 — the docs never say an action has to exist, or where to make one
- **Where:** `world-id/id/getting-started`
- **Expected / Actual:** it says *"Keep these values: `app_id`, `rp_id`, `signing_key`"* and then shows `action: "my-action"` in every snippet. Nothing says that string names a resource you must create first, or where. I only found `POST /api/v2/create-action/{app_id}` through a search engine.
- **Cost:** would have been an opaque failure at the first real proof, after the code was already written and looked correct.
- **Fix we'd suggest:** in getting-started, one line: "`action` must be created in the Developer Portal under Incognito Actions before a proof will verify."

### 2026-09-09 — two API hosts and two API versions, in the same integration
- **Where:** verify is `https://developer.world.org/api/v4/verify/{rp_id}`; creating an action is `https://developer.worldcoin.org/api/v2/create-action/{app_id}`
- **Expected / Actual:** expected one host. Got `world.org` v4 for the runtime call and `worldcoin.org` v2 for the admin call, addressed by two different identifiers (`rp_id` in the path for one, `app_id` for the other).
- **Cost:** low, but it reads as an unfinished migration and made me double-check I had not pasted a stale URL from an old tutorial.
- **Fix we'd suggest:** if `worldcoin.org` is legacy, say so on the page that still documents it.

How the documentation reads end to end, and how it maps onto actually wiring
Selfie Check into a running app.

## Developer Portal

### Navigation

### Search

### Product discovery

### Debugging

### 2026-09-09 — the 401 on create-action is exactly what an error should be
- **Where:** `POST /api/v2/create-action/{app_id}` with no credentials
- **Expected / Actual:** `{"code":"unauthorized","detail":"API key is required.","attribute":"api_key"}`. It names the thing that is missing and the field it goes in.
- **Cost:** none. I probed the endpoint deliberately to learn its auth requirement and the response taught me in one call.
- **Fix we'd suggest:** nothing. This is the standard the rest of the surface should be held to, and it is worth saying so rather than only reporting faults.

## Sandbox

### 2026-09-09 — Selfie Check needs two separate approvals and they are documented apart
- **Where:** `world-id/sandbox/testing-selfie-check` versus the Sandbox access form
- **Expected / Actual:** expected "get Sandbox access" to be the gate. Actually there are two: Sandbox environment access, *and* a Selfie Check (Beta) feature flag on the specific app, requested through a World point of contact. The second is one sentence on the testing page, and I found it only after already having the first.
- **Cost:** two days of believing the track was one approval away when it was two. The plan carried a wrong assumption for that whole period.
- **Fix we'd suggest:** put both gates in one checklist on the Sandbox landing page, with how to request each. A developer needs to know the full set on day one, because these have human latency and cannot be parallelised after the fact.

### 2026-09-09 — the Sandbox app is a third gate, and it needs a phone
- **Where:** `world-id/sandbox/testing-selfie-check`
- **Expected / Actual:** testing needs the Sandbox build of World App, via TestFlight or a private Google Play link, not the public app. Distinct from both approvals above.
- **Cost:** it means no part of the proof flow can be exercised from a laptop, so everything up to the widget is verifiable and the last step is not.
- **Fix we'd suggest:** state the three prerequisites together — environment access, feature flag, app build — near the top of the Sandbox section.

### States

### Proof flows

### Test users

### Errors

### Edge cases

## What was confusing

### 2026-09-09 — `signRequest` returns camelCase, `RpContext` consumes snake_case
- **Where:** `@worldcoin/idkit-core/signing` → `signRequest()`, and the `rp_context` prop on `IDKitRequestWidget`
- **Expected / Actual:** `signRequest` returns `{ sig, nonce, createdAt, expiresAt }`. The context the widget wants is `{ rp_id, nonce, created_at, expires_at, signature }`. Three of the five keys change name between producing and consuming them, including `sig` → `signature`.
- **Cost:** none for us, because I read both shapes before writing the mapping. But spreading the result — `{ ...signRequest(...), rp_id }`, which is the obvious thing to write — produces a context that is fully populated, structurally valid, and rejected. That is a silent failure with no clue pointing at field names.
- **Fix we'd suggest:** either have `signRequest` return the context shape directly, or export a `toRpContext(signed, rpId)` helper so nobody hand-maps it. Failing both, show the mapping explicitly in the integrate snippet instead of `rpSig.nonce`-style access that hides the rename.

### 2026-09-09 — `max_verifications` defaults to 1, which silently becomes your app's abuse policy
- **Where:** `POST /api/v2/create-action`, `max_verifications` (default 1)
- **Expected / Actual:** our whole model is *N listings per human, refused on N+1, by us, with a reason*. At the default, World refuses the second verification first, and the limit a user hits is World's rather than ours. The two are indistinguishable from the outside.
- **Cost:** caught before creating the action, only because I went looking for the parameter's default. Had I taken the default, the product's core control would have been invisible behind World's, and the demo would have shown the wrong system saying no.
- **Fix we'd suggest:** the field name reads like a safety limit, so a default of 1 is defensible — but the docs should say plainly that it caps verifications *per person*, and that apps implementing their own per-person policy want 0. One sentence next to the parameter.

## What was missing

## What was broken

### 2026-09-09 — three documentation URLs returned 404 while being linked or indexed
- **Where:** `docs.world.org/world-id/id/cloud-verification`, `docs.world.org/world-id/idkit/rp-context`, `docs.world.org/api-reference/create-incognito-action`
- **Expected / Actual:** all three 404. The last is the canonical reference for creating an action and appears in search results; I had to reconstruct its contract from a search summary and then confirm the shape by probing the live endpoint.
- **Cost:** roughly twenty minutes, and it moved me from reading documentation to reverse-engineering an API — on the one call whose parameter defaults turned out to matter most.
- **Fix we'd suggest:** these are reachable from search and presumably from older docs; redirect them rather than 404, and check `api-reference/*` as a group.

## What was hard to test

### 2026-09-09 — everything except the proof is testable; the proof needs a human and a phone
- **Where:** the whole flow
- **Expected / Actual:** we could test context signing, credential validation, the verify route's failure paths, the nullifier extraction and the entire listing-limit rule offline, with 11 unit tests against a real SQLite store. What cannot be tested without a person holding a phone is the one step that makes any of it true.
- **Cost:** acceptable, and arguably correct — proof of personhood should be hard to automate. But it means CI can never cover the integration end to end, and a regression in the widget or the portal contract would only surface manually.
- **Fix we'd suggest:** a sandbox test identity that returns a deterministic, clearly-fake nullifier over the API without a device would make the seam between "our code is right" and "the proof is real" testable in CI. The simulator covers World ID generally; something equivalent for Selfie Check would close this.

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
- **A missing `.env` file reports as a missing credential.** With no `.env` at
  the CRE project root, `cre workflow simulate` fails with `failed to replace
  secret names with environment variables: environment variable X for secret
  value not found, please export it to your environment` — and exporting `X` in
  the shell does not fix it, because the file takes precedence over the
  environment. Two different problems produce one message, and the message
  recommends the fix that does not work. "No .env found at <path>; -e <path> to
  point elsewhere" would be unambiguous.
