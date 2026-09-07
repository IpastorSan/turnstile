# seller/service

Two things live here: the x402-gated HTTP service, and the discovery API.

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
