<!--
  Day-1 snapshot. Do not maintain this file.
-->

> **This is the unmaintained day-1 snapshot, written 2026-09-04, before any code
> existed.** It is published as a planning artifact, not as documentation. It is
> the input that was broken into issues; it is not a record of what was built,
> and large parts of it are now wrong.
>
> `CLAUDE.md` states the same rule for this file, verbatim: *"`plan/turnstile-v3.md`
> in the research repo is a **day-1 snapshot** and is deliberately not maintained —
> treat it as history, never as truth."*
> **[`CHECKLIST.md`](../CHECKLIST.md) is the live record**, and
> [`docs/EVIDENCE.md`](../docs/EVIDENCE.md) is the current state of every claim.
>
> Three things in here are known to be false and were corrected in the repo
> rather than here, so that the correction is visible as a correction:
>
> - The **Ledger** cold tier. The track was dropped on 2026-09-08 because
>   `wallet-cli ring init` cannot run on the only device available. See
>   [`CORRECTIONS.md`](../CORRECTIONS.md).
> - The **Paymaster** on Arc. No such mechanism exists in this design, and it
>   cannot exist on a chain where USDC is the gas token. See
>   [`CORRECTIONS.md`](../CORRECTIONS.md).
> - **"12 submissions"** and the prize arithmetic that follows from it.
>   ETHGlobal caps a project at three partner prizes. See the correction at the
>   top of [`CHECKLIST.md`](../CHECKLIST.md)'s "Before submitting" section.
>
> The body below is verbatim as written on 2026-09-04, em dashes, wrong claims
> and all. Nothing has been edited in, and nothing has been edited out.

---

# Turnstile v3 — ETHOnline 2026 build plan

## Context

ETHOnline 2026 runs 4–16 Sep 2026, async. We enter **From Scratch only** — `git init` at
kickoff, no pre-event project code, no Continuity prizes. From-scratch money actually
available across the 11 sponsors is **$59,834**.

Two prior drafts exist in `~/Documents/Moveseventyeight/002-projects/ETHOnline 2026.md`
("Mandate" and "Turnstile"). When the Ledger, Privy and Chainlink briefs landed on 2026-09-04
it became clear those drafts were the buyer and seller halves of one market, and that all
three new briefs describe the buyer/authorization half. This is the merged v3.

**Scope decision (user, explicit): full scope, built by us.** Stated concern, once: 12
submissions in 12 days is a lot for a small team, and the failure mode is twelve shallow
integrations that each miss a binary gate. The plan absorbs this by (a) making the
qualification checklist a day-1 artifact rather than a day-12 scramble, and (b) pre-declaring
cut lines in §5 so scope reduction is a decision already made rather than a panic.

Every technical claim below was verified against primary sources on 2026-09-04. Things that
could **not** be verified are marked ⚠️ and have a day-1 task attached.

> **First action: run `/ralph-planning` against this document** to break it into ordered Linear
> issues before any code is written. Details in §5, Step 0.

---

## 1. The product

**Turnstile — a paid lane for onchain data agents.**

Agents that sell onchain analysis have no way to be discovered, priced, or trusted, and no way
to sell an *edge* — publishing the analyst reveals the method. Buyers have no way to let an
agent spend without handing it a key. Turnstile fixes both ends:

Sellers publish a priced service at an **ENSv2 subname**; the resolver record *is* the offer.
A **Ledger** cold key owns the name and is the only thing that can rotate the hot key or move
the payout address. The seller's scoring method runs inside a **Chainlink CRE** enclave, so
listing does not leak the edge. Buyers arrive with a **mandate** — a **Privy** org wallet and
spend policy — and settle per call over **Hedera x402** or **USDC on Arc**. The flagship
seller is a Uniswap Liquidity Analyst whose only knowledge source is **The Graph**, shipped as
an MCP server + SKILL. **World ID Selfie Check** binds each cold key to a unique human so the
registry is not a Sybil farm.

One line: **sell the answer, keep the method.**

---

## 2. Architecture

### 2.1 The three key tiers

