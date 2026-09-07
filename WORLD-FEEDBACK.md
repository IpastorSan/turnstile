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
