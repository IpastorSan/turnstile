# Uniswap Developer Feedback Form — paste-ready answers

**The form:** <https://developers.uniswap.org/hackathon-feedback>
**Worth:** part of the Uniswap $3,000 prize. Submissions **without the
`FEEDBACK.md` link get audited** before winners are finalised, so the link is
not optional decoration — it is the point of submitting.

**Correction (2026-09-11, MOV-272):** three passages below previously said we
*opened a PR* or *wrote the fix* for the uniswap-ai skill bug. We did not. We
filed issue #148; a Uniswap maintainer (`wkoutre`) wrote and merged the fix in
#149 the same day and credited the report. Pasting the old wording would have
claimed authorship of a merged PR we did not author — checkable in one click.
What is unchanged: every other answer, and the FEEDBACK.md link.

**Steps 1 and 2 below are done as of 2026-09-11** — `main` is current and the
repo is public — so the form can be submitted now.

This file exists so that nobody constructs the URL or writes the blocker answer
by hand at 3am. Everything below is copy-paste except the one field marked
otherwise.

---

## Do these three things in this order

The form must **not** be submitted first. Both preconditions change what the
reviewer sees when they click the link.

| # | Step | Why it must come first |
|---|---|---|
| 1 | **Merge `dev` → `main`** (`git merge --no-ff dev` on `main`, then push) | `main` is the default branch and therefore what the permalink resolves to. As of 2026-09-07 `main` was **139 commits behind `dev`**, and its `FEEDBACK.md` was still the **34-line empty template with zero entries**. A reviewer following the link would see a stub — which is *worse* than a dead link, because a 404 reads as "repo not public yet" while an empty template reads as "they did not do the work". |
| 2 | **`gh repo edit IpastorSan/turnstile --visibility public`** | While the repo is private the link 404s for everyone outside the org. |
| 3 | **Submit the form** with the link below | — |

**Verify between 2 and 3**, in a logged-out browser or a private window:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  https://github.com/IpastorSan/turnstile/blob/main/FEEDBACK.md    # want 200
git show main:FEEDBACK.md | grep -c '^### 2026'                    # want >= 10, not 0
```

The second command is the one that matters. A `200` only proves the repo is
public; it does not prove `main` carries the feedback. Both entry sets must be
there: MOV-216's four problem entries and MOV-226's four, plus the two "what
worked well" sections — ten `### 2026` headings as of 2026-09-07. It is a floor,
not an equality: `FEEDBACK.md` is append-only, so the count only ever grows.

**If the form closes when the hackathon does:** submit it *immediately* after
step 2 on the same day rather than waiting for a tidier moment. Losing $3,000 to
a closed form is far worse than an imperfect sequence. If it somehow has to go
in before step 1, submit it anyway and re-submit once `main` is current.

---

## The link — copy this exactly

```
https://github.com/IpastorSan/turnstile/blob/main/FEEDBACK.md
```

A **default-branch permalink**, deliberately. Do not substitute a commit-pinned
blob URL (`/blob/<sha>/`) — those are stable but freeze the file at one moment,
and `FEEDBACK.md` is append-only, so a pinned link would show the reviewer a
version missing every entry written after it. Do not use a `dev` link either;
`dev` is an integration branch and is not what the repository presents.

---

## The fields

| Field | Answer |
|---|---|
| First name | `Ignacio` |
| Last name | `Pastor` |
| Email | `ignaciopastorsan@gmail.com` |
| **Telegram handle** | **← ONLY IGNACIO CAN SUPPLY THIS.** It is required, and it is nowhere in the repo. |
| Which hackathon did you participate in? | `ETHOnline 2026` |
| Did you complete a project? | `Yes` |
| Are you building an AI-powered or agentic project? | `Yes` |
| Were you able to successfully integrate Uniswap? | `Yes` |
| How long to your first successful integration? | Pick the bucket nearest **a few hours**. Factual basis: the first working QuoterV2 call landed the same day the analyst was started; the time went on the `callStatic`/`view` confusion below, not on the integration itself. |
| Do you plan to continue building this? | `Yes` |
| What type of support did you use? | Tick **Technical docs** and **Code examples / templates** only. We used no office hours, no mentorship and no Discord — do not tick those, it would misreport the support rating below. |
| How helpful was the documentation? (1–5) | **Ignacio's call.** An honest reading is `3`: the explanations are good and the remedies are stale. |
| How would you rate the support overall? (1–5) | **Ignacio's call.** We did not use human support channels, so rate the self-serve surface or leave it mid. |
| Can we follow up? | `Yes` |
| ToS / Privacy Policy agreement | **Ignacio must tick this himself.** It is a legal consent. |

### What did you build?

