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
| 3 | ✅ **Free CRE account** — done (MOV-227). `cre login` writes `~/.cre/cre.yaml`; `cre whoami` confirms org `org_Js0Ll47RXcQ17Uk6`, **Deploy Access: Not enabled**. Confirmed self-serve, no queue, and confirmed sufficient for `simulate`. **`CRE_API_KEY` is NOT the credential** — the key in `.env` is a Data Streams one and breaks every command; see `docs/accounts.md` | Chainlink |
| 4 | ✅ **CRE CLI + Bun** — done (MOV-227). `cre` v1.32.0 from the `smartcontractkit/cre-cli` GitHub release at `~/.local/bin/cre`; Bun 1.3.14 already present | Chainlink |
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
- [x] Tooling must be **reusable infrastructure**, not one end-user app — done (MOV-229). `mcp-turnstile` is four MCP tools with no code path for any particular seller. Proven rather than asserted: `mcp-turnstile/examples/discover-pay-reason.ts` runs the same buyer against two unrelated sellers, and `mcp-turnstile/examples/stranger-seller.test.ts` pins it offline in CI
- [x] Clear `README` **or** `SKILL.md` so judges can run it — done (MOV-229). `mcp-turnstile/SKILL.md`: `npx -y mcp-turnstile`, the four tools, the credential ledger, what the tools do not know, and five things a judge should try to break. The published tarball carries the 197-agent snapshot, so it answers a real query with an empty environment
- [ ] Public repo + video 2–4 min

**Hedera — Agentic Payments ($6,000)**
- [x] Live x402-gated service on Hedera testnet or mainnet — done (MOV-220). `exact` on `hedera:testnet`, native HBAR, priced off Hedera's own network exchange rate
- [x] Settled through **Blocky402** specifically — done (MOV-220). `https://api.testnet.blocky402.com`, `/supported` → `/verify` → `/settle`, no API key
- [x] ≥1 **real paid request end to end** — done (MOV-220). `0.0.7162784@1788791855.758948636`, 0.84367844 HBAR ($0.07) from `0.0.10408012` to `0.0.10403961`, buyer gas zero. Mirror node record and HashScan link in `docs/payment-flow.md`
- [x] README covering setup, architecture **and the payment flow** — done (MOV-220). `docs/payment-flow.md`
- [ ] Video **≤5 min** showing the paid request executing — `node scripts/hedera-paid-request.ts` is the take; not recorded yet
- [ ] Free extra points: ERC-8004/HCS-14 identity, HCS audit trail, HTS custom fees, Scheduled Transactions — **HCS audit trail done** (MOV-220), topic `0.0.10408013`, one message per settled payment, read back through the public mirror node with no key. The other three not attempted

**ENS — ENSv2 ($4,500)**
- [x] ENSv2 on **Sepolia**; features **central, not cosmetic** — done (MOV-217 + MOV-218). Registry, registrar and a `PermissionedResolver` live on Sepolia; `liquidity.turnstile.eth` minted with ENSIP-25/26 records and a cold/hot EAC role split enforced by the resolver. Tx hashes and on-chain reads in `docs/ens-offer-records.md`
- [ ] Demo functional, **no hard-coded values**
- [ ] Video **and/or** live demo link (ideally both); open source