The reason three wallet vendors is not three ways to do one thing. Each sits where it is
actually best, and together they are one cold/warm/hot hierarchy.

| Tier | Vendor | Holds | Frequency | May authorize |
|---|---|---|---|---|
| **Cold** | Ledger Key Ring (`wallet-cli ring`) | Seller operator identity; owns the ENSv2 name; seals upstream API keys | Once per lifecycle | Hot-key rotation, payout address change, price-ceiling raise |
| **Warm** | Privy | Buyer **organization** wallet + mandate policy | Occasional | Issuing a mandate, raising a cap (quorum), adding an agent |
| **Hot** | Circle / Arc Agent Stack | Buyer agent's spending wallet | Every query | Nothing. Spends *within* the mandate, holds zero native token (Paymaster) |

This doubles as the architecture diagram Arc requires.

### 2.2 Repository layout

```
turnstile/
├── contracts/              Foundry. ENSv2 subname registry + registrar
│   ├── src/TurnstileRegistry.sol       UserRegistry proxy via Verifiable Factory
│   ├── src/TurnstileRegistrar.sol      pricing, availability, mint (cf. SimpleSubnameRegistrar)
│   └── script/Deploy.s.sol
├── graph/
│   ├── subgraph/           Messari DEX AMM Extended v4.0.1 conformant, → Subgraph Studio
│   └── substreams/         Rust. AUTHORED: ERC-8004 agent-registry normalization, published .spkg
├── seller/
│   ├── service/            x402-gated HTTP service (@x402/express)
│   ├── analyst/            Liquidity Analyst: Subgraph MCP client + live Uniswap API quotes
│   ├── cre/                Chainlink confidential workflow (TypeScript)
│   └── secrets/            Ledger Key Ring sealed .enc + headless decrypt entrypoint
├── rails/
│   ├── PaymentRail.ts      interface: challenge(), verify(), settle(), receipt()
│   ├── hedera-x402/        Blocky402 facilitator
│   └── arc-usdc/           Circle Agent Stack + Paymaster + nanopayments
├── buyer/
│   ├── mandate/            policy object + enforcement
│   ├── org/                Privy org wallet, policies, quorum
│   └── watchdog/           the buyer agent
├── mcp-turnstile/          MCP server + SKILL.md — the reusable-infra artifact
├── identity/               World Selfie Check, nullifier ↔ cold key binding
├── web/                    Next.js. Frontend + backend (Arc requires both)
├── FEEDBACK.md             Uniswap. Written continuously.
├── WORLD-FEEDBACK.md       World. Written continuously.
└── CHECKLIST.md            §4 of this plan, as a living file
```

### 2.3 The offer record — ENSIP-26, not invented

Sellers live at `liquidity.turnstile.eth`. Use the **standard** agent text-record keys rather
than a bespoke schema — ENS judges will notice:

- `agent-context` — free-form description of the service and how to interact with it. The
  discovery entry point.
- `agent-endpoint[mcp]` — the MCP endpoint URL. (`mcp`, `a2a`, `web` are the known protocol
  values; the key is extensible.)
- `agent-registration[<registry>][<agentId>]` — ENSIP-25, for ERC-8004-style registry
  attestation. Hits a Hedera "extra points" item for free.
- Turnstile-specific keys layered on top: `turnstile:price`, `turnstile:rails`,
  `turnstile:operator-proof` (World nullifier commitment).

### 2.4 Access control — the cold/hot split, concretely

ENSv2 **Enhanced Access Control** does exactly this, verified: 32 regular + 32 admin roles per
contract, resource-scoped down to an individual text key, via
`grantRoles(resource, roleBitmap, account)`. The Permissioned Resolver implements per-record
roles (8 per-record of 11 total).

- **Cold key (Ledger)** → root/name-level roles on the subname. Owns it. Can rotate the hot
  key, change payout, raise the price ceiling.
- **Hot key (agent)** → a role scoped *only* to `agent-endpoint[mcp]` and `turnstile:price`.
  It can update where the service lives and what it costs, within a ceiling. It **cannot**
  touch the payout address.

The on-camera demo beat: hot key attempts a payout-address change → transaction reverts.

