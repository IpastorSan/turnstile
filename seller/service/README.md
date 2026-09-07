# seller/service

Three things live here: the x402-gated HTTP service, the discovery API, and the
premium tier.

## `openapi.yaml` — the wire contract

OpenAPI 3.1, hand-written against `app.ts` and `tiers.ts` and cross-checked
against the captured transcript in `docs/x402-service.md`. It documents the 402
challenge itself — `accepts[]`, the opaque `extra` object, and the
`extra.resource` binding — which is the part a generic generator gets wrong,
because a generator only ever sees the happy path.

It has a second audience besides human readers: an agent runtime can turn this
file into tools, and Bazantic generates a hosted MCP server from it
(`docs/bazantic-gateway.md`). Every `description` in it is therefore the tool
documentation an agent reads when deciding whether to call an operation, and is
written as when/why/how guidance rather than as a restatement of the response
shape. **Keep it that way when you edit it**, and re-validate:

```bash
npx -y @apidevtools/swagger-parser validate seller/service/openapi.yaml
```

`servers[0]` is a placeholder. There is no public deployment yet — see
`docs/deploy.md`.

## `premium.ts` — the answer, plus a pointer to the attested verdict

Discovery is free: you can find the analyst, read its price and see what it
claims to do. `answerPremium()` is the thing itself, and it returns two
artefacts rather than one — the full seven-signal `Verdict`, which never goes on
chain, and a pointer to the on-chain record of the same verdict produced inside
a Chainlink CRE confidential workflow. See `seller/cre/` and
`docs/cre-confidential-workflow.md`.

The second is what makes the first worth buying from a stranger. An analyst you
have never met asserting AVOID is a claim; an attested enclave asserting AVOID
over evidence you can hash yourself is a fact.

### Attestation strength is four values, not a boolean

| `strength` | Means |
|---|---|
| `attested` | delivered by the CRE Forwarder from a pinned workflow id — the full claim |
| `forwarded-ungated` | the CRE Forwarder, but the consumer would accept any workflow this owner deploys |
| `self-delivered` | not the CRE Forwarder. Somebody wrote this by hand. |
| `none` | nothing has settled for this pool |

Collapsing these into `verified: true` is the one bug that would make the tier
worthless, because three of the four are not the claim. As of 2026-09-07 the
only consumer holding anything reports `self-delivered`: `cre workflow deploy`
needs deployment access this org does not have, so the DON-signed link is the
one thing not yet exercised.

`commitsToEvidence` is the buyer's own check, run for them — hash the bundle in
the response, ask the chain whether the settled verdict commits to those exact
bytes. A `false` there means the seller substituted the evidence, which is the
one form of cheating the on-chain record exists to catch.

### No chain in this file, and that is `no-chain-code.test.ts`'s doing

`premium.ts` was originally written with `viem`, an RPC endpoint and the CRE
Forwarder address in it, and MOV-219's guard caught it on the merge. The guard
was right, and the fix was architectural rather than an exemption: everything
that knows about `VerdictConsumer`, the Forwarder and an endpoint moved to
[`seller/cre/attestation.ts`](../cre/attestation.ts), and `premium.ts` now takes
an `AttestationReader` — `(pool, evidenceHash, answerRating) => Attestation` —
and reports its `strength` verbatim without interpreting it.

That is the same boundary the guard exists to defend, applied to a second kind
of chain dependency the rule's author had not met yet. `premium-cli.ts` is the
composition root for it, the way `server.ts` is for the rails: it names the
consumer once, and is exempt for the same reason.

### The seam MOV-219 plugs into

The join is one function:

```ts
answerPremium(options) -> PremiumAnswer
```

A rail calls it **after** it has verified payment, and puts the result in its own
receipt. Nothing here checks payment, quotes a price, or knows what a rail is —
which is what lets x402-on-Hedera and Arc USDC both use it without either
learning about the other. `PREMIUM_TIER` is exported so a rail matches on a
constant rather than a string literal.

```bash
node seller/service/premium-cli.ts \
  --evidence seller/cre/fixtures/usdc-weth-500.json \
  --consumer 0xEE72d3d0E4b090eBB8Db6abc26547bcd1fc9C5F2
```

Prefer `--evidence <pinned bundle>` over `--pool`. The on-chain verdict commits
to specific bytes, so re-gathering produces a different hash and the buyer's
check fails through nobody's fault — `premium.ts` adds a caveat saying exactly
that when you do it anyway.

---


## `app.ts` / `x402.ts` — the service that sells the verdict

`npm run serve`. Express, over `seller/analyst/`, gated by x402 (MOV-219).

