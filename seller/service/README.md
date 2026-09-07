# seller/service

Three things live here: the x402-gated HTTP service, the discovery API, and the
premium tier.

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

### The seam MOV-219 plugs into

`rails/PaymentRail.ts` did not exist on `dev` when this was written, so nothing
in `premium.ts` imports it. The join is one function:

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
receipts (MOV-220), which do not exist yet, so `settlement_receipt` is empty and
results come back ordered by registration recency with:

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

- **`settledVolume`** — MOV-220. Described above.
- **`worldVerification`** — MOV-223, blocked on World Sandbox approval. Every
  result reports `'unknown'`. Not `'unverified'`: that would be a claim we have
  not earned.