### 2.5 Payment — the rail abstraction

`PaymentRail` is a four-method interface so the seller service is rail-agnostic and the 402
challenge can advertise both.

- **Hedera** (`rails/hedera-x402/`) — Blocky402 hosted facilitator. **No signup or API key on
  testnet**; testnet instance covers Hedera Testnet. Server side `@x402/express`, client
  `@x402/fetch`. ⚠️ Hedera's flow differs from the generic EVM `exact` scheme — client builds
  a partially-signed tx, facilitator co-signs for gas and submits — so `@x402/evm` may not
  work unmodified. Clone-and-adapt base: `hedera-dev/x402-inference-pay-per-request-poc`.
- **Arc** (`rails/arc-usdc/`) — Circle Agent Stack, Paymaster so the hot wallet holds zero
  native token, nanopayments to batch sub-cent queries. ⚠️ **Blocky402 does not support Arc.**
  This is a second, independent facilitator integration, not an extension of the first. Budget
  a full day, and accept it may end up as Circle's own x402 or a direct USDC transfer +
  receipt rather than a Blocky402-shaped flow.

### 2.6 The Chainlink enclave — cheapest qualifying design

Verified: outbound HTTPS from inside `handlerInTee` using a Vault DON secret fetched
in-enclave **works** — demonstrated in shipped template source (`ai-audit-firewall-ts` calls
two LLM-style endpoints whose URLs are plain config strings, with
`Authorization: Bearer ${apiKey}` where the key came from `runtime.getSecrets()`). No domain
allowlist found in the SDK.

⚠️ **But**: no example exists of an HTTP-triggered confidential workflow returning
synchronously to an off-chain caller. Only cron-trigger → `writeReport` on-chain is
demonstrated. **Design around this** rather than betting on it:

> The seller's **premium tier** is a CRE confidential workflow. The proprietary prompt, model
> choice, weighting and upstream LLM credentials live inside the enclave. It crosses
> `runtime.usingTheDons()` — a documented one-way door — with only a **compact verdict**
> (score + risk mask), which `writeReport` settles on Sepolia. The x402 service returns the
> answer plus a pointer to that attested on-chain verdict. The buyer can verify the score was
> produced by an attested enclave without ever seeing the method.

Use **TypeScript**, not Go (the Go SDK is pinned to unreleased pseudo-versions because
Confidential Workflows is not in a tagged release). Use `cre.handlerInTee(...)` with
`[{tee:'nitro', regions:['us-west-2']}]`. Do **not** reach for `ConfidentialHTTPClient` inside
a TEE handler — the template source explicitly warns it has no `TeeRuntime` overload.

### 2.7 The Ledger integration — what is real vs. what we build

Be precise here, because half of Ledger's prize copy describes things they do not ship.

**Real and documented** (`@ledgerhq/wallet-cli` v2.1.0, `npm i -g @ledgerhq/wallet-cli`):
- `wallet-cli ring init` — one-time provisioning, **device required**, password via `WALLET_PASS`
- `wallet-cli ring encrypt -i secrets.txt -o secrets.enc --key <k>` / `ring decrypt` / `ring keys`
- Backed by **LKRP** (Ledger Key Ring Protocol), AES-256-GCM
- **The headless property**: after `ring init`, encrypt/decrypt need network access to restore
  the trustchain but **not the device**. This is precisely the prize's "enroll a VPS, a CI
  runner, or a hosted agent" line, and it is real.

**Aspirational — a prize Example Direction, not a Ledger primitive**: the "broker hands out
scoped capabilities, never the API key" pattern, and anything x402-related (zero mentions of
x402 anywhere in Ledger's docs).

So our integration is: **the seller's upstream API key is sealed with `ring encrypt` on a
laptop with the Ledger attached; the hosted seller service on a VPS decrypts it at boot with
no device present.** The capability broker on top is ours, and the submission says so
explicitly. Judges reward that; overclaiming a Ledger feature that does not exist would be
caught. Optionally add DMK skills
(`npx skills add ledgerhq/agent-skills -s ledger-dmk-implementation dmk-intent-vocabulary dmk-business-logic`).