| Route | Price | |
|---|---|---|
| `GET /health` | free | what this seller sells, accepts, and whether settlement is live |
| `GET /analyze/:pool` | **$0.07** | the Liquidity Analyst verdict, from the subgraph |
| `GET /analyze/:pool/attested` | **$0.35** | the verdict, a live depth ladder, and the scorer input behind both |
| `GET /receipts/:transaction` | free | audit-trail lookup, across every rail |

### The flow

```
GET /analyze/0x88e6…                    -> 402  PAYMENT-REQUIRED: <base64>
GET /analyze/0x88e6…  PAYMENT-SIGNATURE -> 200  PAYMENT-RESPONSE: <base64>
```

x402 **v2**, so the headers are `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE` and
`PAYMENT-RESPONSE` — not v1's `X-PAYMENT` / `X-PAYMENT-RESPONSE`. The challenge
goes in the header *and* in the JSON body: the header is what the protocol reads,
the body is what a human with `curl` sees, and they are the same object. A full
transcript is in `docs/x402-service.md`.

Ordering is **verify -> do the work -> settle**. A payer whose payment is bad is
refused before any work happens, and value moves only once there is an answer to
hand over. If settlement then fails, the answer is withheld and the response is a
402 naming the failure — we neither give the work away nor charge for something
undelivered.

### Two tiers, and the difference is not a rate limit

The premium tier returns the complete `AnalystInput` alongside the verdict.
`seller/analyst/scoring.ts` is a *pure* function of that object, so a buyer
holding it can re-derive the verdict and get the same bytes — the claim is
checkable rather than merely asserted.

That is also the MOV-227 seam, and it needs no new tier: the Chainlink TEE's
argument and the premium payload are one object.

`attestation.ts` holds the injection point — `AttestationPort`, mirroring
`AnalystPort`, defaulting to `unattestedPort()` and injected on
`ServiceOptions.attestation`. MOV-227 implements it in `seller/cre/`, which is
where an enclave and a contract address are allowed to live; a file here naming
either fails `no-chain-code.test.ts`.

**An implementation must hash exactly the bytes the buyer receives in
`analystInput`.** `app.ts` passes the same object reference to the port that it
serializes into the response, and `attestation.test.ts` asserts the two serialize
identically — because hashing a normalized copy or a re-fetch would silently turn
the premium tier back into an assertion without anything failing.
`docs/x402-service.md` has the long version.

The standard tier answers from the subgraph alone. Skipping the live quote is
most of why it is cheaper, and the verdict *says* it is flying blind and loses
confidence for it, rather than quietly scoring on history.

### Prices are read, not invented

`$0.07` is the `turnstile:price` text record on `liquidity.turnstile.eth`,
verified live on Sepolia 2026-09-07. `discovery.ts` reports that record as an
*exact* price (`priceSource: 'turnstile'`), so a service charging anything else
would make the discovery layer a liar.

`$0.35` is under the `turnstile:price-ceiling` of `0.50` on the same name.
`assertWithinCeiling()` runs at construction, so a seller that would overcharge
refuses to start rather than finding out on the first sale. Raising that ceiling
is a **cold-key** operation — the `CLAUDE.md` invariant applied to the seller
side.

### The 402 advertises both rails

`accepts[]` carries one entry per rail, and the buyer's mandate picks. See
`rails/README.md` for the seam, and `buyer/watchdog/README.md` for the choosing.

**Correction (2026-09-07, MOV-220):** this section said "**as of MOV-219 both
rails are placeholders that settle nothing**". Half of that has fallen.
`hedera-x402` settles real HBAR on Hedera testnet through Blocky402, `/health`
reports `settlementLive: true`, and its entries carry
`extra.turnstileSettlement: 'live'`. See `docs/payment-flow.md` for the
transaction. `arc-usdc` is still a placeholder carrying
`turnstileSettlement: 'stub'` — MOV-225 brings it.

The property that has not changed, and is the one worth watching: **each entry
says which it is, on the wire.** A service that advertises a rail and settles
nothing without saying so looks identical from outside to one that works.

### No chain-specific code lives here

The service speaks US dollars and opaque strings; rails speak chains. This is
asserted mechanically by `no-chain-code.test.ts` rather than left to review — no
file on the payment path may name a chain, vendor, asset or signature format, and
exactly one file (`server.ts`, the composition root) may import a concrete rail.
`discovery.ts` is exempt by name and for a reason: it reads a multi-chain agent
registry, so chain identifiers are its subject matter rather than a leak.

**If this test fails your branch, it has found a boundary rather than an
obstacle** — the answer is nearly always that the code belongs in `rails/`,
`seller/cre/` or `buyer/watchdog/`. Get an exemption agreed rather than adding
yourself to the list; it is the audit trail for the rule.
`docs/x402-service.md` explains why it exists.

### Why the middleware is ours and not `@x402/express`'s

