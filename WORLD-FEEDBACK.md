# World developer feedback

Written continuously, not reconstructed at the end — checklist item 14. The
Selfie Check prize requires this document as a deliverable, and it is explicitly
scored on the categories below, so each one gets entries as we go.

Append-only (`merge=union`): add at the end, never rewrite an existing entry.

**Entry format**

```
### YYYY-MM-DD — one-line summary
- **Where:** the exact page, screen, endpoint or SDK call
- **Expected / Actual:**
- **Cost:** how long it took to get past, and how
- **Fix we'd suggest:**
```

---

## Docs and integration flow

How the documentation reads end to end, and how it maps onto actually wiring
Selfie Check into a running app.

## Developer Portal

### Navigation

### Search

### Product discovery

### Debugging

## Sandbox

### States

### Proof flows

### Test users

### Errors

### Edge cases

## What was confusing

## What was missing

## What was broken

## What was hard to test

## The Graph — Subgraph Studio (MOV-215, 2026-09-07)

Not World, but this file is the catch-all for "confusing, missing, broken or
hard to test", and these cost real time.

- **A Studio deploy key cannot create the subgraph it deploys to.** `graph deploy`
  builds, uploads every file to IPFS, prints a build CID, and only then fails
  with `Subgraph not found`. Everything expensive happens before the check that
  was always going to fail. `graph create --node https://api.studio.thegraph.com/deploy/`
  answers `Method not found` — Studio's JSON-RPC exposes `subgraph_deploy` and
  nothing else. Creation is a `createSubgraph` mutation on
  `api.studio.thegraph.com/graphql`, which rejects a deploy key with
  `Please login first` and wants a wallet signature instead. So a CI-shaped
  "provision and deploy from a key" flow is not possible; a human has to click
  once in the UI first. Failing fast, or documenting it on the deploy page,
  would have saved the whole IPFS upload.
- **graph-cli >= 0.90 rejects a bare `@entity`.** Every published Messari
  schema uses bare `@entity`, so the standard's own file does not compile
  against current tooling without a mechanical edit. The error is at least
  clear and suggests the fix.
- **A non-archive RPC stalls a local graph-node silently.** With
  `ethereum-rpc.publicnode.com`, indexing stopped at
  `Scanning blocks [N, N]` and emitted no error, warning or retry log for
  minutes. The cause was `eth_call` into ~300-block-old state returning
  "Archive requests require a personal token", which graph-node never surfaced.
  A single WARN naming the failing provider would have made it obvious.

## Chainlink CRE — Confidential Workflows (MOV-227, 2026-09-07)

Built against `cre` CLI v1.32.0 and `@chainlink/cre-sdk@1.18.0`, from the
`hello-confidential-workflows-ts` template. The good news first: **the template
is excellent and the whole confidential path works in the simulator without any
private-beta enrollment.** `cre init` → `bun install` → `cre workflow simulate`
ran green on the first try, and the template's inline comments answered more
questions than the docs did — the `ConfidentialHTTPClient` warning in particular
saved a real dead end.

What cost time:

- **`CRE_API_KEY` silently breaks a working login.** The CLI prefers
  `CRE_API_KEY` over the credentials in `~/.cre/cre.yaml`, so an unrelated key
  sitting in `.env` — ours was a Data Streams key — makes *every* command fail
  `unauthorized: invalid token`, including `simulate`, which needs no account
  privileges at all. The error names neither the variable it used nor where it
  came from. `cre login --help` documents the precedence; nothing at the point
  of failure does. "Using CRE_API_KEY from /path/.env" in the error would have
  turned an hour into a minute.
- **The project `.env` also beats the shell environment**, which is the opposite
  of the usual precedence. `FOO=x cre workflow simulate …` does not override
  `FOO` in `.env`. This made a negative test pass for the wrong reason: we set a
  deliberately wrong secret, and the run succeeded with the right one.
- **`cre init --non-interactive` still demands a TTY** unless
  `--deployment-registry` and `--rpc-url` are also passed. It fails with
  "Interactive mode requires a terminal (TTY). Use --non-interactive with all
  required flags" — while `--non-interactive` is already set. Naming the two
  missing flags would be strictly better than naming the flag that is present.
- **Nothing documents whether the enclave's HTTP capability can reach
  localhost.** It can, in simulation, and that turned out to matter a lot: it
  let the seller's own evidence server be the real counterparty in the demo
  rather than a public paste. Worth a line in the Confidential Workflows page,
  because the alternative we nearly built — publishing the "confidential"
  evidence to a gist — would have been a much weaker demonstration.
- **`cre account access` cannot request access non-interactively.** It correctly
  reports "Deployment access is not yet enabled for your organization" and then
  fails with `could not open a new TTY`. A `--request` flag would let an agent
  or a CI job at least get into the queue.
- **The simulator returns a zero tx hash for `writeReport`** while
  `TxStatus.SUCCESS` comes back. That is a reasonable thing to do, and it is not
  said anywhere in the output — a line like "chain write simulated, not
  broadcast" next to the result would stop people hunting for the transaction.
- **A `writeReport` from a TEE handler requires crossing `usingTheDons()`
  first**, which the docs state, but no example shows a confidential workflow
  actually settling on chain. The keeper-bot template shows the write and the
  confidential template shows the enclave, and stitching them was guesswork that
  happened to be right. One example doing both would be the single most useful
  addition.