### 2.8 The Graph — three products, and a contributed Substreams module

Rust is not a constraint for this team, so the question is purely whether a Substreams module
serves the product. It does — but not where it first looked like it would.

**Where a stream is *not* needed:** the Liquidity Analyst's history. A Messari-conformant
subgraph answers "how has this pool behaved" completely. Authoring an AMM normalization module
would duplicate `pinax-network/substreams-evm` (already 15+ DEX protocols) and nothing in the
demo would consume it differently. That version would be decoration.

**Where a stream *is* the product:** Turnstile's own discovery layer. The market needs to
answer "find me agents selling AMM analysis under $0.05, ranked by settled volume" — across
every ERC-8004-style agent registry, on every chain where one is deployed. That is a
normalization-and-aggregation problem over an **emerging standard**, which is exactly the
shape the track names ("contributing a new composable Substreams module for an emerging
standard... also counts") and exactly the leverage they judge on ("one pipeline reused across
chains"). The Graph already lists Agent0/ERC-8004 subgraphs in the track resources, so the
standard is visibly on their radar.

So:

1. **Substreams module — ERC-8004 / agent-registry normalization.** Rust, published, composable,
   reusable by anyone building agent discovery. Powers Turnstile's registry browse and ranking.
   This is the contributed artifact.
2. **Subgraph — Messari DEX AMM Extended v4.0.1** (Tick/Position entities, concentrated
   liquidity; covers Uniswap v3/v4-style pools). Schema at
   `github.com/messari/subgraphs/blob/master/docs/SCHEMA.md`. Deploy to **Subgraph Studio**.
   Powers the Liquidity Analyst's history — one query pattern spanning many AMMs.
3. **Subgraph MCP** (`github.com/graphops/subgraph-mcp`, or hosted at
   `subgraphs.mcp.thegraph.com/sse`; auth is a Studio Gateway API key as `Authorization: Bearer`).
   How the analyst reads.

Three products composed, a standardized schema adopted rather than invented, and a reusable
module contributed for an emerging standard. Both halves are load-bearing: delete the subgraph
and the analyst has no subject matter; delete the Substreams module and the market has no
discovery. Streaming auth is a **The Graph Market** JWT (`thegraph.market` → Dashboard →
Create New Key). Live Studio/Market data throughout; mocked data disqualifies.

Reference for module structure — read, don't fork: `pinax-network/substreams-evm` (532 commits,
prebuilt `.spkg`s, DB-sink aggregators). `streamingfast/substreams-skills` is a Claude Code
plugin with 16 worked examples; useful as an accelerant, but it is assistant augmentation, not
one-shot NL→deployment. Budget iterative debugging even with it loaded.

---

## 3. Where each sponsor fits

| Sponsor | Role in the product | Load-bearing test — delete it and what breaks? |
|---|---|---|
| **The Graph** $10,000 | Both halves of the market. Messari-standardized subgraph → Subgraph MCP is the seller's knowledge source; an authored ERC-8004 Substreams module is the market's discovery layer. Shipped as MCP server + `SKILL.md`. | The analyst has nothing to sell *and* buyers cannot find sellers. |
| **Hedera** $6,000 | Primary settlement rail. Live x402 service via Blocky402; rail advertised in the ENS record; HCS receipts. | No per-call payment. The market has no meter. |
| **ENS** $4,500 | The registry itself. Own subname registry under `turnstile.eth`, EAC cold/hot split, ENSIP-25/26 records. | No discovery, no identity, no cold/hot separation. |
| **Ledger** $3,500 | The cold tier. Seals the seller's upstream credentials; the VPS decrypts with no device. | The seller's API key sits in plaintext `.env` on a host. |
| **Chainlink** $2,000 | The enclave. Seller's method + credentials never leave. | A seller with real edge has no reason to list. This is the economic keystone. |
| **World** $3,500 | The abuse model. Nullifier ↔ cold key; N listings per human; step-up on rotation. | One human runs 200 seller names. It is a Sybil farm. |
| **Arc** $5,167 | The hot tier + second rail. Agent wallet, Paymaster (zero native), nanopayments for sub-cent queries. | Per-query pricing is uneconomic; only one rail exists. |
| **Privy** $5,000 | The warm tier. Buyer org wallet, mandate policy, quorum to raise a cap. | The mandate has nowhere to live; buyers hand agents a key. |
| **Uniswap** $3,000 | The thing being sold. Standardized AMM subgraph, `uniswap-mcp` + SKILL reusable standalone, plus a PR upstream. **No v4 hook.** | The flagship seller has no subject matter. |
| **Bazantic** $1,000 | Opportunistic. Register the existing x402 gateway; one Recipe chaining Uniswap API → Graph. | Nothing. Genuinely additive, ~half a day. |

