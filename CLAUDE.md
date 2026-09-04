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
- The repo is **public** and open source (MIT). Several prizes require it.

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
- **Append-only files conflict constantly** across parallel worktrees. `.gitattributes` sets
  `merge=union` on `CHECKLIST.md`, `FEEDBACK.md` and `WORLD-FEEDBACK.md` — append at the end,
  never rewrite someone else's lines.
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

## Commit messages

Small and real. End every commit body with:

```
Claude-Session: <the session URL you were given>
```
