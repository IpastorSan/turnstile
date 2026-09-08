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
| **Cold** | A cold key held offline | Seller operator identity; owns the ENSv2 name | Once per lifecycle | Hot-key rotation, payout address change, price-ceiling raise |
| **Warm** | Privy | Buyer **organization** wallet + mandate policy | Occasional | Issuing a mandate, raising a cap (quorum), adding an agent |
| **Hot** | Circle / Arc Agent Stack | Buyer agent's spending wallet | Every query | Nothing. Spends *within* the mandate; **signs offchain and never submits a transaction**, so it pays exactly zero gas |

**Correction (2026-09-08, MOV-000):** the Cold row previously named **Ledger Key
Ring (`wallet-cli ring`)** as the vendor and claimed it "seals upstream API
keys". Both are withdrawn — **we do not use a Ledger device and never got one
working.** `wallet-cli ring init` fails on the only device available to us, a
**Ledger Nano S** (the original 2016 model, EOL, firmware capped at 2.1.0): it
creates the local member credentials and then fails at the device step with an
untyped "unknown error". LKRP is the trustchain behind Ledger Recover, which has
never supported the Nano S. It is not permissions (udev verified, `uaccess` tag
present, hidraw readable), not transport (`genuine-check` returns a *typed*
error, so the device does answer), and not the package — the model cannot do it.
The Ledger prize track is **not pursued**; see `CHECKLIST.md`.

**What is unchanged: the cold tier itself, and every other row.** Ledger was only
ever going to be *where the cold key lives*, never *what makes it cold*. The
cold/hot split is enforced by the resolver's role checks, and it is proven on
chain rather than in prose — MOV-218 demonstrated the hot key's `setAddr` payout
change **reverting** with `EACUnauthorizedAccountRoles`, live on Sepolia, with
passing Forge tests and a fork test behind it. What falls is only the custody
story: the cold key is held offline and is **not** hardware-backed. No substitute
vendor is claimed.


**Correction (2026-09-07, MOV-225):** the Hot row previously read "holds zero
native token (Paymaster)". That is **wrong on Arc** — it names a mechanism that
does not exist in this design, and it cannot be true on a chain where USDC *is*
the gas token. The row above replaces it with a stronger claim, and the evidence
for it is on chain.

**The claim, and how to falsify it.** The hot wallet signs an EIP-3009
authorization offchain and **never submits a transaction**, so it pays exactly
zero gas — Circle Gateway's batcher submits, and pays. The proof is the wallet's
**nonce**, because a wallet that has never broadcast a transaction has never paid
a wei of gas, and a nonce cannot be faked or back-dated. After **eleven** settled
payments:

```
agent 0x0633a193017939Bb1eB242982397224c66948e2F
  eth_getTransactionCount   0        <-- never submitted anything
  eth_getBalance            0
  USDC.balanceOf            0
                            read at block 60943091, 2026-09-07T17:33:02Z
```

Anyone can re-run that against `https://rpc.testnet.arc.network` and get the same
answer at that block. `scripts/arc-paid-request.ts` prints it before and after
every run, so a regression fails visibly instead of quietly.

**Why the old wording was incoherent** (supporting detail, not the claim). USDC
is Arc's native gas token, so `eth_getBalance(a)` and `USDC.balanceOf(a)` are two
views of one balance at two precisions — the ERC-20 view truncates 18 dp to 6.
Measured on **our own** org wallet, one block before it funded the mandate:

```
0xdFe3088aC34e7329006407C246C9F6D7534B2aC5
  eth_getBalance   20000000000000000000   (18 dp) = 20.000000 USDC
  USDC.balanceOf              20000000   ( 6 dp) = 20.000000 USDC
                   read at block 60938781, 2026-09-07T16:56:10Z
```

A wallet holding zero native token therefore holds zero USDC and can pay nobody.
There is no Paymaster anywhere in Turnstile, and there never was one — the word
was carried over from a chain where gas and payment are different assets.

The hot wallet's Gateway balance is funded by the **warm tier** calling
`depositFor(amount, agent)`: the org pays the deposit's gas and the resulting
balance belongs to the agent. That is this table's own hierarchy expressed in one
contract call — the hot key cannot deposit, withdraw or widen its allowance,
because each is a transaction and it has no gas for one.

**What is unchanged:** every other row, and the invariant below the table. Only
the mechanism named in the Hot row was wrong.

