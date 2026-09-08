# MOV-217 — ENSv2 subname registry + registrar

Date: 2026-09-04
Builds on: `docs/ensv2-notes.md` (MOV-212), `contracts/addresses.sepolia.json`

## What exists

| File | What it is |
| --- | --- |
| `contracts/src/TurnstileRegistry.sol` | Library: proxy deployment, CREATE2 pre-computation, the three role bitmaps |
| `contracts/src/TurnstileRegistrar.sol` | Contract: pricing, availability, mint, renew |
| `contracts/script/EnsSepolia.sol` | Loads ENS addresses from `addresses.sepolia.json` at run time |
| `contracts/script/Deploy.s.sol` | Idempotent Sepolia deployment |
| `contracts/test/` | 37 tests — 31 local, 6 against a live Sepolia fork |

**Nothing is deployed.** There is no funded Sepolia key yet (MOV-211). Everything
below has been run in simulation against live Sepolia state; nothing has been
broadcast.

## Shape

```
RootRegistry  0x11b5…f50c
  └── "eth" ──> ETHRegistry  0x67b7…4b43            (ENS's, we own nothing here yet)
        └── "turnstile" ──> TurnstileRegistry       (ours: a UserRegistry proxy)
              └── "alice"  ──> alice.turnstile.eth  (sold by TurnstileRegistrar)
```

The Turnstile registry is **not a bespoke contract.** It is an instance of ENS's
own `UserRegistry`, deployed as a verifiable proxy through the canonical
`VerifiableFactory`. That is what makes `VerifiableFactory.verifyContract(proxy)`
worth anything to a buyer's agent: it recomputes the proxy's CREATE2 address and
returns its implementation, so anyone can check our registry is stock
`UserRegistry` rather than a look-alike. A custom implementation would throw that
away for nothing — all of Turnstile's policy lives in the registrar, outside the
registry.

`SimpleSubnameRegistrar`, which the ENSv2 docs say to model the registrar on,
**does not exist**; MOV-212 established that and this issue confirmed it.
`TurnstileRegistrar` is written from scratch against `IPermissionedRegistry`.

## Who may do what

Three bitmaps, in `TurnstileRegistry.sol`.

| Holder | Roles | Rationale |
| --- | --- | --- |
| Operator (cold tier) | `REGISTRAR`, `RENEW`, `UNREGISTER`, `SET_PARENT`, `SET_URI`, `CAN_NAME`, `UPGRADE` — each with its `_ADMIN` half | Owns the namespace and delegates from there |
| `TurnstileRegistrar` | `REGISTRAR`, `RENEW`, no `_ADMIN` half at all | Sells and extends names. Cannot delete them, re-parent, upgrade, or appoint another registrar |
| Subname buyer (per token) | `SET_RESOLVER`, `SET_SUBREGISTRY`, both `_ADMIN` halves, `CAN_TRANSFER_ADMIN` | Full control of their own name. No `RENEW` — renewal is priced, so it goes through the registrar |

Both halves for the operator is not belt-and-braces. `hasRootRoles` compares raw
bitmaps and does **not** apply the "admin implies regular" rule that
`_getSettableRoles` does, so an operator holding only `ROLE_SET_PARENT_ADMIN`
could delegate `setParent` to a third party but not call it themselves.

The registrar's envelope is the same invariant as the key tiers in `CLAUDE.md`:
the thing that transacts every day may never raise its own limit.

## The two grant traps

Both are silent — the wrong call compiles.

1. `EnhancedAccessControl.grantRoles(resource, …)` reverts `EACRootResourceNotAllowed()`
   when handed `ROOT_RESOURCE`. Root grants must use `grantRootRoles(bitmap, account)`.

2. `PermissionedRegistry` **overrides** `grantRoles` (`PermissionedRegistry.sol:233`)
   so its first argument is a **token id**, forwarded as `getResource(anyId)`.
   `PermissionedResolver.sol:720` has an override at the same arity whose first
   argument *is* a resource. Identical signatures, opposite meanings.

`contracts/test/Roles.t.sol` pins both. Writing it turned up **why the mix-up
survives review**: on a freshly registered name both version counters are zero,
so the token id and the resource are literally the same number and either
argument appears to work. They only diverge after the first role grant, which
regenerates the token (bumping `tokenVersionId`) while leaving `eacVersionId`
alone. The test asserts the coincidence, forces the divergence, then checks the
grant landed on the resource and never reached root.

## Corrections to MOV-212's notes

Both are in the `VerifiableFactory` ABI. Neither changes a selector, so nothing
MOV-212 verified is affected — but anyone coding from the notes would get it
wrong.

| MOV-212 recorded | Actually |
| --- | --- |
| `verifyContract(address) view returns (bool)` | `returns (address implementation)` |
| `deployProxy(address,uint256,bytes)` (no return) | `returns (address)` |

