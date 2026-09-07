# Turnstile — qualification checklist

Verbatim copy of §4 of `plan/turnstile-v3.md`. Every row is a binary
disqualifier. Append-only (`merge=union`) — tick boxes, never rewrite lines.

> ⚠️ **The repo is PRIVATE right now, on purpose.** It must be flipped to
> public before submitting or all 12 submissions fail. See
> [Before submitting](#before-submitting--blocks-all-12-submissions) at the
> bottom of this file.

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
| 8 | ✅ **Real ENSv2 Sepolia addresses** — done (MOV-212). All 31 verified against live `eth_getCode`; zero bytes differ outside declared `immutableReferences` slots. Recorded in `contracts/addresses.sepolia.json`, method and caveats in `docs/ensv2-notes.md`. Artifacts are **rocketh/hardhat-deploy** at `contracts/deployments/sepolia/<Name>.json` — there is no Foundry `broadcast/`. Pinned to the 2026-06-29 deploy, not permanent: re-check before deploying, and `contracts/test/fork/SepoliaEnsV2.t.sol` is the canary | ENS |
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
| 16 | Repo is **private during the build**. Flipping it to public is the last step before submitting — see [Before submitting](#before-submitting--blocks-all-12-submissions) |

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
- [x] ENSv2 on **Sepolia**; features **central, not cosmetic** — done (MOV-217 + MOV-218). Registry, registrar and a `PermissionedResolver` live on Sepolia; `liquidity.turnstile.eth` minted with ENSIP-25/26 records and a cold/hot EAC role split enforced by the resolver. Tx hashes and on-chain reads in `docs/ens-offer-records.md`
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

### Before submitting — blocks all 12 submissions

The repo is deliberately **private** for the 12 build days, to keep the ERC-8004
Substreams module and the "sell the answer, keep the method" framing out of view
of other teams. Flipping visibility preserves the full commit history, so the
ETHGlobal and 1inch history audits are unaffected — but the flip is not optional
and nothing else on this list survives forgetting it.

- [ ] **Before submitting: `gh repo edit IpastorSan/turnstile --visibility public`** — every sponsor requires a public repo; a private repo fails all 12 submissions.
- [ ] Confirm it took: `gh repo view IpastorSan/turnstile --json visibility`
- [ ] Open the repo URL in a logged-out browser before pasting it into any submission form.

### Explicitly not doing

1inch Aqua · Hedera ATS · Hedera Harness as the product (side PR only) · Arc DeFi pool ·
Uniswap v4 hook · Bazantic "Agentify a new API" · Chainlink liquidation challenge (requirements
still "coming soon") · every Continuity prize.

### MOV-217 — ENSv2 registry + registrar (2026-09-04)

Gate 8 is ticked in place. The ENS bounty lines below it are not, because they
are not yet true — nothing is deployed. Union merge only rewrites a line when
both sides changed it, so a single owner editing a row is safe; two are not.

- Gate 8 is ticked above. It is now **continuously** verified rather than
  verified once: `contracts/test/fork/SepoliaEnsV2.t.sol` asserts
  `RootRegistry.getSubregistry("eth")` still returns `0x67b7…4b43` on every
  `forge test`. Passing as of 2026-09-04 — ENS has not redeployed.
- ENS "features central, not cosmetic": contracts and tests are done, 37 passing.
  Still **open** — nothing is deployed, because there is no funded Sepolia key
  (MOV-211).
- ENS "no hard-coded values": ENS addresses are read from
  `contracts/addresses.sepolia.json` at run time by `script/EnsSepolia.sol`, not
  compiled in. A redeploy is a one-file regeneration.
- Blocking: buy `turnstile.eth` through the paid `ETHRegistrar` commit/reveal
  flow. It is currently `AVAILABLE` with no owner (checked on-chain 2026-09-04),
  and we hold no `ROLE_REGISTRAR` on ENS's `.eth` registry — asserted by
  `testFork_weHoldNoRegistrarRoleOnTheEthRegistry`.
- Run book: `docs/ensv2-deploy.md`. Deployment estimate 0.0057 ETH.

### MOV-221 — ERC-8004 agent-registry Substreams (2026-09-07)

Nothing is ticked in place. The Graph rows above are shared with MOV-215
(subgraph), and union merge turns two branches editing one line into a silent
duplicate rather than a conflict — so the Graph block needs a single owner.
Here is what is now true, for whoever ticks it:

- **"Live data from a Graph provider"** — satisfied. `graph/substreams/`
  streams the ERC-8004 Identity Registry live through the Graph Market JWT on
  Ethereum mainnet, Base, Sepolia and Base Sepolia. Nothing mocked, nothing
  local. Run output and TraceIDs in `docs/erc8004-substreams.md`.
- **"Build on a standardized schema"** — satisfied. The module is authored
  against EIP-8004 and names its fields after the standard and the Agent0
  subgraph schema (`agentId`, `agentURI`, `owner`, `agentWallet`,
  `x402Support`, `supportedTrust`) rather than inventing terms.
- **"Compose ≥2 Graph products"** — Substreams is one. Pairing it with the
  subgraph is MOV-215's half; this branch does not claim it.
- **"Reusable infrastructure, not one end-user app"** — satisfied.
  `erc8004-agent-registry-v0.1.0.spkg` is committed and runs standalone, with
  no checkout: `substreams run <spkg> map_agent_registrations --network base`.
  `graph/substreams/README.md` documents the message shape for third parties.
- **Still open:** `substreams registry publish` to substreams.dev. It needs an
  interactive browser login, and publishing now would expose the module during
  the private build window. It belongs with the repo visibility flip in
  **Before submitting**, not before it.
### MOV-218 — offer records + cold/hot role split (2026-09-07)

The first ENS bounty line above is ticked in place — one owner, per MOV-217's
note. The second is left open on purpose.

- ENS "features central, not cosmetic": **now true and deployed.**
  `liquidity.turnstile.eth` is live on Sepolia with an offer written in
  ENSIP-26 (`agent-context`, `agent-endpoint[mcp]`) and ENSIP-25
  (`agent-registration[<erc7930>][10127]`) keys, and the seller's hot key is
  authorized on exactly two of those records by ENS's own
  `PermissionedResolver`. The hot key's attempt to move the payout address
  reverts on-chain. Full transcript: `docs/ens-offer-records.md`.
- ENS "no hard-coded values": also covers **names**, not just addresses.
  `src/TurnstileName.sol` walks `IRegistry.getParent()` up the hierarchy to
  derive the full name, its DNS encoding and its namehash at run time.
  `test_derivedNameFollowsAReparent` re-parents the registry and asserts the
  namehash moves with it. The seller label comes from `TURNSTILE_SELLER_LABEL`.
- ENS "demo functional" is still **open**: the MCP endpoint in
  `agent-endpoint[mcp]` is a placeholder host until MOV-219/220 land the real
  service. The record is real; nothing answers on it yet.
- ERC-8004 (free extra points on the Hedera line, and the Substreams module's
  subject): agent `10127` registered in the Sepolia `IdentityRegistry`
  `0x8004A818BFB912233c491871b3d84c89A494BD9e`, `tokenURI` pointing back at
  `liquidity.turnstile.eth`, so the ENSIP-25 link reads the same from both ends.
- `forge test`: 66 passing, including 7 fork tests that assert the *live*
  deployment still has the offer and still denies the hot key the payout record
  (`contracts/test/fork/SepoliaOffer.t.sol`).
### MOV-215 — Messari-conformant subgraph (2026-09-07)

Appending rather than ticking the three **Composable** rows in place. MOV-217's
note is right that a single owner editing a row is safe — but Composable is a
joint gate between this issue and the Substreams work, so I am not its single
owner. Whoever closes both should tick rows 45–47 in one commit.

- "Build on a standardized schema" — **satisfied**. `graph/subgraph/schema.graphql`
  is Messari DEX AMM (Extended) v4.0.1, copied verbatim from `messari/subgraphs`.
  The only edit is `@entity` → `@entity(immutable: false)` on 12 bare
  occurrences, forced by graph-cli ≥ 0.90 and semantics-preserving. No entity or
  field name differs from the standard.
- "A single subgraph query with no composition does not qualify" — **satisfied**.
  `graph/subgraph/queries/cross-protocol.graphql` runs byte-identical against
  four AMMs by four different teams on two chains (Uniswap v3 Arbitrum,
  Sushiswap v3, Sushiswap v2, Curve). `scripts/run-query.sh` re-runs it;
  `samples/` holds the responses.
- "**Live** data from a Graph provider" — **satisfied for the query artifact**,
  via the decentralized gateway. Samples captured at mainnet block 25925032
  (2026-09-07T10:58:23Z), 14s before the sweep finished. Nothing mocked, local
  or static anywhere in this directory.
- **Open**: our own subgraph is built and its IPFS bundle uploads
  (`QmS97mesuaXzXePGmD4JXvGRQ7tbMYtCzukYSzZj2qUWfA`), but Studio returns
  `Subgraph not found` — a deploy key can deploy to a subgraph, it cannot create
  one, and Studio's `createSubgraph` wants a wallet signature. Someone with the
  Studio account must create the slug `turnstile-uniswap-v3-messari` once; the
  deploy then succeeds unattended. Details in `graph/subgraph/README.md`.
