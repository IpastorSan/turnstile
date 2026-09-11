# MOV-222 — Discovery API: find and rank sellers

Date: 2026-09-07
Artifacts: `graph/sink/`, `seller/service/discovery.ts`, `mcp-turnstile/tools/find-sellers.ts`
Builds on: `docs/erc8004-substreams.md` (MOV-221), `docs/ens-offer-records.md` (MOV-218)

Every number and every query result below was produced against **live data**:
the ERC-8004 registries on Ethereum mainnet, Base and Sepolia streamed through
the Graph Market, agent documents fetched from the URLs those registrations
actually publish, and `liquidity.turnstile.eth` read off Sepolia.

---

## The finding that shapes the design

**One agent out of 197 has a price anyone can read.** It is ours.

| Price source | Agents |
| --- | ---: |
| `turnstile` — an ENSv2 `turnstile:price` record | **1** |
| `x402` — a live 402 quote we fetched | 0 |
| `document` — a price in the registration document | 0 |
| `ask_x402` — advertises x402, price knowable but unquoted | 96 |
| `none` — no price and no way to get one | 100 |

**Correction (2026-09-07, MOV-230):** this table previously gave `ask_x402` 96
and `none` 100, and the document-state counts further down as `failed` 28 /
`off_module` 123. Those were right for the run they were written from, but they
are not stable numbers. Re-read against the same store on 2026-09-07 (`select
price_source, count(*) from agent_current group by price_source`):

| Price source | Then | Now |
| --- | ---: | ---: |
| `turnstile` | 1 | **1** |
| `x402` | 0 | **0** |
| `document` | 0 | **0** |
| `ask_x402` | 96 | **97** |
| `none` | 100 | **99** |

Document states are now `off_module` 126, `failed` 25, `in_module` 15, `no_uri`
30, `not_fetchable` 1. The cause is the one this document already identifies:
Cloudflare 530s and other transient origin failures resolve on a later pass, so
an agent moves from `failed` to `off_module`, and a document that turns out to
carry `x402Support` moves from `none` to `ask_x402`.

**What is unchanged is the finding.** `turnstile` is 1, and `x402` and
`document` are both still 0 — one agent in 197 has a readable price and it is
ours. Only the two "cannot be read" buckets move, and they move *between each
other*. Treat 96/100 and 97/99 alike as a snapshot of a live directory, not as
constants; the web app computes them from the store at request time rather than
quoting either figure.

This is not a gap in the sink. EIP-8004 registration-v1 has no price field, and
under x402 the quote is returned dynamically in the HTTP 402 response, so there
is nothing on-chain for a registry to carry. MOV-221 surveyed 1,200 live
registrations across three chains and found zero with a price; this run of 197
independently found zero as well.

`x402Support` is the signal that actually exists, and it means **ask the
endpoint**. 96 of 197 agents set it (97 as re-read on 2026-09-07 — see the
correction above). Of those, only **13** publish an HTTP
endpoint that can be asked, and **none of the 13 returned a 402** — see
"Probing" below.

So discovery is a three-way join, and the second leg is the one that pays:

| Source | Answers | Covers here |
| --- | --- | ---: |
| ERC-8004 registry, via Substreams | who exists, cross-chain | 197 |
| Our ENSv2 `turnstile:price` record | what it costs, exactly | 1 |
| A live HTTP 402 response | what it costs, right now | 0 of 13 asked |

**The registry tells you who exists; Turnstile tells you what they cost.**

---

## What is in the store

`graph/sink/sink.ts` streamed four ranges of `map_agent_registrations` from the
packaged `.spkg` — no checkout, exactly what a third-party consumer runs.

| Network | Chain id | Block range | Agents |
| --- | ---: | --- | ---: |
| `base` | 8453 | 41,700,000 – 41,715,999 | 119 |
| `mainnet` | 1 | 25,000,000 – 25,014,999 | 38 |
| `sepolia` | 11155111 | 10,000,000 – 10,009,999 | 39 |
| `sepolia` | 11155111 | 11,653,700 – 11,653,729 | 1 (agent `10127`, ours) |
| | | **total** | **197** |