The SDK splits challenge construction into `parsePrice(price, network)` and
`enhancePaymentRequirements(...)`, and **neither is given the resource being
sold** — so a rail cannot bind its challenge to the URL it was issued for, which
is what stops a payment authorized for the $0.07 route being replayed against the
$0.35 one. Adopting that split would also have made the SDK's scheme-server shape
(asset transfer methods, payment flows, facilitator `/supported` sync) the thing
MOV-220 and MOV-225 implement, instead of four methods.

Header codecs and zod schemas still come from `@x402/core`, so the bytes on the
wire are the specification's rather than our reading of it, and
`x402-interop.test.ts` proves it the way that counts: an **unmodified
`@x402/fetch` client** walks the whole flow against this server and gets a 200.

## `discovery.ts` — find and rank sellers

`findSellers(db, query)` answers "which agents can do X, for under $Y, and which
should I try first". It reads `agent_current` from `graph/sink/` and nothing
else.

```bash
node seller/service/discovery-cli.ts --capability liquidity --max-price 0.10
node seller/service/discovery-cli.ts --chains base,mainnet --x402 --json
```

The same function is exposed to agents as the MCP tool `find_sellers` — see
`mcp-turnstile/tools/find-sellers.ts`.

### The join

Discovery is three-way, because no single source can answer the whole question:

| Source | Answers | Covers |
|---|---|---|
| ERC-8004 registry, via Substreams | who exists, on every chain | everyone |
| Our ENSv2 `turnstile:price` record | what it costs, exactly | Turnstile sellers |
| A live HTTP 402 response | what it costs, right now | anyone with an x402 endpoint |

**The registry tells you who exists; Turnstile tells you what they cost.**

### Price is never invented

EIP-8004 registration-v1 has no price field. Under x402 the quote arrives in the
402 response, so there is nothing on-chain to read — and a survey of 1,200 live
registrations found zero documents carrying a price. Every result therefore
carries a `priceSource`:

| `priceSource` | Means |
|---|---|
| `turnstile` | Read from a `turnstile:price` ENS text record. Exact. |
| `x402` | A live 402 quote we fetched. Perishable — `x402ProbedAt` says when. |
| `document` | A non-standard price object in the registration. Expect zero. |
| `ask_x402` | The agent takes payment and has not been quoted. **Not free.** |
| `none` | No price, and no way to get one. |

A price ceiling only filters agents whose price is actually knowable. The rest
are excluded and *counted* in `coverage.droppedForUnknownPrice`, or kept with
`price: null` if you pass `includeUnknownPrice`. Units are reconciled in
`normalizePriceUsd`, which returns `null` rather than a number for anything it
cannot convert — an x402 `maxAmountRequired` is an integer in the asset's
smallest unit, a `turnstile:price` is decimal dollars, and comparing them
blindly would rank a seven-cent seller against a seventy-thousand-dollar one.

### Ranking is a placeholder, and says so

The intended signal is **settled volume** — the sum of payments other buyers
actually made, which is the one number an agent cannot fake. It comes from HCS
receipts.

**Correction (2026-09-07, MOV-220):** those receipts "do not exist yet" is no
longer true. `rails/hedera-x402/hcs.ts` writes one per settled payment to topic
`0.0.10408013`, and `graph/sink/ingest-receipts.ts` reads the topic back off the
public mirror node into `settlement_receipt`. Run it and the ranking below stops
being a placeholder:

```bash
node graph/sink/ingest-receipts.ts --ens liquidity.turnstile.eth
```

Everything else in this section is unchanged, and still describes a database that
has not had that run. With `settlement_receipt` empty, results come back ordered
by registration recency with:

```json
"ranking": {
  "basis": "registration_recency",
  "placeholder": true,
  "note": "PLACEHOLDER: ... This ordering carries no information about how much business an agent has done."
}
```

`rankingBasis()` switches to `settled_volume` and drops the placeholder flag the
moment the table has rows. Nothing else has to change.

### Capability matching

Tokens are matched first against `agent_capability` — skills and domains the
agent declared, indexed by whole OASF path and by each segment, so
`blockchain-interaction` finds `tool_interaction/blockchain_interaction`. Most
of the directory declares no skills at all, so there is a fallback to the name
and description. Each result reports which matched in `matchedOn`, so a caller
can tell a declared capability from a word in a sentence.

### Seams left open

- **`settledVolume`** — **closed by MOV-220.** A rail that settles, an HCS topic,
  and `graph/sink/ingest-receipts.ts` to read it into `settlement_receipt` all
  exist; `graph/sink/ingest-receipts.test.ts` asserts the ranking flips off its
  placeholder on the first receipt. It stays listed here because it is only
  closed for a database the ingest has actually run against.
- **`worldVerification`** — MOV-223, blocked on World Sandbox approval. Every
  result reports `'unknown'`. Not `'unverified'`: that would be a claim we have
  not earned.