**Arc — Agentic ($1,667) + Launch ($3,500)**
- [x] **A live agentic payment on Arc** — done (MOV-225). USDC on Arc testnet (`eip155:5042002`) through **Circle Gateway Nanopayments**, `@circle-fin/x402-batching@3.4.0`, facilitator `https://gateway-api-testnet.circle.com` with no API key. Seven payments settled 2026-09-07 — one at $0.07 and six at $0.000500 — from agent `0x0633a193017939Bb1eB242982397224c66948e2F`, whose **nonce stayed 0 throughout**: it signs EIP-3009 authorizations offchain and never submits a transaction, so it paid exactly zero gas. Transcript and verified/unverified table in `docs/arc-nanopayments.md`
- [x] **The same query settles over both rails** — done (MOV-225). One run, one URL: Arc returned authorization `fa4ca648-863c-4f61-9a1e-2953eb789f7f`, Hedera returned `0.0.7162784@1788800327.098234984`, same verdict both times. `seller/service/no-chain-code.test.ts` fails the build if any file on the payment path names a chain, so this is enforced rather than asserted
- [x] **Nanopayments, batched, with the transaction as evidence** — done (MOV-225). Six $0.000500 queries and the $0.07 query settled in **one** Arc transaction, [`0xd6e77a59ad4740e5f89c9c601a05e7cf7859c9253fb1b3c31a8eae97e859a0c1`](https://testnet.arcscan.app/tx/0xd6e77a59ad4740e5f89c9c601a05e7cf7859c9253fb1b3c31a8eae97e859a0c1) — block 60940635, 22 payments in it including other Gateway users', 0.133111 USDC, `from` = Circle's batcher `0xc73ef0d8…a884`, `to` = the GatewayWallet. A second run settled four more in [`0xe50b8be6…5c39`](https://testnet.arcscan.app/tx/0xe50b8be63a2fe102c70de3b62a43251fbfcac1d8ca93f9f1760dd3c7a7985c39) (block 60942503) — eleven settled payments in two transactions. Both runs' six-minute inline poll **expired before the batch landed**: Circle's batcher fires on its own schedule (2 to 15 minutes observed on one afternoon). **Do not script a demo around a fixed window** — run `npm run arc:receipts -- --ours --watch` as a second step
- [ ] **State explicitly which bounty** each submission targets
- [x] Working **frontend and backend** — done (MOV-230). Next.js 16 app in `web/`: market and seller pages server-rendered, plus `/api/sellers`, `/api/offer/:name` and `/api/health` as real routes over the discovery store and live Sepolia. Not a static export. **Still not deployed** — see `docs/deploy.md`
- [x] **Architecture diagram** (§2.1 + §2.2) — done (MOV-230). `docs/architecture.svg` + `.png`, embedded in `README.md`, walked through in `docs/architecture.md`. Panel A the cold/warm/hot key tiers, Panel B discovery → offer → 402 → rail → answer
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
- [x] **`FEEDBACK.md`** in the repo — MOV-216 (Trading API 401-behind-validation, the QuoterV2 `view` quirk, a 301-to-404) and MOV-226 (the v4 quoting guide's ethers v6/v5 contradiction, the same bug in `Uniswap/uniswap-ai`, V4Quoter dropping `initializedTicksCrossed`, plus what worked well). Owner: MOV-226.
- [ ] **Submitted** the form at https://developers.uniswap.org/hackathon-feedback **with the link to FEEDBACK.md** — **BLOCKED ON IGNACIO, not on an agent.** It is a browser-only React form (no login, but no POST endpoint either) whose required fields include his email, his Telegram handle, and a Uniswap Labs ToS agreement. **It is downstream of two other steps** — `dev`→`main` and the visibility flip — sequenced under [Before submitting](#before-submitting--blocks-all-12-submissions). Paste-ready answers, including the exact permalink: `docs/uniswap-feedback-form-answers.md`.
- [x] README points at the relevant contracts and lines of code — `README.md` has a **Uniswap contributions** section linking all three, and `docs/uniswap-contributions.md` gives the code path and the evidence for every claim. Owner: MOV-226.

**Chainlink ($2,000)**
- [x] CRE Workflow using Confidential Workflows for a **meaningful** part of the app — MOV-227. It *is* the premium tier: `seller/service/premium.ts` has no other source of an attested verdict.
- [x] Registers and uses `cre.handlerInTee` — `seller/cre/analyst-verdict/workflow.ts`, constrained to `{ tee: 'nitro', regions: ['us-west-2'] }` rather than `{}`
- [x] Processes ≥1 real sensitive input inside the enclave — **two**. A Vault DON secret carrying the seller's calibration (9 threshold overrides, the method itself), and a 9,218-byte evidence bundle fetched over confidential HTTP behind a second Vault-held bearer token. Pointed at an endpoint expecting a different token the workflow aborts with `evidence fetch failed with status 401`, so both are load-bearing.
- [x] A placeholder handler or isolated example **explicitly does not qualify** — the enclave runs MOV-216's real 970-line scorer over real Uniswap data, and the sealed calibration changes the verdict: public says ACCEPTABLE on USDC/WETH 0.05%, the enclave says CAUTION.
- [x] Evidence: `cre workflow simulate` terminal output — `docs/cre-confidential-workflow.md`, three full runs including the negative case.
- [x] Use **CRE**, not Functions or Automation (deprecated) — `@chainlink/cre-sdk@1.18.0`, `cre` CLI v1.32.0. Neither Functions nor Automation appears anywhere.
- [ ] ⚠️ **Not** a live deployment, and not claimed as one. `cre account access` (2026-09-07): "Deployment access is not yet enabled for your organization", and Confidential Workflows is separately in private beta. The simulator runs the write path but returns a zero tx hash. `VerdictConsumer` is deployed and Etherscan-verified on Sepolia at `0xfE95CD0f710DDC5ceED0e93c4e25412Dc3d8eEeA` gated on the real CRE Forwarder, waiting for the DON. Owner: whoever gets deploy access should run `cre workflow deploy`, then `setExpectedAuthor` + `setExpectedWorkflowId`.

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

### Endgame sequence — go-public is deliberately late, but not last-minute

Everything stays private as long as possible. The constraint is not secrecy versus
convenience, it is that **three of these steps depend on each other** and the first-ever
real deploy must not happen on the final day.

**Sept 13 — rehearsal deploy, then tear it down.**
Cheap insurance, ~30 minutes. MOV-230 already found three bugs that appear *only* in the
production bundle and not in dev: `node:sqlite` null-prototype rows that rendered the market
page **completely blank** with the error only in the server log, `schema.sql` missing from the
trace, and the DB opened read-write. Those were caught by running the bundle in an isolated
directory. A real platform can still surface its own. Deploy, confirm it serves all 197 agents
and reads Sepolia live, delete it. Preview URLs are unguessable, so exposure is ~zero.

**Sept 14 — real deploy, stays up.** Then, **on camera**, the **hot key** updates
`agent-endpoint[mcp]` to point at it.

That record currently resolves to `https://mcp-eu.turnstile.xyz/…`, which **has no DNS
record** (MOV-229, re-verified 2026-09-07). The seller service is real and runs from the repo;
the hosted address does not exist. A judge who reads only the ENS record finds nothing to pay,
so this is a live gap in the ENS submission rather than a cosmetic one.

Fixing it *is* the demo beat: the hot key may move where the service lives and may **not**
touch the payout address, so the transaction that repairs the gap is the same one that
demonstrates the cold/hot split. Pair it with the rejected `setAddr` from the hot key and the
ENS story tells itself in two transactions.

Then Then Bazantic registration the same day, which needs the
public `--spec-url` and `--endpoint` plus a browser session (`baz login`). See
`docs/bazantic-gateway.md`.

**Sept 15 — go public, in this order:**

⚠️ **Correction (2026-09-07, MOV-226).** This block previously began at the visibility flip.
That was wrong and would have been expensive. **`main` is 139 commits behind `dev`, and its
`FEEDBACK.md` is still the original 34-line empty template — zero entries.** `dev` has 312
lines and ten. So flipping visibility without merging first publishes a repo whose
`FEEDBACK.md` is a stub, and the Uniswap link would resolve to **an empty feedback template**.
That is *worse* than the 404 we were guarding against: a 404 reads as "not public yet", an
empty stub reads as "they did not do the work" — arriving exactly when an auditor is checking
whether the link was decoration.

1. **`git merge --no-ff dev` into `main`, and push.** Without this, everything below is
   published against a 139-commit-stale tree.
2. `gh repo edit IpastorSan/turnstile --visibility public`
3. Verify **both** — the first only proves the repo is public and says nothing about what
   `main` contains:
   ```
   curl -s -o /dev/null -w '%{http_code}\n' https://github.com/IpastorSan/turnstile/blob/main/FEEDBACK.md
   git show main:FEEDBACK.md | grep -c '^### 2026'    # expect >= 10
   ```
4. Open the URL logged-out
3. `substreams registry publish` for `graph/substreams/erc8004-agent-registry-v0.1.0.spkg`
4. **Only now** submit the Uniswap feedback form — it requires a link to `FEEDBACK.md`, which
   404s for the reviewer while the repo is private
5. Record videos against the live deployment, deriving live figures on camera

**Sept 16 — submit.**

**What is genuinely lost by waiting:** nothing until Sept 14. The ENS gate reads *"a video
recording **or** link to a live demo (ideally both)"* — the video alone satisfies it. Arc wants
a working frontend and backend *demonstrated*, not hosted. Only Bazantic ($1,000, cut-line #1)
strictly needs public URLs, because its facilitator fetches them server-side.

**What the repo staying private actually protects:** the ERC-8004 Substreams angle and the
sealed-calibration design. The deployed *site* only shows a market page and a seller page —
far less revealing. Worth keeping those two decisions separate rather than treating "go public"
as one switch.

### Before submitting — blocks all 12 submissions
- [ ] **Decide on `docs/manual-steps.md` in git history.** Untracked from the tree as of
      2026-09-07, but still reachable in commit `711c0083` and its merge. Contains **no
      credentials** — machine specifics, the World app ID, the deployer address, Ledger
      audit reasoning. Purging it means rewriting and force-pushing `dev`, which damages the
      per-feature history ETHGlobal audits and 1inch scores. Recommendation: **leave it**.
      Recorded here so the call is made deliberately before the repo goes public, not
      discovered afterwards.
- [ ] **Every live figure in submission copy carries its capture timestamp and block.** Owner:
      whoever writes MOV-232. These numbers *drift* — the same pool's claimed TVL read
      $106.68M, $105.9M and $105.72M within three hours on 2026-09-07, and reachable-within-1%
      moved 0.944% → 0.946%. A bare "$105.9M" in a video or README is wrong by the time a
      judge re-runs it. Either timestamp it ("$105.72M at block 25910956, 2026-09-07") or
      derive it live on camera. Applies to TVL, volume, slippage, agent counts and price-source
      counts alike.
- [ ] **Bazantic gateway + Recipe** (MOV-231). Owner: user, in a browser. Needs `baz login`
      (browser-approval only, no API-key path exists) and **two public HTTPS URLs** for
      `--spec-url` and `--endpoint`, which the public deployment provides. Paste-ready material
      is in `docs/bazantic-gateway.md`; the spec is `seller/service/openapi.yaml`. Recipes are
      web-app only — not in the CLI at all. Record `IpastorSan` as the attribution handle.
      **This is cut-line #1 — drop it rather than let it delay anything else.**



The repo is deliberately **private** for the 12 build days, to keep the ERC-8004
Substreams module and the "sell the answer, keep the method" framing out of view
of other teams. Flipping visibility preserves the full commit history, so the
ETHGlobal and 1inch history audits are unaffected — but the flip is not optional
and nothing else on this list survives forgetting it.

- [ ] **Before submitting: `gh repo edit IpastorSan/turnstile --visibility public`** — every sponsor requires a public repo; a private repo fails all 12 submissions.
- [ ] Confirm it took: `gh repo view IpastorSan/turnstile --json visibility`
- [ ] Open the repo URL in a logged-out browser before pasting it into any submission form.

#### The Uniswap feedback form is downstream of the flip — do these in order

The form at <https://developers.uniswap.org/hackathon-feedback> must carry a link
to `FEEDBACK.md`, and **both steps below change what the reviewer sees when they
click it.** These were two independent rows on this list until MOV-226 coupled
them; nothing encoded the dependency, which is exactly the shape of thing that
gets done out of order at 3am.

- [ ] **1. Merge `dev` → `main` (`--no-ff`) and push.** `main` is the default
      branch, so it is what the permalink resolves to. Verified 2026-09-07:
      `main` was **139 commits behind `dev`** and its `FEEDBACK.md` was still the
      **34-line empty template with zero entries** — `dev`'s is 312 lines with
      eight. A reviewer following the link today would see a stub, which is worse
      than a dead link: a 404 reads as "not public yet", an empty template reads
      as "they did not do the work".
- [ ] **2. Flip visibility** — the two rows immediately above this block.
- [ ] **3. Verify both, in a logged-out browser or private window:**
      ```bash
      curl -s -o /dev/null -w '%{http_code}\n' \
        https://github.com/IpastorSan/turnstile/blob/main/FEEDBACK.md   # want 200
      git show main:FEEDBACK.md | grep -c '^### 2026'                   # want >= 10, not 0
      ```
      The second is the one that matters. A `200` only proves the repo is public;
      it does not prove `main` carries the feedback.
- [ ] **4. Submit the form**, using the paste-ready answers in
      [`docs/uniswap-feedback-form-answers.md`](./docs/uniswap-feedback-form-answers.md).
      The link to paste is exactly
      `https://github.com/IpastorSan/turnstile/blob/main/FEEDBACK.md` — a
      default-branch permalink, **not** a commit-pinned `/blob/<sha>/` URL, which
      would freeze an append-only file and hide every later entry.

**Do not submit the form before steps 1 and 2.** The one exception, stated so the
call does not have to be made under pressure: **if the form closes when the
hackathon does, submit it immediately after step 2 on the same day rather than
waiting for a tidier moment.** Losing $3,000 to a closed form is far worse than
an imperfect sequence, and it can be re-submitted once `main` is current.

Only Ignacio can complete the form: its required fields include his email, his
**Telegram handle** (which appears nowhere in this repo) and a Uniswap Labs Terms
of Service agreement. No agent can supply those. Owner: **user**, in a browser.

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

### MOV-222 — discovery API: find and rank sellers (2026-09-07)

Nothing is ticked in place. The Graph rows are shared with MOV-215 and MOV-221
and need a single owner, per MOV-221's note; the ENS "demo functional" row is
still open for the reason MOV-218 gave. Evidence for all of it:
`docs/discovery-api.md`.

- **"Live data from a Graph provider"** — strengthened, not newly claimed.
  `graph/sink/` consumes the packaged `.spkg` through the Graph Market JWT and
  persists it: **197 real agents from Ethereum mainnet, Base and Sepolia,
  queryable in one result set**, joined on the cross-chain `agent_uid`. No
  fixtures anywhere; the store is rebuilt from the chain by four `sink.ts`
  invocations.
- **"Graph load-bearing as the live data source"** (AI, From Scratch) — the
  discovery API and the `find_sellers` MCP tool have no other source of agents.
  Remove the Substreams feed and there is nothing to rank.
- **ERC-8004 / x402 finding worth putting in the pitch:** of 197 live agents,
  **exactly one has a price anyone can read, and it is ours.** 96 advertise
  `x402Support`, 13 publish an endpoint that can be asked, and none of the 13
  returns a 402. EIP-8004 registration-v1 has no price field. This is the
  concrete case for the ENS leg — an offer published as a resolver record is
  readable whether or not the seller's HTTP endpoint is up.
- **Off-module resolution:** 123 of 151 live agent-card URLs resolved (81.5%),
  taking document coverage from 7.6% in-module to 70.1%. Failures are stored
  with their status, never dropped.
- **Ranking is explicitly a placeholder.** `settlement_receipt` is the MOV-220
  seam and is empty, so results are ordered by registration recency with
  `ranking.placeholder = true` and a note saying the order carries no
  information about business done. A test inserts a receipt and asserts the
  basis flips to `settled_volume` with the flag cleared.
- **World verification (MOV-223) seam:** table present, empty, every agent
  reports `'unknown'` rather than `'unverified'`. Not implemented — still
  blocked on Sandbox approval.
- **Reachable as an MCP tool:** `mcp-turnstile/server.ts` over stdio;
  `find_sellers` verified end to end with a real `tools/list` + `tools/call`.
- `node --test`: 36 passing. Nothing under `contracts/` was touched, so the 66
  `forge test` cases from MOV-218 are unaffected — and Foundry is not installed
  on this machine, so they were not re-run.

### MOV-216 — Liquidity Analyst: Subgraph MCP + Uniswap quotes (2026-09-07)

Nothing is ticked in place. The Graph rows are shared with MOV-215, MOV-221 and
MOV-222 and still need a single owner, per MOV-221's note. Evidence for
everything below is in `seller/analyst/README.md` and reproducible with
`node seller/analyst/analyst-cli.ts --top 3`.

- **"Compose ≥2 Graph products"** — now genuinely satisfied by this branch on
  its own, which the earlier notes could not claim. `seller/analyst/` composes
  **the Subgraph MCP server** (`graphops/subgraph-mcp`, hosted at
  `subgraphs.mcp.thegraph.com/sse`) with **our deployed subgraph**, and reaches
  a third product — the decentralized network's gateway — through the MCP
  server's `execute_query_by_subgraph_id`. Verified live against Messari's
  Uniswap v3 Arbitrum deployment `FQ6JYszEKApsBpAmiHesRsd9Ygc6mzmpNRANeVQFYoVX`
  at Arbitrum block 502,694,066.
- **"Build on a standardized schema"** — strengthened, not newly claimed. The
  analyst runs **one GraphQL document** against our subgraph and against other
  teams' Messari deployments with no branching, so adding a venue is a subgraph
  id rather than an adapter. That is the shared schema paying off on the
  *consumer* side; MOV-215 showed it on the producer side.
- **"Live data from a Graph provider"** — satisfied, and now with a second live
  source to cross-check it. Every verdict prints the subgraph head block and how
  far behind chain head it is, plus the mainnet block its Uniswap quotes were
  taken at. Nothing is fixtured; the tests are offline but they score recorded
  inputs, they do not stand in for the data.
- **"Meaningful work — reasoning/decisions, not a raw query dump"** — this is
  the row the analyst was built for. Output is a rated verdict with seven
  signals, each carrying a claim, the reasoning behind it, and the numbers it
  rests on. The demonstration to use: the top three pools by TVL on our
  subgraph all come back `AVOID`, and the #1 by TVL — a $1.9 trillion
  "USDT/USDT" pool built on a fake 18-decimal USDT at
  `0x83cff3334e2d00d98416ad72fc383b77a242e169` — cannot fill a $1,000 trade.
  A raw query result ranks it first.
- **"Tooling must be reusable infrastructure, not one end-user app"** —
  satisfied. `analyzePool()` is importable with no HTTP server, no database and
  no other part of Turnstile; the CLI is a front end over it, not the product.
  The scoring module is separately importable and pure.
- **"Clear README so judges can run it"** — `seller/analyst/README.md`, with the
  exact commands and real output.

**Uniswap ($3,000) — `FEEDBACK.md` in the repo:** satisfied by this branch.
Four dated entries under *Trading API and QuoterV2 — MOV-216*, each re-verified
before writing, plus a section on what worked well. The **form at
https://developers.uniswap.org/hackathon-feedback is still unsubmitted** and is
a separate row — the file alone does not win the prize.

**Not claimed, so nobody ticks it by mistake:**

- The **Uniswap Trading API is unverified end to end.** It needs an API key we
  do not have (`401 Unauthenticated api key or session`). If a submission says
  "uses the Uniswap API", say **which one**: live depth comes from Uniswap's
  on-chain quoting API, QuoterV2, which is the primary provider by design and
  not a substitute for anything — it measures the one pool an LP would deposit
  into rather than a best route across many, and it is the only source of
  `initializedTicksCrossed`, which the slippage-curve signal is built on.
- The deployed subgraph was **12.6 days behind chain head** at 2026-09-07 13:44
  UTC and still backfilling. Verdicts are honest about it (lag is printed and
  costs confidence), but a demo recorded before it catches up will show a
  two-week-old history beside a current quote. Check `_meta.block.timestamp`
  before filming.
### MOV-230 — web app: market, seller, architecture diagram (2026-09-07)

Two Arc gates ticked in place above (frontend+backend, architecture diagram).
The lines below are appended rather than edited, per the union-merge rule.

- Arc "working frontend and backend": **true, not deployed.** `web/` is a
  Next.js 16 app with three server routes over real data — 197 ERC-8004
  registrations across Base, mainnet and Sepolia, and live ENSv2 resolver reads.
  Verified by running the standalone production bundle in a clean directory:
  197 agents served, seller page read Sepolia at block 11,654,544, zero errors.
- Arc "architecture diagram": **done.** Both required subjects are drawn — the
  three key tiers with the "no upward authority" invariant, and the six-step
  request path. `docs/architecture.md` marks which steps are live (01–02) and
  which are not built (03–06), so the diagram is not read as a claim that the
  settlement half exists.
- ENS "demo functional, no hard-coded values": **half true, and the missing half
  is the deploy.** No ENS name is hard-coded anywhere on the demo path — seller
  identity is read from `contracts/addresses.turnstile.sepolia.json`, `/seller`
  redirects to whatever the manifest names, and the seller page reads every
  record off the resolver per request with nothing cached. What is missing is a
  *functional public demo*: the app is not hosted anywhere.
- ENS "video and/or live demo link": **still open**, and now the single highest
  leverage remaining item for this issue. No hosting credentials exist on the
  build machine (no Vercel, Netlify, Fly or Cloudflare CLI or token), so the
  deploy could not be performed. `web/Dockerfile` and `docs/deploy.md` reduce it
  to one command plus one environment variable, `SEPOLIA_RPC_URL`.
- Two routes are deliberately **not** built and are labelled as such in the app:
  `/onboard` (MOV-223, blocked on World Sandbox approval) and `/mandate`
  (MOV-228, not started). Neither shows invented data. A faked panel would put
  every honest number on the site in doubt, and the Graph tracks disqualify
  mocked datasets outright.
- Re-cut `web/data/discovery.db` (`cd web && npm run snapshot`) close to the
  judging date, so the directory shown is current. It is a committed snapshot of
  the live store, dated in `web/data/provenance.json`.

### MOV-219 — x402 seller service + PaymentRail seam (2026-09-07)

Appending rather than ticking. **Nothing in the Hedera or Arc blocks is ticked
by this issue**, and the reason is worth being exact about: the x402 flow is
real and complete, and both rails are placeholders that settle nothing. A live
402 that moves no value is not "a live x402-gated service".

What exists now, verified by `npm test` (85 passing) and captured in
`docs/x402-service.md`:

- `rails/PaymentRail.ts` — the four-method seam MOV-220 and MOV-225 both
  implement. `rails/README.md` is the contract they read.
- `seller/service/` — Express, two priced tiers over the Liquidity Analyst.
  Unpaid request returns 402 with a well-formed `PAYMENT-REQUIRED` advertising
  **two** rails; a paid request returns 200 with `PAYMENT-RESPONSE`.
- x402 **v2**, verified against the specification two ways: the 402 body passes
  `@x402/core`'s own zod schema, and an **unmodified `@x402/fetch` client**
  completes the flow against our server.
- `buyer/watchdog/pay.ts` — the buyer half, with the mandate cap enforced
  client-side before a signature exists.

**Toward the Hedera block** — these three rows stay open and belong to MOV-220:

- *Live x402-gated service on Hedera testnet or mainnet* — the service is live
  and the Hedera rail is a placeholder. `rails/hedera-x402/` ships with its
  network (`eip155:296`) and asset marked **UNVERIFIED**; which CAIP-2 form
  Blocky402 expects is unknown to us as of 2026-09-07 and must be read off its
  `/supported`.
- *Settled through Blocky402 specifically* — not attempted yet.
- *≥1 real paid request end to end* — **not claimed.** The paid requests in
  `docs/x402-service.md` are against stub rails and say so on the wire.

*README covering setup, architecture and the payment flow* is partly served by
`docs/x402-service.md` and `seller/service/README.md`; MOV-220 should judge
whether that is enough for the Hedera row and tick it, since it owns the row.

**Toward the ENS block** — the *Demo functional, no hard-coded values* row is
still open and unchanged by this issue. `agent-endpoint[mcp]` on
`liquidity.turnstile.eth` still points at a placeholder host; MOV-219 built the
HTTP service, not the MCP endpoint that record advertises, and nothing is
deployed. MOV-218's note on that row remains accurate.

Two supporting facts, both re-verified live off Sepolia on 2026-09-07 rather
than copied from a doc: `turnstile:price` is `0.07` and `turnstile:price-ceiling`
is `0.50`. The service charges exactly `0.07` for its standard tier and refuses
to start if any tier exceeds the ceiling.

**Not claimed, so nobody ticks it by mistake:**

- **No value has moved on any chain.** Every `accepts[]` entry carries
  `extra.turnstileSettlement: "stub"` and `/health` reports
  `settlementLive: false`. The receipts in the transcript are in-memory.
- The Arc rail's network id is a **deliberate placeholder**
  (`eip155:0-PLACEHOLDER-arc`), not a real chain. Arc's CAIP-2 identifier is
  unverified as of 2026-09-07, and item 10 above records that we are still
  waiting on Circle about the Launch track's testnet/mainnet question.


---

## MOV-220 — the Hedera x402 rail, and the first real paid request

Appended 2026-09-07. **Value has now moved on chain.**

- **Transaction:** `0.0.7162784@1788791855.758948636` — `CRYPTOTRANSFER`,
  `result: SUCCESS`, consensus `1788791864.361892104`.
- **HashScan:** <https://hashscan.io/testnet/transaction/0.0.7162784@1788791855.758948636>
- **Mirror node, and this is the link that has actually been verified from a
  terminal:** <https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1788791855-758948636>
- 0.84367844 HBAR ($0.07) `0.0.10408012` → `0.0.10403961`. The 0.0024105 HBAR
  fee was charged to `0.0.7162784`, Blocky402's fee payer — **the buyer paid no
  gas at all**.
- **HCS receipts:** topic `0.0.10408013`, one message per settled payment.
- Full setup, architecture, transcript and verification commands:
  **`docs/payment-flow.md`**.

**Correction (2026-09-07, MOV-220) to the MOV-219 block above.** That block's
"Not claimed, so nobody ticks it by mistake" list says **"No value has moved on
any chain"** and that every `accepts[]` entry carries
`extra.turnstileSettlement: "stub"` with `/health` reporting
`settlementLive: false`. That was true when written and is now false for the
Hedera half: `hedera-x402` reports `live: true` and `turnstileSettlement:
"live"`. The **Arc half of that list is unchanged and still accurate** —
`arc-usdc` is still a placeholder on a deliberately fake network id, and MOV-225
owns it. The same block's "Toward the Hedera block" note asked MOV-220 to judge
whether `docs/x402-service.md` served the README row; it did not, so
`docs/payment-flow.md` was written and the row is ticked against that.

**Correction (2026-09-07, MOV-220) to the MOV-219 rail note.** It recorded
`rails/hedera-x402/` shipping with network `eip155:296` marked UNVERIFIED. That
value was **wrong**, not merely unverified. Blocky402 advertises Hedera under
Hedera's own CAIP-2 namespace, `hedera:testnet`, and `@x402/hedera` accepts
nothing else — a challenge on `eip155:296` is rejected with `network_mismatch`
before anything is signed. Hedera *does* have an EVM chain id of 296; it belongs
to the JSON-RPC relay, which is a different execution path from the one x402
uses. The asset also changed, from a USDC placeholder to native HBAR (`0.0.0`,
8 decimals), for reasons recorded in `rails/hedera-x402/config.ts`.

**Ranking is no longer a placeholder once receipts are ingested.** The MOV-222
note above says `settlement_receipt` is "the MOV-220 seam and is empty". It need
not be: `graph/sink/ingest-receipts.ts` reads the HCS topic off the public mirror
node and fills the table, and `graph/sink/ingest-receipts.test.ts` asserts the
basis flips to `settled_volume` with the placeholder flag cleared. The note is
accurate for any database that has not had the ingest run.

**Not claimed, so nobody ticks it by mistake:**

- **The HashScan link has not been verified from this environment.**
  `hashscan.io` answers 404 to curl for every path including its own root — it is
  a single-page app behind bot filtering, so a status code proves nothing either
  way. Open it in a browser before putting it in front of a judge. The mirror
  node link above *has* been verified end to end.
- **Testnet only.** Nothing here has been run against Hedera mainnet.
- **No video.** `node scripts/hedera-paid-request.ts` produces the transcript the
  demo needs; nobody has recorded it.
- **ERC-8004/HCS-14 identity, HTS custom fees and Scheduled Transactions are not
  attempted.** Only the HCS audit trail of those four extra-point items is done.
- **`arc-usdc` is untouched by this issue** and still settles nothing.

### MOV-226 — Uniswap contributions: uniswap-mcp, SKILL, FEEDBACK.md, upstream PR (2026-09-07)

Three separable contributions; `docs/uniswap-contributions.md` is the account
judges should read.

- **`uniswap-mcp/`** — standalone MCP server + `SKILL.md` over the Uniswap
  stack. Five tools (token metadata, factory pool discovery, per-pool v3/v4
  quotes, depth-at-size ladders, Messari AMM subgraph queries). **Nothing in the
  directory imports anything outside it**, so it can be copied out and run with
  no Turnstile context, and it needs **no API key**. 60 offline tests; 198 green
  repo-wide; `tsc --noEmit` clean. Verified end to end against mainnet by
  driving the real server over stdio (`test/live-smoke.ts`).
- **The subgraph, framed as a Uniswap contribution** — `graph/subgraph/`,
  already deployed. One Messari-conformant document across four AMMs by four
  teams on two chains.
- **Upstream PR** — `Uniswap/uniswap-ai`, branch
  `IpastorSan:fix/quoter-static-call-ethers-v6`, prose only, 5 files, +42/−10,
  `markdownlint-cli2` and their pinned `prettier@2.8.8` clean. Their v4 quoting
  skill mandates ethers v5's `callStatic`, which v6 removed and viem never had,
  in a file whose every other snippet is viem and whose install line has no
  ethers; the eval rubrics grade for it too.

**Two things need Ignacio and cannot be done by an agent:**

1. **The feedback form** (see the item above). Required for the prize.
2. **Opening the PR.** `gh pr create` is blocked by the Uniswap org's OAuth App
   access restrictions — proven not to be a token-scope problem, because the
   same token opened a PR on our own fork as a control. The branch is pushed;
   the PR needs one click in a browser at
   <https://github.com/Uniswap/uniswap-ai/compare/main...IpastorSan:uniswap-ai:fix/quoter-static-call-ethers-v6?expand=1>
   with the body from `docs/uniswap-ai-pr-body.md`.

**Not done, deliberately:** no v4 hook. Scope decision recorded in the issue —
the marginal prize value does not justify the Solidity time.
---

## MOV-225 — the Arc rail: Circle Gateway Nanopayments

Appended 2026-09-07. Append-only file: this block corrects earlier ones by
quoting them rather than editing them.

### The Arc rail is no longer a placeholder

`rails/arc-usdc/` settles USDC on **Arc testnet** through **Circle Gateway
Nanopayments** (`@circle-fin/x402-batching@3.4.0`). `info.live` is `true` and
every challenge carries `extra.turnstileSettlement: "live"`.

**Correction (2026-09-07, MOV-225) to the MOV-219 block above.** Its "Not
claimed, so nobody ticks it by mistake" list said the Arc rail's network id was a
**deliberate placeholder** (`eip155:0-PLACEHOLDER-arc`) and that "Arc's CAIP-2
identifier is unverified". Both were true when written and both are now
resolved. Arc testnet is **`eip155:5042002`**, verified two independent ways on
2026-09-07: `eth_chainId` on `https://rpc.testnet.arc.network` returns
`0x4cef52`, and Circle Gateway's `/v1/x402/supported` advertises a kind on
`eip155:5042002`. The asset placeholder is resolved too — USDC on Arc testnet is
`0x3600000000000000000000000000000000000000`, six decimals.

**Correction (2026-09-07, MOV-225) to the MOV-220 correction above.** It says
"The **Arc half** of that list is unchanged and still accurate — `arc-usdc` is
still a placeholder on a deliberately fake network id, and MOV-225 owns it." That
was accurate when written; it is now false in both halves. Both rails are live,
and `/health` reports `settlementLive: true` for both.

### Settled, and the batch transaction

Seven payments, one transaction:
[`0xd6e77a59ad4740e5f89c9c601a05e7cf7859c9253fb1b3c31a8eae97e859a0c1`](https://testnet.arcscan.app/tx/0xd6e77a59ad4740e5f89c9c601a05e7cf7859c9253fb1b3c31a8eae97e859a0c1).
22 payments in it in total, 0.133111 USDC, gas paid by Circle's batcher rather
than by any payer. The agent's nonce was 0 before, during and after.

Full transcript, the verified/not-verified table, and six rough edges in Circle's
SDK and API: **`docs/arc-nanopayments.md`**.

**Correction (2026-09-07, MOV-225) to the MOV-220 block's closing line.** It
ends "**`arc-usdc` is untouched by this issue** and still settles nothing." True
of MOV-220; superseded here. Everything else in the MOV-220 block stands
unchanged — the Hedera transaction, the HCS topic and the HashScan caveat are
not affected by this issue.

### The "holds zero native token via a Paymaster" claim was wrong everywhere

`CLAUDE.md`, `README.md` and `docs/architecture.md` all carried a Hot-tier row
reading *"Nothing. Spends within the mandate, holds zero native token
(Paymaster)."* **All three are corrected in this branch**, each with a dated
note in place rather than a silent edit.

It is not a wording problem. **USDC is Arc's native gas token**, so
`eth_getBalance(a)` and `USDC.balanceOf(a)` are two views of one balance at two
precisions. Measured on a live Arc address, 2026-09-07:

```
eth_getBalance   285144556003000000   (18 dp) = 0.285144556003 USDC
USDC.balanceOf              285144   ( 6 dp) = 0.285144       USDC
```

Zero native is zero USDC, which cannot pay anyone. There is no Paymaster in
Turnstile and there never was one.

The replacement claim is stronger and falsifiable: the hot wallet **signs
offchain and never submits a transaction**, so it pays exactly zero gas, and the
proof is that `eth_getTransactionCount(agent)` stays **0** across every settled
payment.

### Item 10 — the Arc Discord question is partly answered by the product

Item 10 in the Day-1 table asks whether Arc's "deployment-ready by 30 Sep"
accepts a testnet + mainnet config. **Still unanswered by Arc** — nobody has
replied. What is now known is that the config difference is small enough to be
mechanical: `@circle-fin/x402-batching` covers Arc mainnet and Arc testnet
through the same `CHAIN_CONFIGS` table, differing in chain id, Gateway host
(`gateway-api.circle.com` vs `gateway-api-testnet.circle.com`) and GatewayWallet
address. `rails/arc-usdc/config.ts` holds all three as named constants. Arc
mainnet has **no public RPC** (Circle's own SDK comment says partners must supply
a private one), which is a real obstacle to the Launch track and is not something
we can solve ourselves.
