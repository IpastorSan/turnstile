# AI use in Turnstile

ETHOnline 2026 requires entrants to document where and how AI tools were used.
This is that document. It is written to be checked, not to be believed: every
claim below points at a file, a branch, a commit or a transaction in this
repository.

**The short version.** Essentially all of the code in this repository was
written by AI agents (Claude Code, models Opus and Sonnet), one agent per issue,
each in its own git worktree and on its own branch. A single human, Ignacio
Pastor ([@IpastorSan](https://github.com/IpastorSan)), directed the plan those
agents were pointed at, set the architecture and the scope, chose the sponsors
and designed the three-tier key model, reviewed the output, forced the
corrections recorded in [`CORRECTIONS.md`](./CORRECTIONS.md), and personally did
every step that reaches outside this machine: signing transactions, spending
money, creating accounts, deploying, scanning his own face, and pressing submit.
Nothing here was one-shot generated from a single prompt.

---

## 1. Which tools

| Tool | What it did |
|---|---|
| **Claude Code** (Anthropic), models **Opus** and **Sonnet** | Wrote the code, the tests, the Solidity, the Rust Substreams module, the Next.js app, the docs in `docs/`, the walkthrough pages and the Arc deck. Both models were used across the twelve days; the repository does not record which model wrote which commit, so no split is claimed here. |
| **Claude Code subagents in isolated git worktrees** | One issue, one agent, one worktree, one branch. Each agent started with a fresh context window and read the repository rather than a conversation history. |
| **`/ralph-planning` and `/ralph-implement`** | Two personal Claude Code skills belonging to the operator, not project files. The first turned the day-1 plan into ordered issues with acceptance criteria. The second ran the implementation loop over them. See [`planning/README.md`](./planning/README.md). |
| **Playwright, driven by scripts an agent wrote** | The screenshots and the screen recording. See §5. |

The day-1 plan also names two Claude Code plugin skill packs as accelerants to
consider, `streamingfast/substreams-skills` for the Rust module and Ledger's
`ledgerhq/agent-skills` for the cold tier. Nothing in this repository records
whether either was actually loaded, so we do not claim it either way. The Ledger
track was dropped regardless.

This repository records no other AI tooling, and the operator used none that he
has not listed here. There is no code in this repository copied from a
model's training-data-shaped answer to a prompt like "write me an x402 server":
every integration was written against the sponsor's own primary docs, and where
those docs were wrong we wrote it down in [`FEEDBACK.md`](./FEEDBACK.md) and
[`WORLD-FEEDBACK.md`](./WORLD-FEEDBACK.md).

---

## 2. How the AI was directed

### The day-1 plan

Before any code existed, on **2026-09-04**, a build plan was written against the
sponsors' primary documentation: the product, the architecture, the per-sponsor
qualification gates, the sequencing, and pre-declared cut lines so that scope
reduction would be a decision already made rather than a panic at 3am.

**Who wrote it, precisely, because this is the document the spec-driven rule is
about.** The plan text was drafted by Claude during a planning session, from the
sponsors' own documentation, and then revised in that session against the
human's decisions. What the human contributed is the part that determined the
project: the choice to enter From Scratch only, the sponsor set, the merge of two
earlier drafts into one market with a buyer half and a seller half, the
three-tier key model as the spine, the explicit call to take full scope with a
stated concern about twelve shallow integrations, and the cut lines. The plan
records those decisions where they were made, for example the "Scope decision
(user, explicit): full scope, built by us" line in section 1. Read it as a
human-directed document drafted by an AI, not as a human-authored specification,
and not as an AI's own idea of what to build.

It is published unedited at
[`planning/turnstile-v3-day1-plan.md`](./planning/turnstile-v3-day1-plan.md),
wrong claims included. It is a day-1 snapshot and is deliberately not
maintained; [`CHECKLIST.md`](./CHECKLIST.md) is the live record.

### The plan became issues, and issues became branches

`/ralph-planning` broke the plan into ordered `MOV-2XX` issues, each with a
mini-plan, acceptance criteria taken from the plan's per-sponsor gate lists, the
files it was expected to touch, and its dependencies. `/ralph-implement` then
ran one issue at a time, handing each to a fresh-context agent.

The loop each agent had to follow is not advice, it is
[`CLAUDE.md`](./CLAUDE.md) §7, and it is the first thing every agent read:

1. Branch from `dev`, never from `main`, in a new worktree.
2. Commit granularly. Small, real messages. Never one squashed dump.
3. Push the feature branch. That branch is the history judges see.
4. Merge into `dev` with `--no-ff`, preserving the feature boundary.
5. Merge `dev` into `main` with `--no-ff` at milestones.

[`scripts/wt.sh`](./scripts/wt.sh) implements it, and `--no-ff` is hardcoded in
the script rather than being a flag, because there is no supported way to
flatten a feature boundary here.

### Verification was a gate, not a hope

`npm run verify` runs `tsc --noEmit`, the Node test suite and `forge test`.
As of 2026-09-11 that is 516 tests: 426 Node, 90 Forge, 13 of which fork against
live Sepolia rather than a mock. An agent that could not make it pass did not
merge.

### What a judge can check in one minute

- `git log --graph --first-parent dev`. The repository was initialised on
  2026-09-04 and has **315 commits on `dev`**, of which 87 are merge commits and
  228 are real changes.
- **96 feature branches** are pushed to the remote and were never deleted after
  merging (88 `feat/…`, 6 `docs/…`, 2 `fix/…`). One per issue. That is the
  per-feature history, and it exists because deleting it would delete the
  evidence.
- The second half of [`CHECKLIST.md`](./CHECKLIST.md) is a per-issue evidence
  block. **MOV-215, MOV-216, MOV-217, MOV-218, MOV-219, MOV-220, MOV-221,
  MOV-222, MOV-225, MOV-226** and **MOV-230** each have a dated section with
  transaction hashes, terminal output, and an explicit list of what was *not*
  exercised. MOV-228 (Privy) and MOV-273, MOV-277, MOV-279, MOV-280 and MOV-281
  (deployment, World, Bazantic) are evidenced in dated updates inside the
  per-sponsor gate rows rather than in their own sections.
- Commit bodies are written to be read. They say what was checked, what was not,
  and what the change disproved.

**One thing that check will show, so it is better said here.** `CLAUDE.md` sets a
rule of committing every day. In practice the pushes landed on five days
(2026-09-04, 09-07, 09-08, 09-09 and 09-11), not on twelve. The history is
genuinely per-feature and genuinely incremental, but it is not daily, and the
rule was aspirational rather than met.

---

## 3. Which parts are AI-generated, and which are human

### AI-written, under human direction: effectively all of the code

**229 source files, roughly 40,800 lines of TypeScript, Solidity and Rust**, plus
**55 markdown files** of documentation. Every one of the following was written by
an agent:

| Path | What it is |
|---|---|
| `contracts/` | Foundry. The ENSv2 subname registry and registrar, the `PermissionedResolver`, `VerdictConsumer`, deploy scripts and the Forge tests including the Sepolia fork tests |
| `graph/subgraph/` | The Messari DEX AMM Extended v4.0.1 conformant subgraph |
| `graph/substreams/` | The Rust ERC-8004 agent-registry normalization module, and the sink that consumes it |
| `seller/` | The x402-gated service, the Liquidity Analyst scorer, the Chainlink CRE confidential workflow |
| `rails/` | The `PaymentRail` seam and both implementations, Hedera x402 and Arc USDC |
| `buyer/` | The Privy org wallet integration, the mandate policy and its enforcement, the buyer agent |
| `identity/` | World Selfie Check integration, listing limits, the canonical-identity resolver |
| `mcp-turnstile/`, `uniswap-mcp/` | Both MCP servers and both `SKILL.md` files |
| `web/` | The whole Next.js app, frontend and backend routes |
| `scripts/`, `deploy/` | Including `wt.sh` and the Docker Compose and Caddy configuration |
| `docs/`, `walkthrough/`, `README.md`, `CHECKLIST.md`, `CLAUDE.md`, `CORRECTIONS.md`, `FEEDBACK.md`, `WORLD-FEEDBACK.md` | All of it |

We are not going to itemise this any further, because the honest itemisation is
"all of it". Claiming a hand-written subset would be checkable and false.

### Human, and not delegable

**Direction and design.**

- The product, the pitch, and the one-line framing (sell the answer, keep the
  method). The day-1 plan is the human's document.
- **The three-tier cold/warm/hot key model**, which is the architectural idea the
  whole project defends, and the invariant it exists for: the key that spends can
  never raise its own limit. Agents implemented it and proved it on chain; they
  did not invent it.
- **Which sponsors to enter and which to drop.** The Ledger track was abandoned
  on evidence. Uniswap v4 hooks, 1inch Aqua, Hedera ATS and every Continuity
  prize were declined up front, in the plan's "Explicitly not doing" list, and
  never revisited.
- Scope. The plan records the scope decision as the user's, explicitly, along
  with his stated concern about it.

**Review, which is the part with the clearest evidence.** Agents wrote confident
prose that was not true, repeatedly, and the corrections are on the record
because the human kept catching them and refused to let them be quietly edited
away. [`CORRECTIONS.md`](./CORRECTIONS.md) exists for exactly this, and
`CLAUDE.md` carries a standing rule ("Documents go stale. Correcting them is part
of the work") that was written after the same failure mode recurred four times in
three days.

The four worth naming:

1. **The Ledger custody claim** (MOV-000, 2026-09-08). The architecture named
   Ledger Key Ring as the cold tier and said it sealed upstream API keys. Neither
   was true: `wallet-cli ring init` cannot run on the only device available (a
   Ledger Nano S, EOL, firmware capped at 2.1.0), and the diagnosis eliminated
   permissions, transport and packaging before concluding the model cannot do it.
   The whole track was dropped. The `CHECKLIST.md` gate block is struck through
   rather than deleted, so a judge can see the gates were evaluated and failed
   rather than overlooked.
2. **"Held offline"** (MOV-005, 2026-09-08). When Ledger fell, the cold tier's
   description became "a cold key held offline", which traded an unverifiable
   vendor claim for an unverifiable custody claim, in four files.
   `contracts/addresses.turnstile.sepolia.json` records `coldKey` and `deployer`
   as the same address, and its private key is `DEPLOYER_PRIVATE_KEY` in the
   `.env` on the working laptop. The claim was withdrawn. What replaced it is
   narrower and provable: a separate key holds the only roles that can move the
   payout address, and MOV-218 demonstrated the hot key's `setAddr` reverting
   with `EACUnauthorizedAccountRoles` live on Sepolia.
3. **The "Paymaster" and zero-gas claim** (MOV-225, 2026-09-07). The Arc hot
   tier was described as holding zero native token via a Paymaster. There is no
   Paymaster in this design and there cannot be one on a chain where USDC is the
   gas token; the word had been carried over from a chain where gas and payment
   are different assets. It was replaced by a stronger claim with a falsifiable
   test: the spending agent's nonce is still `0` after eleven settled payments,
   because it signs EIP-3009 authorizations offchain and never submits a
   transaction. Anyone can re-run that read.
4. **The stale "not deployed" copy** (2026-09-11, commit `6d9b432`). The live
   seller page carried hard-coded text saying the seller service was not
   deployed, served from the deployed site itself. **It was found in a re-captured
   screenshot, not by any grep of `docs/`,** which is the whole reason the
   screenshots are re-captured against the live host rather than reused.

Two more of the same shape, for completeness: MOV-262 (2026-09-09) found that a
documented containment property held for the Arc rail and not for the Hedera one,
by writing the test the claim implied, which would have rendered a confident
"0 payments, $0.00 settled" during a mirror-node outage. MOV-272 (2026-09-09)
caught paste-ready submission copy claiming we had opened a pull request against
`Uniswap/uniswap-ai` when in fact we filed the issue and a Uniswap maintainer
wrote and merged the fix. That one would have been falsifiable by a judge in one
click.

**What we cannot show you from the repository** is a per-correction attribution
of who noticed first. Some were caught by the human reading agent output, some by
a later agent instructed to re-check a claim. What the repository does show is
that the standing rule requiring the correction to land in the same branch as the
finding, marked and dated rather than silently overwritten, is a human policy
imposed on the agents, and that it is followed.

---

## 4. What is not AI at all

- **Every on-chain transaction was signed with the human's keys and paid from the
  human's own funds.** Sepolia ETH for the ENSv2 deployments, testnet HBAR on
  Hedera, testnet USDC on Arc, and **$0.07 of real USDC on Base mainnet** through
  the Bazantic gateway (transaction `0xf1088b77…919f`, block 51,177,506). Agents
  wrote the scripts, and on testnets they ran them, against keys the human had
  put in a gitignored `.env` on his own laptop. The money, the keys and the
  faucet accounts are his, and no agent ever held a credential this repository
  did not get from him. **The one mainnet spend, the Bazantic payment above, was
  his own**: it ran through a CLI session bound to his browser login, which
  `docs/bazantic-gateway.md` records as something an agent must not even
  initiate.

The rest of this list could not have been done by an agent at all.
- **The World proof is the human's own face.** Selfie Check was run on his phone
  through World's Sandbox App and verified by World's Developer Portal on
  2026-09-11 at 09:06:02 UTC. `CHECKLIST.md` records this as the one step that
  cannot be automated, and it was not faked while it was blocked; `/onboard`
  shipped as a labelled placeholder for two days instead.
- **Account creation, everywhere.** Subgraph Studio, thegraph.market, Chainlink
  CRE, portal.hedera.com, the World Developer Portal (three separate approval
  gates, a five-day wait), Privy, Bazantic and Google Cloud.
- **The deployment.** The GCP VM, the domain, and the DNS behind
  `turnstile.moveseventyeight.com`.
- **The Bazantic Recipe publish decision.** MOV-280 drafted and tested it and
  deliberately did not tick the gate; MOV-281 published it only on the human's
  explicit go-ahead, because publishing puts a named artifact in a public catalog
  under his name.
- **The Ledger hardware attempts**, which is how we learned the track was
  impossible.
- **Submission forms.** The Uniswap feedback form requires his email, his
  Telegram handle and his agreement to Uniswap Labs' terms, and `CHECKLIST.md`
  records it as blocked on him rather than on an agent. The ETHGlobal submission
  itself likewise.

---

## 5. Assets

| Asset | How it was made |
|---|---|
| `docs/screenshots/*.png` | Playwright captures of the running application, taken by [`scripts/capture.ts`](./scripts/capture.ts), which an agent wrote. Not mockups and not edited. Each shot waits for text that only exists once live data has landed and fails rather than shooting a structurally complete but empty page. Re-captured on 2026-09-11 against the public deployment. |
| `walkthrough/` | Six hand-authored HTML pages plus one stylesheet, written by agents. No build step, no CDN, no generator. |
| `docs/arc-presentation.html` and `.pdf` | The Arc submission deck. One self-contained HTML file written by an agent, on the web app's own palette; the PDF is that same file printed at 1600x900, one slide per page. Every figure in it is taken from `EVIDENCE.md`, `arc-nanopayments.md`, `privy-mandate.md` or `CHECKLIST.md`. |
| `docs/walkthrough.webm` and `.mp4` | A 48-second silent Playwright recording of the real application, scripted by [`scripts/walkthrough-video.ts`](./scripts/walkthrough-video.ts) so it can be re-recorded after any change rather than re-acted. **It is not a submission video**: no audio, no narration, no human on camera. The README says so too. |
| `docs/architecture.svg` and `.png` | Drawn by an agent. |

No image in this repository is model-generated imagery. There is no AI-generated
art, no synthetic voice and no avatar anywhere in the submission.

---

## 6. Where to look next

- [`planning/`](./planning/) for the day-1 plan and how it became issues.
- [`CHECKLIST.md`](./CHECKLIST.md) for the per-issue evidence.
- [`CORRECTIONS.md`](./CORRECTIONS.md) for the claims that were wrong.
- [`docs/EVIDENCE.md`](./docs/EVIDENCE.md) for the current state of every claim,
  including a section on what is not live.

If something in this document is wrong, the rule in `CLAUDE.md` applies to it as
much as to anything else: correct it in the same branch, mark the correction,
date it, and say what is still true.