```
Turnstile — a paid lane for onchain data agents: sellers publish a priced service
at an ENSv2 subname, buyers issue a mandate their agent spends inside but can
never widen.

Three contributions to the Uniswap stack, each usable on its own:

1. A Messari DEX AMM (Extended) v4.0.1 conformant subgraph over Uniswap v3. One
   query document runs byte-identical against four different AMMs indexed by four
   different teams on two chains (Uniswap v3, Sushiswap v2 and v3, Curve), which
   makes cross-protocol comparison arithmetic rather than a per-protocol research
   task. It is also more correct than Messari's own published v3 subgraphs, which
   return a constant 1.0001 for Tick.prices regardless of tick index and leave
   Position.liquidityUSD at zero.

2. uniswap-mcp — a standalone MCP server plus SKILL.md exposing per-pool QuoterV2
   and V4Quoter quotes with initializedTicksCrossed, depth-at-size ladders, v3
   factory pool discovery, and Messari AMM history. It needs no API key and
   imports nothing from the rest of our repo, so it installs and runs on its own.

3. A defect report to Uniswap/uniswap-ai (issue #148): its v4-sdk-integration
   skill mandated ethers v5's callStatic — removed in v6, never present in viem —
   in a file whose every other snippet is viem and whose install line contains no
   ethers. A Uniswap maintainer verified it and merged the fix the same day (PR
   #149, seven files including both eval rubrics). The merged code is theirs; the
   report and the shape of the fix were ours.
```

### What was the biggest blocker you faced?

```
The v4 SDK quoting guide cannot work as written. It imports in ethers v6 style
(import { parseUnits, JsonRpcProvider, formatUnits } from 'ethers') and then
quotes with quoterContract.callStatic.quoteExactInputSingle(...), which ethers v6
removed. Verified against ethers 6.17.0: contract.callStatic is undefined, so the
documented call throws TypeError: Cannot read properties of undefined. Following
the page literally cannot succeed on either ethers version — v5 rejects the
imports, v6 rejects the call.

Second: POST /v1/quote on the Trading API validates the request body BEFORE it
checks auth. An almost-correct request returns a helpful, specific 400 field
error, and only a completely correct one reveals the 401. A detailed field-level
validation error reads as "you are authenticated and merely malformed", so the
natural response is to keep fixing fields rather than to go and get a key. It
also hands schema detail to unauthenticated callers.
```

### If applicable: what was the hardest part of building an agentic app on Uniswap?

```
The docs give library-specific spellings instead of the library-neutral rule, and
that is much more costly for an agent than for a human. The rule is "the quoter is
not view, so simulate it through eth_call"; what the docs give is ethers v5's
callStatic, which is one library's name for it. A human reading callStatic in a
viem codebase reasons about what it meant. An agent copies it, and the code throws.

This has reached Uniswap's own agent tooling. The v4-sdk-integration skill in
Uniswap/uniswap-ai mandates callStatic as a strict rule, in a file that installs
no ethers and whose other snippets are all viem — and its eval rubrics award
points for "Uses Quoter contract with callStatic", so the graders actively reward
generating code that does not run. We reported it (uniswap-ai#148); Uniswap
fixed and merged it the same day in #149, and traced it back to the v4 quoting
guide, which the skill had faithfully copied.

The concrete ask: state the eth_call rule once, library-neutrally, and give the
viem / ethers v6 / ethers v5 spellings side by side. Then agent skills can be
right by construction rather than pinned to whichever library the docs assumed.
```

### What support was missing, or could have been better?

```
Nothing was missing that a person could have supplied — the gap is in the written
surface rather than in the humans. Two things would have saved us the most time:

- Put the "the quoter is not a view function" explanation on the QuoterV2 and
  V4Quoter contract references, where someone reading the ABI will meet it, rather
  than only inside an ethers-flavoured SDK guide.
- Advertise llms.txt and the /llms.mdx/<path> Markdown endpoint. They are
  genuinely excellent for agents and we found them by accident. They are how we
  read every docs page in this project.
```

### Any additional feedback?

```
Full written feedback, kept continuously rather than reconstructed at the end:
https://github.com/IpastorSan/turnstile/blob/main/FEEDBACK.md

Eight dated entries covering the Trading API's 401-behind-validation ordering, the
v4 quoting guide's ethers v6/v5 contradiction, the same bug in Uniswap/uniswap-ai
and its eval rubrics, V4Quoter dropping initializedTicksCrossed relative to
QuoterV2, and docs redirects — including one that 301s to a 404. Each entry says
what we expected, what happened, what it cost, and what we would change.

It also records what worked well, because feedback that is only complaints is not
useful. initializedTicksCrossed is the single most useful number we found anywhere
in this build, and QuoterV2 needing no API key is the reason our MCP server is
infrastructure anyone can run rather than something gated behind our credentials.

We reported the skill bug to Uniswap/uniswap-ai with a live mainnet reproduction
rather than only flagging the name. A maintainer verified it and merged the fix the
same day: https://github.com/Uniswap/uniswap-ai/pull/149 — the merged code is
theirs, and the maintainer credited the report on the issue.
```

---

## After submitting

Tick the form row in `CHECKLIST.md` under **Before submitting**, and note the
date. If the confirmation email or screen gives a reference, paste it into that
row — the prize audit checks the submission exists, and "we definitely sent it"
is not evidence.
