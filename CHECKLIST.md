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
