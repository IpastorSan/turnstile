# Uniswap contributions

Three separable contributions to the Uniswap stack, each of which stands on its
own and can be evaluated without the other two. Written for MOV-226.

| # | Contribution | Where | Reusable without Turnstile? |
|---|---|---|---|
| 1 | A Messari-conformant AMM subgraph over Uniswap v3 | [`graph/subgraph/`](../graph/subgraph) | Yes — it is a deployed endpoint anyone can query |
| 2 | `uniswap-mcp`, an MCP server + SKILL over the Uniswap stack | [`uniswap-mcp/`](../uniswap-mcp) | Yes — self-contained directory, no repo imports |
| 3 | A defect we reported in an official Uniswap repo, **fixed and merged by Uniswap** | [`uniswap-ai#148`](https://github.com/Uniswap/uniswap-ai/issues/148) → [`#149`](https://github.com/Uniswap/uniswap-ai/pull/149) | It *is* upstream, and it is shipped |

Rough edges found along the way are in [`FEEDBACK.md`](../FEEDBACK.md), which is
Uniswap-only by convention; Graph observations live in
[`docs/graph-notes.md`](./graph-notes.md).

---

## 1. A standardized AMM subgraph over Uniswap v3

**Live:** `https://api.studio.thegraph.com/query/1758854/turnstile-uniswap-v-3-messari/v0.1.0`
**Code:** [`graph/subgraph/`](../graph/subgraph) · full write-up in its
[README](../graph/subgraph/README.md)

The schema is [Messari DEX AMM (Extended)
v4.0.1](https://github.com/messari/subgraphs/blob/master/docs/SCHEMA.md), copied
verbatim — every entity name, field name, type and nullability is the standard's.
That is the contribution: a consumer who has written a query once can point it at
this subgraph without editing a character.

**The claim, and the evidence for it.** `queries/cross-protocol.graphql` is one
document with no per-protocol branching, and it runs byte-identical against four
different AMM protocols indexed by four different teams across two chains —
Uniswap v3 (Arbitrum), Sushiswap v3 (Ethereum), SushiSwap v2 (Ethereum) and
Curve (Ethereum). A constant-product AMM, a concentrated-liquidity AMM and a
StableSwap-invariant AMM answer the same question. Captured responses are in
`graph/subgraph/samples/`.

**Why that is worth something to Uniswap specifically.** It makes Uniswap
comparable rather than merely describable. `cumulativeVolumeUSD` means the same
thing in all four responses, so ranking Uniswap against the venues it competes
with is arithmetic; against each protocol's own bespoke subgraph it is a
per-protocol research task before any arithmetic is safe.

**It is more correct than the reference implementation.** Messari's own published
v3 subgraphs return a constant `1.0001` for `Tick.prices` regardless of tick
index — the exponentiation by the tick index is simply not applied — and leave
`Position.liquidityUSD` at `"0"`. Ours does neither. The two are side by side in
`graph/subgraph/samples/`. Conforming to a schema is not the same as copying an
implementation, and this is the difference showing.

---

## 2. `uniswap-mcp` — reusable standalone

**Code:** [`uniswap-mcp/`](../uniswap-mcp) · [README](../uniswap-mcp/README.md) ·
[SKILL.md](../uniswap-mcp/SKILL.md)

```bash
cd uniswap-mcp && npm install
claude mcp add uniswap -- node "$PWD/server.ts"
```

**Standalone by construction.** Nothing under `uniswap-mcp/` imports anything
outside it. The directory can be copied out of this repository, `npm install`ed
and run with no Turnstile context whatsoever — it has its own `package.json`,
its own dependency list and its own tests. It was extracted to be reusable, not
vendored to look reusable. It needs **no API key**: every tool is either an
`eth_call` against a public contract or a POST to a public subgraph.

| Tool | Answers |
|---|---|
| `uniswap_token` | symbol / name / decimals, read from the token. Flags symbol impersonation. |
| `uniswap_find_pools` | which v3 fee tiers exist for a pair, plus address, liquidity and tick |
| `uniswap_quote` | one exact-input quote against one pool — v3 QuoterV2 or v4 V4Quoter |
| `uniswap_pool_depth` | a ladder of sizes against one v3 pool, all pinned to one block |
| `uniswap_amm_query` | indexed history through any Messari DEX AMM subgraph (contribution 1) |

**The output that justifies it.** Live against mainnet at block 25926800,
WETH/USDC 0.05%:

```
  sizeIn                 out    impact  ticks
       1         2479.761982    0.000%  1
      10        24795.448845    0.009%  1
     100       247735.449049    0.097%  3
    1000      2455419.048573    0.982%  20
   10000      22453014.79877    9.455%  164
```

The last column is `initializedTicksCrossed`, which QuoterV2 returns and no
routed quoting API has an equivalent for. It turns "the price got worse" into "a
trade 10,000x larger walked through 164 initialized ticks where the reference
crossed 1" — a mechanical, comparable measure of how far liquidity is actually
spread. That is the difference between a pool that is deep and one that merely
has a large TVL attached to it. Reproduce with `node uniswap-mcp/test/live-smoke.ts`.

**Verification:** 60 offline tests (stubbed client, real ABI encoding, failure
paths included); `npm test` at the repo root runs them alongside everything else.
All five chains' factory and quoter addresses were checked with `eth_getCode` and
independently match Uniswap's per-chain deployment pages — including Base, which
is the exception with both a different factory and a different QuoterV2.

---

## 3. Upstream — `Uniswap/uniswap-ai`, reported by us and **merged**

**Update (2026-09-09, MOV-271): this shipped.** This section previously
described a PR we intended to open from `IpastorSan:fix/quoter-static-call-ethers-v6`.
What actually happened is better, and the record should say so precisely rather
than flatteringly:

| | |
|---|---|
| **Our report** | [`Uniswap/uniswap-ai#148`](https://github.com/Uniswap/uniswap-ai/issues/148) — opened by `IpastorSan`, **closed 2026-09-08T14:27:58Z** |
| **Their fix** | [`Uniswap/uniswap-ai#149`](https://github.com/Uniswap/uniswap-ai/pull/149) — **MERGED 2026-09-08T14:27:57Z**, 7 files, +51 / −14 |
| **Authored by** | `wkoutre`, a Uniswap maintainer — **not us** |
| **Landed in** | the skill, its docs page, the plugin `CLAUDE.md`, **both eval rubrics**, and a plugin version bump |

**We did not write the merged code, and saying otherwise would be the easiest
overclaim available here.** We filed the analysis; a maintainer verified it,
wrote the change on their side so the version bump and docs sync could land in
one commit, and [linked back to our issue](https://github.com/Uniswap/uniswap-ai/issues/148#issuecomment-5586501199):

> "Thanks for this — it's correct, and the writeup made it trivial to confirm.
> Verified on our side: `callStatic` shows up in six places … I'm writing it up
> on our side rather than cherry-picking, so the plugin version bump and the
> docs sync land in the same commit — **but the shape is yours and the PR will
> link back here.** … Appreciate you taking the time to verify it live against
> mainnet instead of just flagging the name."

Two things that came out of their verification and not ours, worth recording
because they make the finding larger than we filed it:

1. **Six occurrences, not the five we found** — the count included both eval
   rubrics, so the grader was rewarding code that throws.
2. **The origin is Uniswap's own documentation.** Their [v4 quoting
   guide](https://developers.uniswap.org/docs/sdks/v4/guides/swapping/quoting)
   still uses `callStatic`, and the skill inherited it from there. The skill was
   not wrong on its own; it was faithfully copying a doc that was.

The analysis as filed follows.

**Scope as filed:** prose only, 5 files, +42 / −10

[`Uniswap/uniswap-ai`](https://github.com/Uniswap/uniswap-ai) is Uniswap's
official "AI tools for building on Uniswap — skills, plugins, and agents"
repository.

**The defect.** Its `v4-sdk-integration` skill instructs an agent to quote with
`quoterContract.callStatic.quoteExactInputSingle(...)`, and states it as a strict
rule: *"ALWAYS use `callStatic` for offchain simulation"*. `callStatic` is
**ethers v5 only** — removed in v6, and viem has never had it under any name.

What makes it more than a stale method name is the rest of the file. The skill's
install line is `@uniswap/v4-sdk @uniswap/sdk-core @uniswap/universal-router-sdk`
— **no ethers at all** — and every other snippet in it is viem
(`walletClient.writeContract`, `functionName`/`args`). So the one library its
quoting section assumes is the one it never installs, and the spelling it
mandates exists in neither library it actually uses. It also reaches the eval
suite: `rubrics/correctness.txt` awards points for *"Uses Quoter contract with
callStatic"*, so the grader rewards generating code that throws.

**The fix.** State the rule library-neutrally — the quoter is not `view`, so
simulate it through `eth_call` — quote `V4Quoter.sol`'s own NatSpec for the
reason, and give all three spellings side by side. Both eval rubrics updated to
match.

**Verified, not asserted.** Against `ethers@6.17.0`:

```
typeof c.callStatic                       -> undefined
typeof c.quoteExactInputSingle.staticCall -> function
c.callStatic.quoteExactInputSingle({...})
  -> TypeError: Cannot read properties of undefined (reading 'quoteExactInputSingle')
```

And live against mainnet V4Quoter `0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203`,
using the guide's own ETH/USDC 0.05% example: viem `readContract` and ethers v6
`.staticCall` both return **2477.420516 USDC** for 1 ETH, agreeing to the last
decimal, while the documented `callStatic` throws.

`markdownlint-cli2` and the repo's pinned `prettier@2.8.8` are clean on all five
changed files.

### Opening it requires a browser

`gh pr create` against `Uniswap/uniswap-ai` fails with
`CreatePullRequest: does not have the correct permissions`, and the REST route
404s. This is **not** a token-scope problem — the same token successfully opened
a PR on our own fork as a control. The Uniswap organization has OAuth App access
restrictions that block the GitHub CLI from writes. A browser session is not an
OAuth app, so this link works:

<https://github.com/Uniswap/uniswap-ai/compare/main...IpastorSan:uniswap-ai:fix/quoter-static-call-ethers-v6?expand=1>

The branch is already pushed. The PR body to paste is in
[`docs/uniswap-ai-pr-body.md`](./uniswap-ai-pr-body.md), and the commit message on the branch carries the same
argument if the body is lost.

---

## The feedback form — the one thing that cannot be automated

The Uniswap Developer Feedback Form at
<https://developers.uniswap.org/hackathon-feedback> **must be submitted, with a
link to [`FEEDBACK.md`](../FEEDBACK.md) in it.** Submissions without that link
get audited before winners are finalised.

It is a client-rendered React form on Uniswap's own docs site — no login, but
also no Google Form or HubSpot endpoint to POST to, so it needs a browser. Four
of its required fields cannot be filled by an agent on the user's behalf:
**email**, **Telegram handle**, and the **"I agree to Uniswap Labs Terms of
Service and Privacy Policy"** checkbox.

**Paste-ready answers for every field are in
[`docs/uniswap-feedback-form-answers.md`](./uniswap-feedback-form-answers.md).**

**It is downstream of two other steps, and the order matters more than it
looks.** Both change what the reviewer sees when they click the link:

1. **`dev` → `main`.** `main` is the default branch, so it is what the permalink
   resolves to — and as of 2026-09-07 `main` was 139 commits behind `dev`, with
   `FEEDBACK.md` still the empty 34-line template. A reviewer would see a stub,
   which is worse than a 404: a 404 reads as "not public yet", an empty template
   reads as "they did not do the work".
2. **`gh repo edit IpastorSan/turnstile --visibility public`.** Until then the
   link 404s for anyone outside the org.

The full sequence, with the verification commands, is in `CHECKLIST.md` under
**Before submitting**. The exception, so it does not have to be decided under
pressure: if the form closes when the hackathon does, submit immediately after
step 2 rather than waiting.
