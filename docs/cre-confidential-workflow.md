# MOV-227 — Chainlink CRE confidential workflow: sell the answer, keep the method

Date: 2026-09-07
Artifacts: `seller/cre/`, `contracts/src/VerdictConsumer.sol`, `seller/service/premium.ts`
Builds on: `seller/analyst/` (MOV-216)

Turnstile's other pieces answer *how does an agent pay for one answer*. This one
answers the question underneath it: **why would a seller with a real edge ever
list?** Publishing the analyst reveals the analyst. Selling its output one query
at a time only works if the buyer cannot reconstruct the thing that produced
it — and cannot be defrauded either, because a verdict you have to take on trust
is worth nothing.

A confidential workflow is a precise answer to both halves.

---

## What actually goes where

Three things enter an attested AWS Nitro enclave and one small thing leaves.

| | What | How it gets in | Confidential? |
|---|---|---|---|
| in | the seller's **calibration** — the tuned thresholds | Vault DON secret | **yes** |
| in | the seller's **evidence bundle** — 9,218 bytes of subgraph history and live depth | confidential HTTP, gated on a Vault-held bearer token | **yes** |
| in | the **scorer** — `seller/analyst/scoring.ts` | compiled into the workflow binary | **no, and deliberately so** |
| out | rating, confidence, two 7-bit signal masks, `keccak256(evidence)` | `usingTheDons()` → `writeReport` | public |

### The line is drawn where the confidentiality actually is

This is the part that is easy to overclaim, so: **the workflow binary is not
confidential.** The Workflow DON supplies it to the enclave, and it is MIT and
readable in this repo. What the enclave protects is the *data* the binary
computes over — Vault DON secrets, the request and response payloads of HTTP
calls made from inside, and intermediate values.

So the *shape* of the judgement is public, and should be: which seven signals,
which of them are structural, how one structural failure forces `AVOID`. That is
what makes a verdict auditable rather than an oracle.

The *calibration* is not public, and that is the edge. `activeHourFailShare` is
0.2 rather than 0.1 only because a real TRUMP/WETH run said so — three traded
hours out of twenty-four, $1.54 of volume between them, coming back as merely
"bursty" at the looser threshold. Calibration is exactly what live data buys,
and it is what stays in the Vault.

This is why MOV-216's `assess()` grew a second parameter. A constant compiled
into the binary would have been published; a `Calibration` argument can arrive
from a Vault.

---

## Evidence: `cre workflow simulate`

The account has a free CRE login and **no deployment access**. That is not a
blocker for simulation, and simulation is what exercises the confidential path:
the TEE constraint, the Vault secrets, the in-enclave HTTP call, the scoring and
the crossing back to the DON all run.

Run it yourself:

```bash
npm run evidence                      # seller/cre/evidence-server.ts, port 8787
cd seller/cre
cre workflow simulate analyst-verdict --target staging-settings \
  --non-interactive --trigger-index 0
```

### Uniswap v3 USDC/WETH 0.05% — where the sealed calibration changes the answer

```
Initializing...
Loading settings...
! Using default private key for chain write simulation. To use your own key, set CRE_ETH_PRIVATE_KEY in your .env file or system environment.
Checking RPC connectivity...
Compiling workflow...
✓ Workflow compiled
✓ Simulation limits enabled
  HTTP: req=120kb resp=250kb timeout=10s | ConfHTTP: req=125kb resp=500kb timeout=1m30s | Consensus obs=25kb | ChainWrite evm_report=50kb evm_gas=10000000 solana_report=265b solana_cu=300000 | WASM binary=100mb compressed=20mb
  Binary hash: ed469e764220cfefa5461945b61ab1df340ee4974625a468c9ebd426400dcfaa
  Config hash: 44350a08b232ae8a0a85691f4877093f022e3133ca3be83a5446c9ab64c6addd
2026-09-07T16:35:51Z [SIMULATION] Simulator Initialized

2026-09-07T16:35:51Z [SIMULATION] Running trigger trigger=cron-trigger@1.0.0
╭────────────────────────────────────────────────────────────────────────────────────────────────────╮
│ Trigger requested TEE Execution your trigger will run in one of the following Tees:                │
│     - AWS Nitro in us-west-2                                                                       │
│ The simulator is not a real TEE, and is meant to debug.                                            │
│ Do not use it for sensitive information.                                                           │
│ During real execution, user logs for this trigger will not be visible, and will not leave the TEE. │
│ They are presented in the simulator for debugging only.                                            │
│                                                                                                    │
╰────────────────────────────────────────────────────────────────────────────────────────────────────╯

2026-09-07T16:35:52Z [USER LOG] evidence: 9218 bytes for Uniswap v3 USDC/WETH 0.05%, keccak256 0x60caa3841046ee545a5a91881ba92e5ce201a49048f3d3ec08ad5369c2bd02c2
2026-09-07T16:35:52Z [USER LOG] calibration: 9 sealed threshold overrides applied
2026-09-07T16:35:52Z [USER LOG] verdict: CAUTION at 75% confidence; warning on depth-vs-tvl, slippage-curve
2026-09-07T16:35:52Z [USER LOG] public calibration says ACCEPTABLE at 75%, the sealed one says CAUTION at 75% — this is the difference the Vault secret bought
2026-09-07T16:35:52Z [USER LOG] settled on ethereum-testnet-sepolia: 0x0000000000000000000000000000000000000000000000000000000000000000

✓ Workflow Simulation Result:
"CAUTION at 75% confidence; warning on depth-vs-tvl, slippage-curve — settled at 0x0000000000000000000000000000000000000000000000000000000000000000"

2026-09-07T16:35:52Z [SIMULATION] Execution finished signal received
2026-09-07T16:35:52Z [SIMULATION] Skipping WorkflowEngineV2

╭──────────────────────────────────────────────────────╮
│ Simulation complete! Ready to deploy your workflow?  │
│                                                      │
│ Run cre account access to request deployment access. │
╰──────────────────────────────────────────────────────╯
```