Claimed exposure: **$38,667** across 12 submissions.

---

## 4. Qualification checklist

Every row is a binary disqualifier. **This is `CHECKLIST.md` in the repo from day 1.**

### Day 1 — external dependencies with human latency

| # | Gate | Sponsor |
|---|---|---|
| 1 | Request World ID **Sandbox access** — https://forms.gle/mqbaiwMvX5MzmKdY8. Human-approved form, unknown turnaround, blocks all World work | World |
| 2 | Create **Subgraph Studio** account + Gateway API key | The Graph |
| 2b | Create **thegraph.market** account + JWT (Dashboard → Create New Key) for Substreams streaming | The Graph |
| 3 | Create free **CRE account** at app.chain.link/cre/discover — required for *any* CLI command including `simulate`. Self-serve, no queue | Chainlink |
| 4 | Install CRE CLI: `curl -sSL https://app.chain.link/cre/install.sh \| bash`, plus Bun | Chainlink |
| 5 | `npm i -g @ledgerhq/wallet-cli`; run `wallet-cli genuine-check` and `ring init` **with the device attached** — this is the only step that needs hardware | Ledger |
| 6 | Create **portal.hedera.com** account + ECDSA testnet accounts (1,000 HBAR/24h × up to 5) | Hedera |
| 7 | Create **bazantic.com** account | Bazantic |
| 8 | ⚠️ **Get real ENSv2 Sepolia addresses** — clone `ensdomains/contracts-v2` and grep `broadcast/<script>/11155111/run-latest.json`. Do **not** trust doc-scraped addresses; the ones found on 09-04 could not be corroborated and may be fabricated | ENS |
| 9 | Ask Discord: is `sponsor_sdks: up to three` a real cap? (Not in the global rules) | ETHGlobal |
| 10 | Ask Discord: does Arc "deployment-ready by 30 Sep" accept testnet + mainnet config? ($3,500) | Arc |
| 11 | `git init` **at kickoff**, public repo, first commit dated in-window | All |

### Continuous

| # | Gate |
|---|---|
| 12 | **Commit every day.** 1inch disqualifies final-day single-commit dumps; ETHGlobal audits history generally |
| 13 | Append to **`FEEDBACK.md`** every time we hit a Uniswap rough edge |
| 14 | Append to **`WORLD-FEEDBACK.md`**: docs + integration flow, Developer Portal navigation/search/discovery/debugging, Sandbox states, proof flows, test users, errors, edge cases, what was confusing/missing/broken |
| 15 | Capture **every on-chain tx the first time it works** — HashScan links, tx hashes, terminal output |

### Per-submission

**The Graph — Composable ($5,000)**
- [ ] Compose ≥2 Graph products **or** build on a standardized schema
- [ ] **Live** data from a Graph provider. Mocked/local-only/static **disqualifies**
- [ ] A single subgraph query with no composition **does not qualify**
- [ ] Show what became easier because of the shared schema
- [ ] Public repo + video **2–4 min**

**The Graph — AI, From Scratch ($5,000)**
- [ ] Select the **Start Fresh** pool on submission
- [ ] Graph load-bearing as the live data source
- [ ] Meaningful work — reasoning/decisions/automation/NL interface, not a raw query dump
- [ ] Tooling must be **reusable infrastructure**, not one end-user app
- [ ] Clear `README` **or** `SKILL.md` so judges can run it
- [ ] Public repo + video 2–4 min