Source: the deployed ABI in `contracts/deployments/sepolia/VerifiableFactory.json`,
the `ensdomains/verifiable-factory` source at the pinned revision, and
`testFork_verifyContractReturnsAnImplementationAddress` calling the live contract.

Everything else in MOV-212's notes checked out exactly — the addresses, the
function signatures, the role constants, the two `grantRoles` traps, the
non-existence of `SimpleSubnameRegistrar`, and the `deployVerifiableProxy.ts`
address derivation.

## Redeploy canary

`testFork_ethIsStillTheKnownEthRegistry` asserts
`RootRegistry.getSubregistry("eth") == 0x67b728a792e789a8978b30cf1b3b641f19354b43`
against live Sepolia. One call proves both addresses and proves the root/`.eth`
link is live, which `eth_getCode` cannot.

**As of 2026-09-04 it passes.** ENS has not redeployed since MOV-212 recorded the
addresses. If it ever fails, `phase deploy-v2` has archived and redeployed —
regenerate `addresses.sepolia.json` from `contracts/deployments/sepolia/` at the
new revision and re-check every issue that consumed it.

The test also hard-codes the known address, so editing the JSON fails it too.

## Running it

```bash
cd contracts
forge test                      # 37 tests; the 6 fork tests need network, no key
forge test --match-path 'test/fork/*' -vv
```

Fork tests skip rather than fail when the RPC is unreachable, so a network-less
CI run cannot look like a passing canary.

## What is left, once a funded key exists

1. **Buy the parent name.** `turnstile.eth` is currently `AVAILABLE` with no
   owner (checked on-chain, 2026-09-04). We hold no `ROLE_REGISTRAR` on ENS's
   `.eth` registry — `testFork_weHoldNoRegistrarRoleOnTheEthRegistry` asserts
   this — so `ETHRegistry.register` is not open to us. The path is the paid
   `ETHRegistrar` commit/reveal flow at `0xa4449a0dd2b83007553d9b1d28b583a46a805a30`,
   which accepts `MockDAI` / `MockUSDC`, both deployed on Sepolia.

2. **Deploy.** With `DEPLOYER_PRIVATE_KEY` set:

   ```bash
   cd contracts
   forge script script/Deploy.s.sol:Deploy \
     --rpc-url "${SEPOLIA_RPC_URL:-https://ethereum-sepolia-rpc.publicnode.com}" \
     --broadcast --verify
   ```

   Estimated cost from the dry run: **0.0057 ETH** (2,624,905 gas).

   Run it before step 1 if you like — it is idempotent, and the
   `setSubregistry` step skips with a note until we own the parent. Re-run after
   buying the name and it picks that step up.

3. **Capture the transactions.** Per `CLAUDE.md`, every on-chain transaction gets
   its hash, explorer link and terminal output recorded in `docs/` the first time
   it works.

4. **Tick the ENS gates** in `CHECKLIST.md` once the demo runs end to end.

### Dry run, 2026-09-04

Against live Sepolia, no `--broadcast`, throwaway key:

```
deployer           0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
VerifiableFactory  0x118Bc31A50d559F7015a8Da26d54B3b030CdB70F
UserRegistryImpl   0x840Fa461059862Ea466A711E8C98c8dE732061C0
ETHRegistry        0x67b728a792e789a8978b30cF1b3b641f19354b43
registry           0xb443C5ab74C1a349BF04777953758EAd828d3246 (deployed)
registrar          0x778d3BEF3345117F9A144052afb02C9Cc56F409E (deployed)
roles              granted to the registrar
parent             set
subregistry        SKIPPED - we do not own the parent name
```

Both CREATE2 predictions held — the script `require`s that and did not revert.
The addresses above are an artefact of the throwaway key and will differ for the
real deployer.

## Open / not verified

- **Whether the paid `ETHRegistrar` flow works for us in practice.** MOV-212
  flagged it, and it still needs a funded key to test. Everything downstream of
  owning `turnstile.eth` is proven; acquiring it is not.
- **Etherscan verification of our two contracts.** `--verify` is in the command
  above but has never been exercised, and needs `ETHERSCAN_API_KEY`.
- **Pricing is a placeholder.** 0.01 / 0.005 / 0.001 ETH per year by label
  length. Set deliberately before the demo.
- **Label policy is ASCII-only** (`a-z0-9-`, no leading or trailing hyphen,
  3–63 bytes). Stricter than ENS, which takes normalised unicode. The narrowing
  is deliberate — `LibLabel.id` is a plain keccak of raw bytes, so a label
  containing `.` would mint a name with no well-defined position in the
  hierarchy, and on-chain is the only place that can be caught. Buyers wanting a
  unicode subname must normalise and punycode off-chain first.
- **`LabelStore` is mocked in the local tests**, because the real one drags in
  `NameCoder` and `DelegatedContractNamer` from ens-contracts. The fork tests use
  the live `LabelStore` at `0xb03524289c16424f71802a1794c29c7bd1b9f577` and
  round-trip a label through it, so the mock is not load-bearing.