Four things in that output are the deliverable:

1. **`Trigger requested TEE Execution … AWS Nitro in us-west-2`** — the handler
   is registered with `cre.handlerInTee`, constrained to a named TEE type and
   region rather than to `{}`. A constraint you did not state is a constraint
   nobody verified.
2. **`evidence: 9218 bytes … keccak256 0x60caa384…`** — a real sensitive input,
   fetched from inside the enclave over confidential HTTP. The seller's endpoint
   answers `401` without the Vault-held bearer token, so the successful fetch
   *is* the proof the secret reached the enclave. Nothing logs the token.
3. **`calibration: 9 sealed threshold overrides applied`** — the second Vault
   secret, reported by count and never by value.
4. **`public calibration says ACCEPTABLE … the sealed one says CAUTION`** — the
   sealed calibration is load-bearing, not decorative. Anyone can run the public
   scorer on this pool and get `ACCEPTABLE`. The premium verdict is `CAUTION`,
   and the gap is the product.

### Uniswap v3 USDT/USDT 1% — the fake-USDT pool, where both calibrations agree

The #1 pool by TVL on our subgraph is a scam token using the symbol `USDT` with
18 decimals, paired against the real 6-decimal one. Worth including precisely
*because* the calibration makes no difference here: a pool this broken fails
structurally under any thresholds, and a premium tier that claimed to add value
on every input would be lying.

```
2026-09-07T16:36:11Z [SIMULATION] Running trigger trigger=cron-trigger@1.0.0
╭────────────────────────────────────────────────────────────────────────────────────────────────────╮
│ Trigger requested TEE Execution your trigger will run in one of the following Tees:                │
│     - AWS Nitro in us-west-2                                                                       │
│ The simulator is not a real TEE, and is meant to debug.                                            │
│ Do not use it for sensitive information.                                                           │
│ During real execution, user logs for this trigger will not be visible, and will not leave the TEE. │
│ They are presented in the simulator for debugging only.                                            │
│                                                                                                    │
╰────────────────────────────────────────────────────────────────────────────────────────────────────╯

2026-09-07T16:36:11Z [USER LOG] evidence: 2090 bytes for Uniswap v3 USDT/USDT 1%, keccak256 0xe306bbe5d857556e4accde37a546b461ac3837e6c4f419548f6b1ac2654f2bd5
2026-09-07T16:36:11Z [USER LOG] calibration: 9 sealed threshold overrides applied
2026-09-07T16:36:11Z [USER LOG] verdict: AVOID at 14% confidence; failing inventory-balance, executable-depth, depth-vs-tvl, lp-concentration
2026-09-07T16:36:11Z [USER LOG] public calibration agrees on AVOID — the edge did not change this call
2026-09-07T16:36:11Z [USER LOG] settled on ethereum-testnet-sepolia: 0x0000000000000000000000000000000000000000000000000000000000000000

✓ Workflow Simulation Result:
"AVOID at 14% confidence; failing inventory-balance, executable-depth, depth-vs-tvl, lp-concentration — settled at 0x0000000000000000000000000000000000000000000000000000000000000000"

2026-09-07T16:36:11Z [SIMULATION] Execution finished signal received
2026-09-07T16:36:11Z [SIMULATION] Skipping WorkflowEngineV2

╭──────────────────────────────────────────────────────╮
│ Simulation complete! Ready to deploy your workflow?  │
│                                                      │
│ Run cre account access to request deployment access. │
╰──────────────────────────────────────────────────────╯
```

### Without the secret, there is no verdict