Agent `10127`'s registration block was found with an `eth_getLogs` on
`Registered(uint256,string,address)` topic-filtered by agent id
(`0xca52e62c…c449bc4a`), then that 30-block window streamed. It is at Sepolia
block **11,653,714**, tx
[`0xb996bbaf…0f8c86ff`](https://sepolia.etherscan.io/tx/0xb996bbafae8737ad1574d7bd50278f0fccb47093d798d051f3a6e3a70f8c86ff).

### Cross-chain, in one result set

```
$ sqlite3 graph/sink/data/discovery.db "select network, chain_id, agent_uid, name from agent_current ..."

network  chain_id  agent_uid                                                         name
-------  --------  ----------------------------------------------------------------  ----------------------
base         8453  eip155:8453:0x8004a169fb4a3325136eb29fa0ceb6d2e539a432/1411       FluxCore
mainnet         1  eip155:1:0x8004a169fb4a3325136eb29fa0ceb6d2e539a432/32090         Zyfai Rebalancer Agent
sepolia  11155111  eip155:11155111:0x8004a818bfb912233c491871b3d84c89a494bd9e/10127  liquidity.turnstile.eth
```

Three chains, one query, no per-chain code. `agent_uid` is what makes the union
safe: mainnet's agent 1411 and Base's agent 1411 are different agents and get
different uids. Note also that mainnet and Base share a registry address
(`0x8004a169…`, the ERC-8004 mainnet vanity address) while Sepolia uses
`0x8004a818…` — the uid disambiguates on chain id regardless.

### Sinking cannot be parallelised across chains

The Graph Market plan caps concurrent streams at two:

```
Error: unable to complete work within backoff time limit: rpc error:
  code = ResourceExhausted desc = Concurrent stream limit exceeded (active sessions: 2/2)
```

Three chains at once fails on the third. `graph/sink/README.md` says to run them
one at a time; this is why.

### `map_agent_registrations`, not `map_agent_directory`

The directory module reads `store_agent_wallets`, and a store must be backfilled
from its `initialBlock` before it answers anything:

```
Error: --limit-processed-blocks is set to 10,000, but this request needs to process
  37,200 blocks (37,000 of them to prepare the stores)
```

37,000 blocks of Base to read a 200-block window. The sink consumes the pure map
module instead and does the wallet join itself in SQL (`foldWallets`), which is
free — the sink is already a store. On the Sepolia range that folded **10**
agents onto an `agentWallet` set in a different block from their registration,
which is precisely the case the map module cannot see alone.

---

## Off-module resolution: the part the module cannot do

A Substreams module is a deterministic function of the block, so it decodes
`data:` URIs and bare-JSON literals and nothing else.

| `uri_scheme` | Agents | Resolvable |
| --- | ---: | --- |
| `HTTPS` | 116 | off-module |
| `IPFS` | 35 | off-module, via gateway |
| `EMPTY` | 30 | never — there is no document |
| `DATA` | 15 | in-module |
| `OTHER` | 1 | our seller: the URI is its ENS name |

**In-module: 15 of 197 (7.6%).** After `resolve-cards.ts`:

```
$ node graph/sink/resolve-cards.ts --concurrency 10
151 agents to resolve off-module
attempted 151, resolved 123 (81.5%), median 178ms
{"resolved":123,"http_error":21,"network_error":6,"parse_error":1}
```

| Outcome | | |
| --- | ---: | --- |
| `resolved` | 123 | HTTP 200, document parsed |
| `http_error` 404 | 10 | the URL is gone |
| `http_error` 530 | 10 | origin down (Cloudflare) |
| `http_error` 410 | 1 | deliberately removed |
| `network_error` | 6 | DNS or connection failure |
| `parse_error` | 1 | 200 OK, body was not JSON |

A second run from a clean store, an hour later, resolved **126 of 151 (83.4%)**
— the difference is entirely Cloudflare 530s coming back. So the rate is
**81–84%**, not a fixed number: some fraction of these failures are origins
being briefly down rather than URLs being dead, which is exactly why
`--retry-failed` exists and why failures are stored with a status instead of
being folded into "unresolvable".

**Document coverage went from 7.6% to about 70%** (138–141 of 197 have a
document; 30 more have no URI at all and never will). The off-module success
rate against live URIs is comfortably above the ~28% the module alone can reach,
so the framing MOV-221 used holds up and if anything understates it.

The whole store rebuilds from scratch — six `sink.ts` replays, one
`resolve-cards.ts`, one `hydrate-sellers.ts` — and comes back to the same 197
agents on the same three chains, with the same single knowable price.

The 28 failures are stored with their status rather than dropped.
`document_state` in `agent_current` is `in_module` (15), `off_module` (123),
`failed` (28), `no_uri` (30) or `not_fetchable` (1). A directory that dropped
what it could not fetch would be telling a buyer's agent "this seller advertises
no capabilities" when the truth is "we could not ask".

### Data-shape findings

- **`agentURI` is attacker-controlled.** Anyone can register an agent whose
  document URI points at `169.254.169.254` or at something on the sink's own
  network. Fetches refuse loopback, link-local, RFC1918 and CGNAT destinations,
  and the guard re-runs on every redirect hop rather than letting `fetch` walk
  one past it.
- **An MCP service's `capabilities` key is not a capability list.** It holds the
  MCP handshake — `["tools","resources","prompts"]` — identically on every MCP
  endpoint in the directory. Its `tools` array is the real capability list, and
  is what gets indexed.
- **OASF skills are taxonomy paths**, e.g.
  `analytical_skills/data_analysis/blockchain_analysis`. Both the whole path and
  each segment are indexed, so a search for `blockchain-analysis` finds it.
- **Most agents declare no skills at all.** 329 capability tokens across 197
  agents, heavily concentrated: `reputation` 14, `web` 12, `a2a` 9, `mcp` 9.
  Capability filtering therefore falls back to name and description text, and
  each result says in `matchedOn` which of the two matched it.
- **Endpoints are often not services.** Agents publish their Twitter profile,
  their GitHub, and the OASF specification URL as "endpoints".

---

## Turnstile seller hydration

```
$ node graph/sink/hydrate-sellers.ts
liquidity.turnstile.eth
  price          0.07  ceiling 0.50  rails x402,usdc-arc
  mcp            https://mcp-eu.turnstile.xyz/liquidity.turnstile.eth/sse
  # ^ superseded 2026-09-08 (MOV-010) -> turnstile.moveseventyeight.com/…
  #   Transcript left verbatim; re-running hydrate-sellers prints the new host.
  payout         0x0Adca6e14bA956201D221feC767e4f24194bf5F2
  resolver       verified (impl 0x7E4B2d59938930168024201752EE5503df402303)
  agent link     eip155:11155111:0x8004a818bfb912233c491871b3d84c89a494bd9e/10127
  read at block  11653950
```

The `agent_uid` link is only written when **both** directions check out — the
ENS name carries the ENSIP-25 `agent-registration[…][10127]` record, and the
registry's `tokenURI(10127)` returns `liquidity.turnstile.eth`. A name can claim
any agent id it likes; a unilateral claim stays unlinked and is reported.

`resolver verified` is `VerifiableFactory.verifyContract` returning the stock
ENS `PermissionedResolver` implementation. That check is why a buyer's agent can
act on a price read there rather than treating it as a rumour.

The ENSIP-25 key encoder is tested against the **specification's own worked
example** rather than against our Solidity, so the TypeScript reader and the
Solidity writer cannot drift together:

```
agentRegistrationKey(1, 0x8004a169…a432, 42)
  === 'agent-registration[0x000100000101148004a169fb4a3325136eb29fa0ceb6d2e539a432][42]'
```

Seller identity is read from `contracts/addresses.turnstile.sepolia.json`, not
hard-coded, per MOV-218's rule that no name appears as a constant anywhere.

---

## Probing: asking for a price with a live 402

```
$ node graph/sink/probe-x402.ts --limit 60
13 x402 endpoints to probe
  http_error       https://github.com/agntcy/oasf/            (x6)
  http_error       https://clanknet.ai/api/agent
  no_402           https://www.capminal.ai/mcp
  http_error       https://www.gekkoterminal.xyz/mcp/rebalancer
  http_error       https://www.gekkoterminal.xyz/mcp/strategist   (and /executor, x4)

{"http_error":12,"no_402":1}
```

**Zero live quotes.** 96 agents advertise `x402Support`; 13 publish an endpoint
that can be asked; every one of those either 404s or answers something that is
not a 402. The `gekkoterminal.xyz` and `capminal.ai` MCP URLs return Next.js 404
pages to both a GET and an MCP `tools/list` POST — the probe tries both, because
an x402-gated HTTP resource quotes on the GET while an x402-gated MCP server
only quotes on the JSON-RPC call.

Six of the thirteen are agents whose only listed endpoint is the OASF
specification URL on GitHub. That is what the directory looks like today.

This is the honest state of x402 pricing in the live ERC-8004 directory as of
2026-09-07: the flag is widely set and the endpoints behind it are mostly not
there. It is also the strongest argument for the ENS leg — an offer published as
a resolver record is readable whether or not the seller's HTTP endpoint happens
to be up.

---

## The discovery API

### Filter by capability and price ceiling

```
$ node seller/service/discovery-cli.ts --capability liquidity --max-price 0.10

197 agents in the store across 3 chains: base (8453) 119, sepolia (11155111) 40, mainnet (1) 38
documents: {"failed":28,"in_module":15,"no_uri":30,"not_fetchable":1,"off_module":123}
price sources among matches: {"turnstile":1,"x402":0,"document":0,"ask_x402":7,"none":0}
filtered out: 0 over the ceiling, 7 with no knowable price

ranking: registration_recency  [PLACEHOLDER]
  PLACEHOLDER: ranked by registration recency. Settled volume is the intended ranking
  signal and comes from HCS settlement receipts (MOV-220), which do not exist yet —
  settlement_receipt is empty. This ordering carries no information about how much
  business an agent has done.

sepolia   #10127   $0.07 (turnstile)
  liquidity.turnstile.eth
  Uniswap v4 pool liquidity analytics over Sepolia and mainnet. Priced per query, paid on x402 or USDC.
  uid eip155:11155111:0x8004a818bfb912233c491871b3d84c89a494bd9e/10127
  payTo 0x0adca6e14ba956201d221fec767e4f24194bf5f2  x402 false  doc not_fetchable
  matched on text:name-or-description
  turnstile rails x402, usdc-arc  ceiling 0.50  resolver verified

1 shown of 8 matched.
```

Eight agents match `liquidity` across three chains. Seven are dropped by the
ceiling — **not because they are expensive, but because their price is not
knowable**, and the result says so and counts them. `--include-unknown-price`
returns all eight, the seven with `price: null`:

```
base      #1302    (no price)
  Xtreamly Volatility Predictor
  We provide price volatility predictions for several tokens including ETH...
  payTo 0x7346dc42102b5cdba321d587564612d1f3878ad2  x402 true  doc off_module
```

`x402 true` and `(no price)` together is the whole design constraint in one
line: this agent takes money and there is no way to learn how much without
asking it, and asking it does not currently work.

### Price units are reconciled, or refused

`turnstile:price` is decimal dollars (`"0.07"`). An x402 `maxAmountRequired` is
an integer in the asset's smallest unit (`"70000"` USDC — seven cents).
`normalizePriceUsd` converts what it can and returns `null` for anything else,
rather than a number: comparing the two blindly would rank a seven-cent seller
against a seventy-thousand-dollar one.

### Ranking is a labelled placeholder

Settled volume is the intended signal — the sum of payments other buyers
actually made, which is the one number an agent cannot fake. It arrives with the
HCS receipts in MOV-220, so `settlement_receipt` is empty and every result
carries:

```json
"ranking": { "basis": "registration_recency", "placeholder": true, "note": "PLACEHOLDER: ..." }
```

`rankingBasis()` switches to `settled_volume` and drops the flag the moment the
table has a row; a test inserts one and asserts the switch. Nothing else changes.

Recency means **first registration**, not last document edit — otherwise an
agent that repointed its URI would outrank one that had just registered, and the
ranking would reward churn.

### As an MCP tool

```
$ node mcp-turnstile/server.ts --db graph/sink/data/discovery.db
→ tools/list  → find_sellers
→ tools/call  find_sellers {"limit": 2}

2 of 197 matching agents, from 197 in the store across 3 chains
(base:119, sepolia:40, mainnet:38).
Ranking: registration_recency — PLACEHOLDER, not a reputation signal.
28 agents in the store have a registration document that could not be fetched
(404, timeout or unreachable gateway). They are listed with documentState "failed":
their capabilities are unknown, not absent.
```

The prose summary comes before the JSON because the caller is an agent about to
spend money, and the things it most needs to notice should not be buried in a
nested object.

---

## Seams left open

| Seam | Issue | State |
| --- | --- | --- |
| `settlement_receipt` | MOV-220 | Table exists, empty. Ranking falls back and labels itself. **Correction (2026-09-07, MOV-229):** the table is still empty and the ranking is still a labelled placeholder, so this row is accurate — but the *receipts* are not missing. Twelve exist on HCS topic `0.0.10408013` and every one verifies against the ledger; `npm run ingest-receipts` lands them here and the ranking flips to `settled_volume` on its own. What is outstanding is the ingest, not the evidence. |
| `world_verification` | MOV-223 | Table exists, empty. Every agent reports `'unknown'` — deliberately not `'unverified'`, which would be a claim we have not earned. Blocked on World Sandbox approval. |
| `x402_quote` | — | Implemented and run; zero live quotes exist to store yet. |

## Not verified

- **The MCP endpoint in `agent-endpoint[mcp]` is still an unresolved host.**
  `https://turnstile.moveseventyeight.com/...` does not answer yet. The ENS
  record is real, the price is real, the thing at the other end is not up. As of
  2026-09-08 (MOV-010) it at least names a domain we own; it named
  `mcp-eu.turnstile.xyz` before, which we do not.

  **Still true, re-verified 2026-09-08 (MOV-010):** the host has changed and the
  finding has not. `mcp-eu.turnstile.xyz` had no DNS record on 2026-09-07
  (MOV-229); `turnstile.moveseventyeight.com` has none today. Both were checked
  the same way. The tool's behaviour is identical either way, which is the
  useful part: it reports the failure it actually observes rather than a host it
  was configured with. The `get_offer` MCP tool surfaces this as a
  first-class result rather than a footnote — it reports the $0.07 price *and*
  `purchasable: false` naming the DNS failure, so an agent cannot mistake a
  published price for a payable quote. `mcp-turnstile/examples/transcript.md`
  shows it happening.

  **Update (2026-09-11, MOV-273) — host and path both closed the same day:** the
  host is live, and so is the published path. `…/liquidity.turnstile.eth/sse`
  serves MCP over HTTP/SSE (handshake verified against the live host: `GET` with
  `Accept: text/event-stream` opens a stream naming its `POST …/messages?sessionId=…`
  return path, `initialize` answers with our capabilities, `tools/list` returns all
  four tools). The two dated notes above are left as the record of what was true on
  their dates. `get_offer` still reports `purchasable: false` for this agent, and
  the reason is now a transport mismatch rather than an absent service: the probe
  POSTs to the URL the record names expecting a `402`, and the SSE transport answers
  `404` to a bare POST because its POST path is `…/messages?sessionId=…`. The
  payable resource is `…/analyze/:pool`, which does answer `402`. The probe should
  follow the record the way a real MCP client does; that change is noted, not made.
  `examples/transcript.md` predates all of this and was not re-recorded.

- **`x402_quote` was still empty when this was written; it has since been run.**
  **Correction (2026-09-07, MOV-229):** all 14 agents in the store that advertise
  `x402Support` *and* publish an HTTP endpoint were probed. **Zero returned a
  402** — twelve HTTP errors, one 200, one DNS failure — and six of the fourteen
  publish `https://github.com/agntcy/oasf/`, a link to a specification rather
  than a service. Reproduce with
  `node graph/sink/probe-x402.ts --db /tmp/probe.db --limit 20` over a copy of
  `web/data/discovery.db`. The quotes were not written back into the tracked
  snapshot, so `x402_quote` in it remains empty by choice rather than by
  omission.
- **The store is a sample, not a backfill.** 197 agents from four block ranges,
  not the ~85,000 on Base. A full backfill is a matter of runtime and stream
  quota, not of code: `sink.ts` resumes and the cursor is per-network.
- **`forge test` was not re-run.** Nothing under `contracts/` was touched by this
  issue, and Foundry is not installed on this machine. The 66 tests from MOV-218
  stand as last reported.
