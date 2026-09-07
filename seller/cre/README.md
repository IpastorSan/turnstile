# seller/cre — the premium tier, scored inside a TEE

**Correction (2026-09-07, MOV-227):** this file previously read, in full,
*"Chainlink CRE confidential workflow (TypeScript). Must register and use
`cre.handlerInTee`."* That was a stub, not a claim, and it is now built. The
`handlerInTee` requirement was right and is met.

The full write-up, with the terminal output, the on-chain addresses and the
things that cost time, is `docs/cre-confidential-workflow.md`. This file is the
map.

---

## The problem this solves

Turnstile's other pieces answer *how does an agent pay for one answer*. This one
answers the question underneath: **why would a seller with a real edge ever
list?** Publishing the analyst reveals the analyst.

Three things go into an attested AWS Nitro enclave and one small thing comes
out:

```
  seller's calibration ──Vault DON secret──┐
                                           ├──▶ [ enclave: assess() ] ──┐
  evidence bundle ──confidential HTTP──────┘                            │
   (9,218 bytes, 401 without the sealed bearer token)                   │
                                                                        │
                                              usingTheDons() ◀──────────┘
                                                    │  one-way door
                                                    ▼
                          rating · confidence · failMask · warnMask
                          · assessedAt · keccak256(evidence)
                                                    │
                                                    ▼  writeReport
                                          VerdictConsumer on Sepolia
```

The buyer gets a verdict they can **verify** and cannot **reproduce**. Sell the
answer, keep the method.

### What is confidential, exactly

Easy to overclaim, so: the workflow **binary is not confidential**. The Workflow
DON hands it to the enclave, and it is MIT and readable right here. The enclave
protects the *data* the binary computes over — Vault secrets, HTTP request and
response payloads, intermediate values.

So the *shape* of the judgement is public, and should be — that is what makes a
verdict auditable rather than an oracle. The *calibration* is not, and that is
the edge. This is why `assess()` grew a `Calibration` parameter in MOV-227: a
constant compiled into the binary is a published constant.

---

## Layout

```
verdict.ts             The narrow waist: what may cross the boundary, and its encoding.
                       Imported by the workflow (inside the TEE) and by premium.ts.
verdict.test.ts        13 tests. Pins the bit order, the round trip, and the
                       determinism claim the whole attestation rests on.
attestation.ts         Reads a settled verdict and grades how much it is worth.
                       Lives here rather than in seller/service/ because that
                       directory must not name a chain — see its header.
attestation.test.ts    8 tests, all about refusing to overclaim.
evidence-server.ts     The seller's side: serves an AnalystInput behind a bearer
                       token the Vault releases into the enclave. 401 otherwise.
settle-cli.ts          Rehearsal settlement — READ ITS HEADER before quoting it.
fixtures/              Two real bundles, captured 2026-09-07 against live data.
secrets.yaml           EVIDENCE_TOKEN and CALIBRATION → env var names.
project.yaml           Sepolia RPCs per target.
analyst-verdict/       The workflow. Own package.json, own pinned SDK, own tsconfig.
```

`analyst-verdict/` is excluded from the repo-root `tsconfig.json` and typechecked
by `npm run typecheck:cre`. It has to be: it compiles to WASM against a pinned
`@chainlink/cre-sdk` whose export map only resolves under `moduleResolution:
"bundler"`, and the root uses `nodenext`.

---

## Run it

```bash
npm run evidence          # evidence server on :8787, gated on TURNSTILE_EVIDENCE_TOKEN
cd seller/cre
cre workflow simulate analyst-verdict --target staging-settings \
  --non-interactive --trigger-index 0
```

You need the `cre` CLI (`smartcontractkit/cre-cli` releases) and a free CRE
account. **Simulation does not need deployment access and does not need the
Confidential Workflows private beta** — verified 2026-09-07 against v1.32.0.
Only `cre workflow deploy` is gated.

`config.staging.json` points at Uniswap v3 USDC/WETH 0.05%, the pool where the
sealed calibration changes the answer. Point `evidenceUrl` at
`…/0x3dcb9530eea449e6e8ace451419cfaf6f9b72394` for the fake-USDT pool, where it
does not — a premium tier that claimed to add value on every input would be
lying.

---

## Gotchas

- **`CRE_API_KEY` in `.env` breaks every `cre` command.** It is a Data Streams
  key; `cre` answers `unauthorized: invalid token`, including for `simulate`.
  The CLI prefers it over the saved browser login, so setting it silently
  breaks a working setup. It is commented out in `.env` with a note. Log in
  with `cre login` instead — that writes `~/.cre/cre.yaml` and works.
- **The CLI's `.env` beats the shell environment.** `TURNSTILE_EVIDENCE_TOKEN=x
  cre workflow simulate …` does *not* override the value in the project `.env`.
  A negative test written that way passes for the wrong reason.
- **The enclave can reach `127.0.0.1` in simulation.** Undocumented as far as we
  found, and it is what lets the seller's own server be the real counterparty.
- **Never `ConfidentialHTTPClient` inside a TEE handler** — no `TeeRuntime`
  overload. `HTTPClient.sendRequest()` has one, and that overload is the thing
  that makes the call confidential.
- **Pin the SDK exactly** (`1.18.0`, not `^1.18.0`). The API moves between
  releases and the workflow is only exercised by `simulate`, so drift breaks it
  quietly.
- **Nothing logs a secret.** The calibration is reported by *count* of overrides;
  the evidence token is never printed at all — a successful fetch through a
  401-gated endpoint is the proof it arrived. Enclave logs do not leave the TEE
  in a real run, but that is not a reason to put a secret in one.

## Test

```bash
npm test                  # includes verdict.test.ts and attestation.test.ts
npm run typecheck         # the repo
npm run typecheck:cre     # the workflow, against the real SDK
```