Pointed at an endpoint expecting a different token, the enclave gets a `401` and
the workflow aborts rather than scoring on absent evidence:

```

2026-09-07T16:36:46Z [SIMULATION] Received interrupt signal, stopping execution
2026-09-07T16:36:46Z [SIMULATION] Skipping WorkflowEngineV2
✗ workflow execution failed: evidence fetch failed with status 401
```

---

## The one-way door

`runtime.usingTheDons()` is a documented one-way crossing: everything after it
runs on ordinary Workflow DON nodes and is no longer confidential. The workflow
crosses it exactly once, at the very end, carrying a seven-field compact verdict
and nothing else. `input`, `body` and `calibration` are never referenced again
past that line, and that is a rule rather than an accident.

What crosses:

```
address pool, uint8 rating, uint16 confidenceBp, uint8 failMask,
uint8 warnMask, uint64 assessedAt, bytes32 evidenceHash
```

224 bytes ABI-encoded; 65 bytes of actual information. What does **not** cross:
seven signal headlines, seven reasoning paragraphs, seven blocks of labelled
evidence, the summary and the caveats. That is the answer the buyer paid for.

### `evidenceHash` is the keystone

The masks make the verdict falsifiable — you can see *which* tests failed
without being told why. The hash makes it checkable:

- a buyer who has **paid** holds the 9,218-byte bundle, hashes it, and asks the
  chain whether the settled verdict commits to those exact bytes. Match, and the
  attested verdict provably concerns the evidence in their hands. Mismatch, and
  the seller substituted the evidence and the buyer can prove it;
- a passer-by who has **not** paid learns nothing from a hash.

`seller/service/premium.ts` runs that check on the buyer's behalf and reports
the result, including when it fails.

---

## On chain

Two consumers, deliberately in two files, because they make different claims.

