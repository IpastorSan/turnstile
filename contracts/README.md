# contracts

Foundry project — ENSv2 subname registry + registrar, for **Sepolia**.

| Path | What |
| --- | --- |
| `src/TurnstileRegistry.sol` | Deploy seam for the registry: a `UserRegistry` proxy through ENS's `VerifiableFactory`, plus the three role bitmaps |
| `src/TurnstileRegistrar.sol` | Pricing, availability, mint, renew. Written from scratch — `SimpleSubnameRegistrar` does not exist |
| `script/EnsSepolia.sol` | Loads ENS's addresses from `addresses.sepolia.json` at run time |
| `script/Deploy.s.sol` | Idempotent deployment |
| `test/` | 31 local tests, 6 against a live Sepolia fork |
| `addresses.sepolia.json` | MOV-212's verified record of **ENS's** deployment. Read-only to us |
| `addresses.turnstile.sepolia.json` | Written by `Deploy.s.sol`. **Ours** |

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
