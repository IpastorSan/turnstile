# contracts

Foundry project, for **Sepolia**. Two unrelated things live here: the ENSv2
subname registry + registrar, and the settlement point for the CRE confidential
workflow's verdicts.

| Path | What |
| --- | --- |
| `src/TurnstileRegistry.sol` | Deploy seam for the registry: a `UserRegistry` proxy through ENS's `VerifiableFactory`, plus the three role bitmaps |
| `src/TurnstileRegistrar.sol` | Pricing, availability, mint, renew. Written from scratch — `SimpleSubnameRegistrar` does not exist |
| `src/VerdictConsumer.sol` | MOV-227. Receives the CRE Forwarder's report and stores the enclave's LP-safety verdict: rating, confidence, two signal masks, and a keccak256 commitment to the evidence |
| `script/EnsSepolia.sol` | Loads ENS's addresses from `addresses.sepolia.json` at run time |
| `script/Deploy.s.sol` | Idempotent deployment of the registry + registrar |
| `script/DeployVerdictConsumer.s.sol` | Idempotent CREATE2 deployment of the consumer |
| `test/` | 77 local tests, 13 against a live Sepolia fork |
| `addresses.sepolia.json` | MOV-212's verified record of **ENS's** deployment. Read-only to us |
| `addresses.turnstile.sepolia.json` | Written by `Deploy.s.sol`. **Ours** |
| `addresses.verdict.sepolia.json` | The **production** consumer — gated on the real CRE Forwarder |
| `addresses.verdict-rehearsal.sepolia.json` | A second consumer whose forwarder is our own key. **Read its note before quoting anything it holds** |

**Correction (2026-09-07, MOV-227):** the row above previously said "31 local
tests, 6 against a live Sepolia fork". Both numbers were already stale before
this branch — MOV-218 added `OfferRecords.t.sol` (22 local) and
`test/fork/SepoliaOffer.t.sol` (7 fork) without updating them. MOV-227 adds
`VerdictConsumer.t.sol` (24, two of them fuzz properties). Counted against
`forge test` on 2026-09-07: **77 local, 13 fork, 90 total**. Worth re-counting
rather than incrementing, since this row has now been wrong twice.

## VerdictConsumer, and the two deployments

`VerdictConsumer` is where a verdict produced inside a Chainlink CRE confidential
workflow settles. The claim it makes is not "the seller says AVOID" but "an
attested enclave, over evidence committed to by this hash, said AVOID" — the
Workflow DON signs the report only after verifying the enclave's attestation.
Full write-up in [`../docs/cre-confidential-workflow.md`](../docs/cre-confidential-workflow.md).

There are **two** deployments and conflating them would be the worst kind of
mistake this repo could make:

| | Address | Forwarder | Holds |
|---|---|---|---|
| production | `0xfE95CD0f710DDC5ceED0e93c4e25412Dc3d8eEeA` | the CRE Forwarder `0xF8344CFd…` | nothing yet — waiting for `cre workflow deploy`, which needs deployment access this org does not have |
| rehearsal | `0xEE72d3d0E4b090eBB8Db6abc26547bcd1fc9C5F2` | our own key | one verdict, delivered by hand. Proves the encoding and the evidence commitment; proves **nothing** about attestation |

`seller/service/premium.ts` reads `forwarder()` and `verdictsAreGated()` and
reports the difference as `attested` / `forwarded-ungated` / `self-delivered` /
`none` rather than as a boolean, for exactly this reason.

Three refusals in the contract are deliberate and each defends against a silent
failure being worse than a loud one: `verdictOf()` reverts on an unjudged pool
rather than returning a zero struct (which decodes as `ACCEPTABLE` at 0%
confidence); a rating outside the enum is rejected rather than stored (7 would
read to every consumer as "not ACCEPTABLE", so it would look like a judgement);
and a report whose `assessedAt` is not newer than the stored one reverts, so a
favourable old verdict cannot be replayed over a bad new one.

Design notes, the role model, the two `grantRoles` traps and what is left to run
are in [`../docs/ensv2-deploy.md`](../docs/ensv2-deploy.md).

## Where the ENS addresses come from

`addresses.sepolia.json` is MOV-212's output and every address in it was checked
against Sepolia: `eth_getCode` compared byte-for-byte against each deployment
artifact, with all differences falling strictly inside declared
`immutableReferences` slots. Method, the Etherscan cross-check and the open
questions are in [`../docs/ensv2-notes.md`](../docs/ensv2-notes.md).

Two things that cost time the first time round, recorded so they do not again:

- contracts-v2 is **rocketh / hardhat-deploy**, not Foundry. There is no
  `broadcast/11155111/` to grep — artifacts live at
  `contracts/deployments/sepolia/<Name>.json`, with the address in `.address`.
- The repo carries **two** Sepolia namespaces. `deployments/sepolia-official-v1-20260525-r2/`
  is an archived prior deploy whose addresses differ for every contract. Only
  `deployments/sepolia/` is current.

⚠️ These are **pinned, not permanent.** They describe the deployment of
2026-06-29. ENS's `phase deploy-v2` archives and redeploys fresh by default and
has already done so once (May → June 2026); a redeploy changes every address
except `0xeEeE…EeEe`. Re-check before deploying — the canary below does it on
every test run.

ENS features must be **central, not cosmetic**, and the demo must run with **no
hard-coded values** — both are binary gates in `CHECKLIST.md`. Hence
`EnsSepolia`: an ENS redeploy is a one-file regeneration, not a recompile.

## Toolchain

Foundry 1.8.1 (`forge`, `cast`, `anvil`, `chisel`), installed at
`~/.config/.foundry/bin` — the installer honored `XDG_CONFIG_HOME`, so it is not
the usual `~/.foundry`. The `PATH` export is already in `~/.bashrc`.

```bash
forge --version   # forge Version: 1.8.1
```

Dependencies are git submodules pinned to exactly the revisions
`ensdomains/contracts-v2` pins in its own `foundry.lock`, so the ENS contracts we
compile against are the ones deployed on Sepolia. After a fresh clone:

```bash
git submodule update --init --recursive
```

## Tests

```bash
forge test                                # everything
forge test --match-path 'test/fork/*' -vv # just the fork tests
```

The fork tests hit `https://ethereum-sepolia-rpc.publicnode.com` by default —
read-only forking needs no API key. Set `SEPOLIA_RPC_URL` to override. They skip
rather than fail when the endpoint is unreachable, so a network-less run cannot
look like a passing canary.

⚠️ `testFork_ethIsStillTheKnownEthRegistry` is the **redeploy canary**. It
asserts `RootRegistry.getSubregistry("eth")` still returns the `ETHRegistry` we
recorded — one call that proves both addresses and proves the root/`.eth` link is
live, which `eth_getCode` cannot. If it fails, ENS has redeployed and every
address in `addresses.sepolia.json` is stale: regenerate the file from
`contracts/deployments/sepolia/` at the new revision and re-check everything that
consumed it.

## Deploying

Needs a funded Sepolia key, which does not exist yet (MOV-211). Nothing has been
broadcast.

```bash
forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$SEPOLIA_RPC_URL" --broadcast --verify
```

Environment and the full remaining checklist are in
[`../docs/ensv2-deploy.md`](../docs/ensv2-deploy.md).