| | Address | Forwarder | What it means |
|---|---|---|---|
| **production** | [`0xfE95CD0f710DDC5ceED0e93c4e25412Dc3d8eEeA`](https://sepolia.etherscan.io/address/0xfE95CD0f710DDC5ceED0e93c4e25412Dc3d8eEeA) | the CRE Forwarder `0xF8344CFd…` | only a DON-signed report that passed enclave attestation can write here |
| **rehearsal** | [`0xEE72d3d0E4b090eBB8Db6abc26547bcd1fc9C5F2`](https://sepolia.etherscan.io/address/0xEE72d3d0E4b090eBB8Db6abc26547bcd1fc9C5F2) | our own key | what it holds was delivered by hand |

Production deploy tx: [`0xb57fc9f277be89227dc81c6730878d421af8a43de46c20cbd3bbeb9b754a2cee`](https://sepolia.etherscan.io/tx/0xb57fc9f277be89227dc81c6730878d421af8a43de46c20cbd3bbeb9b754a2cee),
Etherscan-verified, owner `0x0Adca6e1…4bf5F2`.

### Why nothing has settled into the production consumer

Two separate gates, and being exact about them matters more than a green tick:

1. **`cre workflow deploy` needs deployment access.** `cre account access`
   (2026-09-07) answers *"Deployment access is not yet enabled for your
   organization"*, and requesting it needs an interactive TTY.
2. **Confidential Workflows is separately in private beta**, enrolled through a
   Chainlink account team. The template scaffold says so on `cre init`.

Neither gates `simulate`, which is why everything above ran.

And the simulator does not broadcast: it executes the whole write path,
`writeReport` returns `TxStatus.SUCCESS`, and the tx hash comes back as
`0x0000…0000`. So the chain write is simulated, not sent.

### What the rehearsal settlement does prove

`seller/cre/settle-cli.ts` re-runs `assess()` **outside** the enclave over the
same fixture with the same calibration, and gets a byte-identical verdict:

```
pool          Uniswap v3 USDC/WETH 0.05%  0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640
evidence      9218 bytes, keccak256 0x60caa3841046ee545a5a91881ba92e5ce201a49048f3d3ec08ad5369c2bd02c2
calibration   9 sealed overrides
verdict       CAUTION at 75% confidence; warning on depth-vs-tvl, slippage-curve
round trip    ok

tx            0x8ee33bb38563ed88836eaf6e2b7011c1350ef64390f7307691da24bd45e909b8
status        success  block 11654749  gas 170327
explorer      https://sepolia.etherscan.io/tx/0x8ee33bb38563ed88836eaf6e2b7011c1350ef64390f7307691da24bd45e909b8

read back from chain:
  rating        1  (CAUTION)
  confidenceBp  7500
  failMask      0b0000000
  warnMask      0b0001100
  assessedAt    1788789738
  evidenceHash  0x60caa3841046ee545a5a91881ba92e5ce201a49048f3d3ec08ad5369c2bd02c2
  ✓ the chain commits to the exact bundle on disk — this is the check a buyer runs
```

That match is the property the entire attestation argument rests on —
`assess()` is a total function of its argument, so the same evidence and the
same calibration give the same verdict inside a TEE and outside one — exercised
rather than asserted. It says nothing about attestation, and
`premium.ts` classifies this consumer as `self-delivered` rather than
`attested` for exactly that reason.

---

## The premium tier

```bash
node seller/service/premium-cli.ts \
  --evidence seller/cre/fixtures/usdc-weth-500.json \
  --consumer 0xEE72d3d0E4b090eBB8Db6abc26547bcd1fc9C5F2
```

`answerPremium()` returns the full verdict plus a pointer to the settled record,
with the buyer's verification already run.

The on-chain half deliberately does **not** live in `seller/service/`. MOV-219's
`no-chain-code.test.ts` asserts that nothing on the payment path names a chain,
a vendor, an asset or a chain library, and it caught the first version of
`premium.ts` on the merge. The guard was right: the service composes rails, and
the moment it knows what Sepolia is, the abstraction that lets two rails share
it is gone. So everything that knows about `VerdictConsumer`, the Forwarder and
an RPC endpoint moved to `seller/cre/attestation.ts`, and `premium.ts` takes an
`AttestationReader` — `(pool, evidenceHash, answerRating) => Attestation`. Same
boundary, second kind of chain dependency.

The field worth arguing about is `AttestationStrength`, which has four values
rather than being a boolean:

| Value | Means |
|---|---|
| `attested` | the CRE Forwarder, from a pinned workflow id. The full claim. |
| `forwarded-ungated` | the CRE Forwarder, but the consumer would accept any workflow this owner deploys |
| `self-delivered` | not the CRE Forwarder. Somebody wrote this by hand. |
| `none` | nothing has settled for this pool |

Collapsing those into `verified: true` is the one bug that would make the tier
worthless, because three of the four are not the claim. Run against the
rehearsal consumer today it reports `self-delivered`, in a sentence a buyer can
act on.

An unjudged pool reads `INSUFFICIENT_DATA`, never `ACCEPTABLE` — on chain too,
where `verdictOf()` reverts rather than returning a zero struct, because a
zeroed `Verdict` decodes as `ACCEPTABLE` at 0% confidence.

---

## Things that cost time, for whoever comes next

- **`CRE_API_KEY` in `.env` broke every CLI command.** It is a Data Streams key,
  and `cre` rejects it with `unauthorized: invalid token` — including `workflow
  simulate`, which needs no deploy access at all. The CLI prefers `CRE_API_KEY`
  over the saved browser login, so setting it silently breaks a working setup.
  Now commented out in `.env` with a note. The browser login in `~/.cre/cre.yaml`
  authenticates fine.
- **The CLI's `.env` beats the shell environment.** Exporting a variable before
  `cre workflow simulate` does not override the same name in the project `.env`,
  which made a negative test silently pass. Change the file, or point somewhere
  else.
- **The enclave can reach `127.0.0.1` in simulation.** Not documented anywhere we
  found, and it is what lets the seller's own evidence server be the real
  counterparty instead of a public paste.
- **TypeScript, not Go.** The Go SDK pins unreleased pseudo-versions for
  Confidential Workflows; the TS SDK ships it in `@chainlink/cre-sdk@1.18.0`.
- **Pin the SDK exactly.** The API moves between releases — `handlerInTee`, the
  `TeeRuntime` overloads and the report helpers are all recent — and the
  workflow is only ever exercised by `simulate`, so a floating range breaks it
  quietly.
- **Do not use `ConfidentialHTTPClient` inside a TEE handler.** It has no
  `TeeRuntime` overload. `HTTPClient.sendRequest()` does, and that overload is
  what makes the call confidential.
- **CREATE2 makes the constructor's `msg.sender` the factory.** The first
  `VerdictConsumer` deploy handed ownership to `0x4e59b448…` and left
  `setExpectedWorkflowId` permanently uncallable. The owner is a constructor
  argument now.
- **`cre init` needs `--deployment-registry` and `--rpc-url` under
  `--non-interactive`**, or it fails with "interactive mode requires a terminal"
  despite the flag.

## Still unverified

- **Real enclave attestation.** Everything above ran in the simulator, which
  states plainly that it *is not a real TEE*. The attestation-verification step
  the Workflow DON performs before signing has not been exercised, and cannot be
  until deployment access and the Confidential Workflows beta are both granted.
- **The production consumer's identity gates.** `expectedAuthor` and
  `expectedWorkflowId` are unset, because a workflow id does not exist until the
  workflow is registered. `verdictsAreGated()` returns `false` and says so.
- **The Vault DON's own secret release path.** In simulation the secrets come
  from `.env` via `secrets.yaml`; `cre secrets` against the real Vault gateway
  was not run.