**Hedera — Agentic Payments ($6,000)**
- [ ] Live x402-gated service on Hedera testnet or mainnet
- [ ] Settled through **Blocky402** specifically
- [ ] ≥1 **real paid request end to end**
- [ ] README covering setup, architecture **and the payment flow**
- [ ] Video **≤5 min** showing the paid request executing
- [ ] Free extra points: ERC-8004/HCS-14 identity, HCS audit trail, HTS custom fees, Scheduled Transactions

**ENS — ENSv2 ($4,500)**
- [ ] ENSv2 on **Sepolia**; features **central, not cosmetic**
- [ ] Demo functional, **no hard-coded values**
- [ ] Video **and/or** live demo link (ideally both); open source

**Arc — Agentic ($1,667) + Launch ($3,500)**
- [ ] **State explicitly which bounty** each submission targets
- [ ] Working **frontend and backend**
- [ ] **Architecture diagram** (§2.1 + §2.2)
- [ ] Video + presentation + detailed docs; GitHub link
- [ ] Launch track: deployed or **deployment-ready on Arc mainnet by 30 Sep**

**World — Selfie Check ($3,500)**
- [ ] Selfie Check used meaningfully as a **risk/eligibility/fairness/abuse-prevention** signal, not a login
- [ ] Working app, tested via the **Sandbox App**
- [ ] **Feedback document** (item 14)

**Ledger ($3,500)**
- [ ] Built on the Ledger Agent Stack, **in particular `wallet-cli ring`**
- [ ] Device-backed security **central**, not bypassed
- [ ] Submission explicitly labels the capability broker as **ours**, not a Ledger primitive

**Uniswap ($3,000)**
- [ ] Public repo, open source
- [ ] **`FEEDBACK.md`** in the repo
- [ ] **Submitted** the form at https://developers.uniswap.org/hackathon-feedback **with the link to FEEDBACK.md**
- [ ] README points at the relevant contracts and lines of code

**Chainlink ($2,000)**
- [ ] CRE Workflow using Confidential Workflows for a **meaningful** part of the app
- [ ] Registers and uses `cre.handlerInTee`
- [ ] Processes ≥1 real sensitive input inside the enclave
- [ ] A placeholder handler or isolated example **explicitly does not qualify**
- [ ] Evidence: `cre workflow simulate my-workflow --target staging-settings --non-interactive --trigger-index 0` terminal output, or live deployment
- [ ] Use **CRE**, not Functions or Automation (deprecated)

**Privy ($5,000)**
- [ ] Privy **core**; ≥1 Privy wallet; **≥1 Privy control** (policies, signers, key quorums, intents)
- [ ] B2B: org use case + ≥1 functional workflow (payment, approval, treasury op, wallet admin)
- [ ] Financial flow: ≥1 functional flow on a **generally available** feature
- [ ] Working demo + source + explanation of how Privy enables it

**Bazantic ($1,000)**
- [ ] Account + an **x402/MPP Gateway** for our project
- [ ] ≥1 other service already on Bazantic or from an ETHOnline sponsor
- [ ] Recipe using **both**, final result depends meaningfully on both
- [ ] Screen recording start to finish
- [ ] **Bazantic username in the submission** for attribution

### Explicitly not doing

1inch Aqua · Hedera ATS · Hedera Harness as the product (side PR only) · Arc DeFi pool ·
Uniswap v4 hook · Bazantic "Agentify a new API" · Chainlink liquidation challenge (requirements
still "coming soon") · every Continuity prize.

---

## 5. Sequencing and cut lines

### Step 0 — run `/ralph-planning` first

**Before any code, run `/ralph-planning` against this document.** It breaks the plan into
ordered Linear issues with mini-plans, acceptance criteria, files to touch, and dependency
relations, under a Linear project for ETHOnline 2026.

This is not ceremony. Twelve submissions across eleven sponsors over twelve days is precisely
the shape that goes wrong when it lives in one person's head — and the checklist in §4 is a
dependency graph, not a list. `/ralph-planning` gives it issue IDs, so `/ralph-implement` can
run the loop afterwards and each unit gets a fresh-context subagent.

