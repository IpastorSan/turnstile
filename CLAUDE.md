# CLAUDE.md — Turnstile

Read this before touching anything. The git workflow below is **mandatory**, and
it is here rather than only in Linear because agents working inside a worktree
read the repo, not the issue tracker.

---

## The hard constraint: From Scratch

Turnstile is an **ETHOnline 2026 From Scratch** entry. `git init` happened at
kickoff (2026-09-04) and every commit is dated in-window.

- **No pre-event code.** Do not import, vendor or paste in code written before
  kickoff, from any of our other repos included. Pre-event code makes the entry
  ineligible for **every** partner prize, not just one.
- Third-party dependencies installed from a registry are fine; that is not our
  code.
- **Commit every day.** 1inch explicitly disqualifies final-day single-commit
  dumps and ETHGlobal audits history generally. Small, real commits — never one
  squashed dump at the end.
- The repo is **private during the build, and MUST be flipped to public before
  submitting.** Every sponsor requires a public repo — a private one fails all
  12 submissions. It is private on purpose, to keep the ERC-8004 Substreams
  module and the "sell the answer, keep the method" framing out of view of
  other teams for the 12 days. Flipping visibility preserves the whole commit
  history, so the history audits are unaffected.

  ```bash
  gh repo edit IpastorSan/turnstile --visibility public   # the last step before submitting
  ```

  This is tracked as a hard gate in `CHECKLIST.md` under **Before submitting**.
  Open source, MIT.

`CHECKLIST.md` is the list of binary prize gates. Every line in it is a
disqualifier. If your work satisfies one, tick it in the same commit.

---

## The three key tiers

Three wallet vendors is not three ways to do one thing. Each sits where it is
actually best, and together they are one cold/warm/hot hierarchy.

| Tier | Vendor | Holds | Frequency | May authorize |
|---|---|---|---|---|
| **Cold** | Ledger Key Ring (`wallet-cli ring`) | Seller operator identity; owns the ENSv2 name; seals upstream API keys | Once per lifecycle | Hot-key rotation, payout address change, price-ceiling raise |
| **Warm** | Privy | Buyer **organization** wallet + mandate policy | Occasional | Issuing a mandate, raising a cap (quorum), adding an agent |
| **Hot** | Circle / Arc Agent Stack | Buyer agent's spending wallet | Every query | Nothing. Spends *within* the mandate, holds zero native token (Paymaster) |

The invariant the whole design defends: **the key that spends can never raise
its own limit.** If a change would let the hot tier widen its own mandate,
rotate a key, or move a payout address, the change is wrong — take it to the
tier above. Device-backed security is central here, not decorative; do not add
a "convenience" path that bypasses the Ledger.

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

---

## Worktree helper

`scripts/wt.sh` implements the loop above, so use it rather than retyping the
commands:

```bash
scripts/wt.sh new  MOV-215 messari-subgraph   # worktree + branch off dev + .env symlink
scripts/wt.sh done MOV-215                    # push, merge --no-ff into dev, remove worktree
```

`--no-ff` is hardcoded in the script and is not a flag. There is no supported
way to fast-forward a feature branch into `dev`.

---

## Shared build cache

Per-worktree installs are expensive, and six parallel worktrees must not mean
six full Rust builds. Export this globally (it is in `.envrc.example`, and
`wt.sh` will warn if it is unset):

```bash
export CARGO_TARGET_DIR="$HOME/.cache/turnstile-target"
```

Use a shared pnpm store for the same reason on the JS side.

---

## Environment

`.env` and `.envrc` are gitignored, so they do **not** follow a worktree —
`wt.sh new` symlinks the root `.env` in for you. Copy `.envrc.example` to
`.envrc` and fill it in.

`seller/secrets/*.enc` **is** tracked and does follow the worktree. Those files
are Ledger-sealed ciphertext; that is the point. Never add `*.enc` to
`.gitignore`, and never commit a decrypted secret next to one.

---

## Continuous obligations

Two files are scored deliverables and are written as we go, not reconstructed at
the end:

- `FEEDBACK.md` — append every time we hit a Uniswap rough edge.
- `WORLD-FEEDBACK.md` — append on docs, Developer Portal, Sandbox, errors, edge
  cases, and anything confusing, missing, broken or hard to test.

Both, plus `CHECKLIST.md`, are `merge=union` in `.gitattributes`. **Append at
the end. Never rewrite someone else's lines** — union merge keeps both sides, so
an edit to an existing line becomes a duplicate rather than a conflict.

Capture **every on-chain transaction the first time it works**: tx hash,
explorer link, terminal output, into `docs/`. Re-running it later for the demo
is not always possible.

---

## Documents go stale. Correcting them is part of the work.

**If your work shows that a document in this repo is wrong, fix the document in the same
branch. Reporting it is not enough.**

This has bitten us four times in three days, and once the correction was reported clearly in
a final report and still never landed — so the next agent read the wrong claim anyway. The
failure mode is always identical: a finding is verified, written up, and the file that other
agents actually read is left untouched.

The report is read once, by one person. The file is read by everyone who comes after.

### Rules

1. **Correct in the same branch as the finding.** Not a follow-up issue, not a line in your
   final report. The same branch, ideally its own commit so the history stays readable.
2. **Mark the correction; do not silently overwrite.** Write `**Correction (YYYY-MM-DD,
   MOV-XXX):** this file previously said X. That is wrong because Y.` Someone who remembers
   the old claim needs to know it changed and why — a silent edit just looks like they
   misread it.
3. **Say what is still true.** When only half a claim falls, say so. "The registry gotchas
   are unchanged; only the resolver claim was wrong" stops the next reader discarding the
   good half with the bad.
4. **Date and source every factual claim you add.** `verified 2026-09-07 against live
   eth_getCode` beats a bare assertion, because the next reader can judge whether it has aged.
5. **If you could not verify something, write that down.** Silence reads as confidence.

### Scope

`CHECKLIST.md`, `README.md`, everything in `docs/`, per-directory READMEs, and this file.

`plan/turnstile-v3.md` in the research repo is a **day-1 snapshot** and is deliberately not
maintained — treat it as history, never as truth. Linear issues and `CHECKLIST.md` are the
live record.

**Where two owners share a line** — e.g. a `CHECKLIST.md` row covering two issues — append
rather than editing in place, and say who should tick it. `merge=union` keeps *both* sides of
a contested line instead of conflicting, so a two-owner edit becomes a silent duplicate.

## Commit messages

Small and real. End every commit body with:

```
Claude-Session: <the session URL you were given>
```