**Update (2026-09-07, MOV-228):** the Warm row is now **running code**, not a
plan. The `depositFor(amount, agent)` caller described above used to be a plain
key at `0xdFe3088aC34e7329006407C246C9F6D7534B2aC5`; it is now a **Privy server
wallet** at `0x3De96375140717193f52c220Df5Ec460971cbE84`, owned by a 1-of-2
operations key quorum and governed by a mandate policy owned by a *separate*
2-of-2 board quorum. Nothing in the row's wording changed because nothing about
the mechanism changed — MOV-228 replaced the key holder, not the mechanism.

What it adds is the last piece of the invariant below: the key that **funds** the
agent cannot raise its own cap either. Widening the mandate is a `PATCH` that
Privy refuses with one signature and accepts with two, verified live —
`docs/privy-mandate.md` has the transcript, the two on-chain transactions, and
six rough edges in Privy's API.


The invariant the whole design defends: **the key that spends can never raise
its own limit.** If a change would let the hot tier widen its own mandate,
rotate a key, or move a payout address, the change is wrong — take it to the
tier above. The tier separation is central here, not decorative; do not add a
"convenience" path that bypasses the cold key.

**Correction (2026-09-08, MOV-000):** this paragraph previously read
"Device-backed security is central here … bypasses the Ledger". There is no
device — see the correction under the table above. The invariant itself is
**unchanged and still enforced on chain**; only the appeal to hardware is gone.

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
- **`forge` must be 1.8.1, and the directory named `stable` is NOT it.**
  Foundry lives under `~/.config/.foundry` here (XDG, not `~/.foundry`).
  `~/.config/.foundry/bin/forge` symlinks to **v1.8.1** and builds this repo
  cleanly. But `~/.config/.foundry/versions/foundry-rs/foundry/stable/forge` is
  **v1.5.1**, and 1.5.1 *cannot resolve this repo's remappings*: it fails with
  `Source "@ens/contracts/utils/NameCoder.sol" not found` even on a fully
  checked-out tree, then helpfully announces "Missing dependencies found.
  Installing now..." and re-registers the submodules at the wrong paths.
  Verified 2026-09-08 under an identical stripped environment: 1.8.1 exits 0,
  1.5.1 exits 1. So put `~/.config/.foundry/bin` on `PATH`; **never** reach into
  `versions/.../stable/` because `forge` is not on `PATH`. The name promises the
  opposite of what it holds, and an agent that hits this reports the repo as
  broken (one did, and its instinct to suspect the toolchain was right).
- **Submodules do not follow a worktree either, and this one lies the other way.**
  `git worktree add` creates `contracts/lib/*` as five *empty* directories, so
  even forge 1.8.1 fails there with **the same** `NameCoder.sol` message — this
  time because nothing is checked out and the remapping is fine. Two distinct
  causes, one error string: check the binary's version *and* `ls contracts/lib/*/`
  before suspecting the remapping table, which has never once been at fault. Fix it with `git -C <worktree> submodule update --init
  --recursive`, or create the worktree with `scripts/wt.sh new … --contracts`.
  **`--recursive` is load-bearing** — `@ens/contracts/` maps into
  `ens-contracts`, a submodule *inside* `contracts-v2`, so a plain `--init`
  leaves exactly the path in the error message still missing. It is **not**
  automatic: measured end to end on 2026-09-08 at **287s and >240 MB**, re-cloned
  from the network. `--recursive` walks the whole transitive graph, four levels
  deep (`verifiable-factory` → `openzeppelin-contracts-upgradeable` →
  `openzeppelin-contracts` → `forge-std`), so it fetches far more than the
  remappings reference. Local alternates do not avoid it
  (`submodule.alternateLocation=superproject` was measured — it still clones),
  and most worktrees never compile Solidity. `wt.sh` warns loudly when it skips.
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
scripts/wt.sh new  MOV-215 messari-subgraph   # worktree + branch off dev + .env symlink + submodules
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
are ciphertext by design; that is the point. Never add `*.enc` to `.gitignore`,
and never commit a decrypted secret next to one.

**Correction (2026-09-08, MOV-000):** this paragraph previously called the blobs
"Ledger-sealed". They are not, on two counts. The Ledger track is dropped (see
the table above), and **`seller/secrets/` currently contains no `.enc` files at
all** — only its `README.md`, verified 2026-09-08 with `ls seller/secrets/`. The
directory is a placeholder, not a sealed store. The tracking rule above is
unchanged and still correct for whenever blobs do land.

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