Seed it with:
- §4's day-1 items as the first, unblocked issues — several have external human latency (the
  World Sandbox form, ENSv2 address verification) and must be in flight before anything depends
  on them
- §2's components as the implementation issues, with §5's phases as the dependency ordering
- Each per-submission checklist in §4 as acceptance criteria on the matching issue, so a gate
  cannot be forgotten — it fails the issue
- The cut lines below as explicit priority ordering on the Linear issues

### Then

**Days 1–2 — checklist + skeleton.** Every day-1 item above. `git init`, repo layout, CI.
Nothing else starts until items 1–11 are done or blocked-with-a-reason.

**Days 2–6 — the spine.** $19,500 sits here; nothing else starts until it runs end to end.
1. Graph: Messari-conformant subgraph live on Studio + Subgraph MCP querying it
2. Hedera: x402 service + one real paid request through Blocky402, on camera
3. ENS: subname registry on Sepolia + EAC cold/hot split, hot key reverting on payout change

**Days 4–8 — the Substreams module.** ERC-8004 agent-registry normalization, Rust, published as
a `.spkg`, streaming via a Graph Market JWT. Runs parallel to the spine rather than inside it:
it powers discovery, not the core paid-request path, so a delay here does not block the demo.
Ships against ≥2 chains' registries — "one pipeline reused across chains" is the judging line.

**Days 5–8 — identity and cold tier.** World Selfie Check + Ledger Key Ring. One surface (who
may do what), so build them together. $7,000.

**Days 6–10 — rails and the seller.** Arc (agentic + launch) + Uniswap contributions. $8,167.
Arc is a second facilitator stack, not an extension of Hedera — budget a full day.

**Days 8–11 — the enclave and the warm tier.** Chainlink CRE (start no later than day 8; 1–2h
to get the template simulating, 4–8h for a real custom workflow) + Privy. $7,000.

**Days 11–12 — Bazantic, videos, submissions.** Bazantic is ~half a day. Videos are not an
afterthought: Graph wants 2–4 min, Hedera and Ledger ≤5 min, Arc wants a presentation.

### Cut lines, decided now so they are not decided at 3am

1. **Bazantic** goes first. Purely additive.
2. **Privy** second — it is the warm tier, and the mandate can degrade to a plain policy object
   held server-side. Costs $5,000, the largest single cut.
3. **Arc's Launch track** third — keep the Agentic submission, drop the mainnet-readiness work.
4. **Chainlink** fourth. It hurts, because it is the economic keystone of the pitch, but the
   story survives as "the seller's method stays private" narrated over the architecture.
5. Never cut: Graph, Hedera, ENS. Those three are the product.

One **degradation**, not a cut: if the ERC-8004 Substreams module is not streaming by day 9,
fall back to consuming a prebuilt `pinax-network/substreams-evm` `.spkg` for the composability
claim. That still satisfies "compose two or more products" but forfeits the "contributed a
reusable module for an emerging standard" credit the track actually rewards — so it is a
last resort, not a plan B to reach for early.

---

## 6. Verification

**Per-component, as built:**
- Graph, subgraph — query it through Subgraph MCP with a real Studio key; assert live data (a
  block number within minutes of now). Screenshot the Studio dashboard.
- Graph, Substreams — `substreams run` the published `.spkg` against a Graph Market JWT and show
  agent registrations streaming from **two different chains** through the same module. Publish
  the package and link it in the README; a module nobody can reuse is not a contribution.
- Hedera — run one paid request end to end; capture the HashScan tx and the HCS receipt.
- ENS — `cast call` the resolver on Sepolia to read back records; assert the hot key's payout
  change **reverts**. No hard-coded names anywhere in the demo path.
- Ledger — `ring encrypt` a secret on the device laptop; `ring decrypt` it on the VPS with no
  device attached and `WALLET_PASS` from the environment. Record both terminals.
- Chainlink — `cre workflow simulate ... --non-interactive --trigger-index 0`; save terminal
  output showing the TEE constraint, the secret reaching the API, and the verdict.
- Arc — frontend and backend both running; architecture diagram exported.
- World — full Selfie Check flow through the Sandbox App; a second listing attempt from the
  same nullifier rejected.
- Privy — issue a mandate, raise a cap through quorum, show the agent wallet spending inside it.

**End to end, the demo (~4 min):** an agent cannot buy one answer without an API key →
`liquidity.turnstile.eth` resolves, rails `[hedera-x402, arc-usdc]`, hot-key payout change
rejected → Selfie Check, listing 1 of 3, listing 4 rejected → same query on two rails: Hedera
x402 tx, then Arc USDC with Paymaster and hot-wallet native balance 0 → premium tier: verdict
comes from an attested enclave, method never leaves → close on "this is just an MCP + SKILL,
every piece works without us."

**Pre-submission:** walk `CHECKLIST.md` top to bottom with a second pair of eyes. The Uniswap
form and the two feedback documents are worth $6,500 combined and take minutes.

---

## 7. Git workflow — mandatory

We move fast with AI assistance, so the history has to be built as we go rather than
reconstructed. **ETHGlobal audits repo history, and 1inch explicitly disqualifies
"single-commit entries on the final day."** This structure produces a legible per-feature
history as a side effect of working normally.

| Branch | Role |
|---|---|
| `main` | Submission branch. What judges read. Only receives `--no-ff` merges from `dev` at milestones. |
| `dev` | Local integration branch. Everything lands here first; always runnable; the demo runs against it. |
| `feat/mov-2XX-slug` | One per Linear issue, one worktree each. Pushed to the remote — this *is* the per-feature history. |

### Loop, per issue

```bash
# 1. Branch from dev, never from main
git worktree add ../turnstile-mov-215 -b feat/mov-215-messari-subgraph dev
cd ../turnstile-mov-215
ln -s ../turnstile/.env .env          # .env is gitignored, so it does NOT follow the worktree

# 2. Work. Commit granularly — small, real messages. Never one squashed dump.

# 3. Push the feature branch. This is the history judges see.
git push -u origin feat/mov-215-messari-subgraph

# 4. Integrate locally, preserving the feature boundary
cd ../turnstile && git merge --no-ff feat/mov-215-messari-subgraph

# 5. Clean up
git worktree remove ../turnstile-mov-215
```

Merge `dev` → `main` with `--no-ff` at milestones, and push. **Push something every day**,
even mid-feature.

### Rules

1. **Never commit directly to `main`.** It only ever receives merges.
2. **Always `--no-ff`.** A fast-forward flattens the feature boundary and destroys the
   legibility this structure exists to produce.
3. **Branch worktrees from `dev`**, so each feature stacks on accumulated work rather than
   diverging from an ancient `main`.
4. **One branch per worktree.** Git refuses to check out the same branch twice.
5. **Feature branches stay on the remote after merging** — deleting them deletes the history
   we are building.

### Gotchas at this pace

- **`.env` does not follow a worktree** (gitignored). Symlink it as step 1 or the worktree
  fails at runtime. `seller/secrets/*.enc` *is* tracked and does follow.
- **Per-worktree installs are expensive.** Set `CARGO_TARGET_DIR=~/.cache/turnstile-target`
  globally and use a pnpm store, so six worktrees do not mean six full builds.
- **`merge=union` is for appending, not editing.** `.gitattributes` sets it on `CHECKLIST.md`,
  `FEEDBACK.md` and `WORLD-FEEDBACK.md` so two worktrees appending in *different* places both
  land. But union merge only engages on a hunk both sides touched, and when it does it keeps
  **both** versions instead of raising a conflict — so two branches editing the same line
  produce a silent duplicate, not an error. That is worse than a conflict, because a conflict
  is loud. Append at the end. To change an existing line, route it to a single owner and have
  everyone else stand down.
- `rails/PaymentRail.ts` is the shared seam most likely to conflict. Land **MOV-219** and merge
  it to `dev` **before** starting the two rail implementations in parallel.
- The workflow must live in the turnstile repo's own `CLAUDE.md`, not only in Linear —
  `/ralph-implement` subagents working inside a worktree read the repo, and will otherwise
  commit straight to `dev`.
