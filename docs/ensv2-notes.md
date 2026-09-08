# MOV-212 — ENSv2 Sepolia addresses & call signatures (verified)

Date: 2026-09-04
Primary artifact: `github.com/ensdomains/contracts-v2` @ `48b3e2d` ("Post Audit Changes (#301)")

## TL;DR

The deployment artifacts **are published in the repo**. The earlier scraped list was
directionally right on *names* but must still be discarded — the addresses were never
corroborated, and the repo now contains two different Sepolia deployment sets whose
addresses differ entirely. Use only `contracts/deployments/sepolia/`.

Every address in `addresses.sepolia.json` was checked against Sepolia itself.

## Where the addresses come from

The project is **rocketh / hardhat-deploy style, not Foundry `broadcast/`**. There is no
`broadcast/11155111/` directory; artifacts live in:

- `contracts/deployments/sepolia/<Contract>.json` — one file per contract, `.address` field
- `contracts/docs/addresses/sepolia.md` — auto-generated table (`bun run docs:addresses`), identical values
- `contracts/deployments/sepolia/.deployment.json` — `{ environment: sepolia, chainId: 11155111, deployedAt: 2026-06-29T05:35:12.452Z }`
- `contracts/deployments/sepolia/.chain` — `{ chainId: "11155111", genesisHash: 0x25a5cc10… }`

### Two namespaces — do not mix them

| Namespace | deployedAt | Status |
| --- | --- | --- |
| `deployments/sepolia/` | 2026-06-29 | **Current — use this** |
| `deployments/sepolia-official-v1-20260525-r2/` | 2026-05-25 | Archived prior deploy; per `deployments/README.md` these contracts "remain on-chain but become orphaned once the entry point is cut over" |

Addresses differ between the two for every contract (e.g. `ETHRegistry` is
`0x67b7…4b43` current vs `0xdedb…8b67` archived). The archive also contains an
`HCAFactory` that **no longer exists in the current set** — so anything referencing a
`StandaloneHCAFactory` / `HCAFactory` address is stale.

`UpgradableUniversalResolverProxy` at `0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe` is
identical in both: it is a fixed constant entry point that gets re-pointed at the new
managed URP on each deploy.

## How I verified (bytecode-level, stronger than reading Etherscan)

1. `eth_getCode` for all 31 addresses via `https://ethereum-sepolia-rpc.publicnode.com` — **all 31 return non-empty bytecode.**
2. For the 9 contracts that matter, compared on-chain code byte-for-byte against the artifact's
   `deployedBytecode`, then checked every differing nibble against the artifact's declared
   `immutableReferences` offsets:

```
ETHRegistry              diffs=76    outside_immutables=0
RootRegistry             diffs=76    outside_immutables=0
VerifiableFactory        diffs=74    outside_immutables=0
UserRegistryImpl         diffs=184   outside_immutables=0
PermissionedResolverImpl diffs=102   outside_immutables=0
PublicResolverV2         diffs=218   outside_immutables=0
ETHRegistrar             diffs=473   outside_immutables=0
UniversalResolverV2      diffs=487   outside_immutables=0
WrapperRegistryImpl      diffs=1188  outside_immutables=0
```

Zero bytes differ outside immutable slots — the code at each address is exactly the
contract compiled from this commit.

3. **Live state check.** `RootRegistry.getSubregistry("eth")` at `0x11b5…f50c` returns
   `0x67b728a792e789a8978b30cf1b3b641f19354b43` — the ETHRegistry address. This proves the
   root/`.eth` link on-chain and confirms both addresses at once.
   (`RootRegistry.getResolver("eth")` returns the zero address.)
4. `VerifiableFactory.proxyLogic()` at `0x118b…b70f` returns `0x7e98c31ae2ac5c3c88f2ce00c22a10b8cb84bce2` — factory is live and initialised.
5. **Etherscan cross-check** (task item 4), `sepolia.etherscan.io/address/0x67b728a792e789a8978b30cf1b3b641f19354b43`:
   contract name **PermissionedRegistry**, **source verified, "Exact Match"**, creator
   `0x84D3a426D4E12E955d1DF95db0B24fe26afE39D3`, creation tx
   `0x5700e0b4ea84267da71a17def83bcdcdc49d7b1b6ee1b1de8b718e7ca5f2a7e4`, created 67 days ago —
   consistent with the artifact's `deployedAt` of 2026-06-29.

## The four addresses we actually need

| Role in our build | Artifact name | Address | Solidity contract |
| --- | --- | --- | --- |
| Root registry | `RootRegistry` | `0x11b5bfbe9078d826b1edbdd1cfc12f5828d9f50c` | `PermissionedRegistry` |
| `.eth` registry (register subname here) | `ETHRegistry` | `0x67b728a792e789a8978b30cf1b3b641f19354b43` | `PermissionedRegistry` |
| Verifiable Factory | `VerifiableFactory` | `0x118bc31a50d559f7015a8da26d54b3b030cdb70f` | `VerifiableFactory` |
| UserRegistry implementation | `UserRegistryImpl` | `0x840fa461059862ea466a711e8c98c8de732061c0` | `UserRegistry` |
| Permissioned Resolver implementation | `PermissionedResolverImpl` | `0x7e4b2d59938930168024201752ee5503df402303` | `PermissionedResolver` |

Note both `RootRegistry` and `ETHRegistry` are the **same contract type**
(`PermissionedRegistry`, `src/registry/PermissionedRegistry.sol`) deployed twice.
`PermissionedResolverImpl` and `UserRegistryImpl` are **implementations** — they are meant
to sit behind a `VerifiableFactory` proxy, not to be called directly.

## Confirmed function signatures (from source + deployed ABIs)

All of these were read from `src/` **and** cross-checked against the ABI embedded in the
deployed artifact, so they match what is actually on-chain.

### Linking a child registry into the hierarchy

`src/registry/PermissionedRegistry.sol:142`
```solidity
function setSubregistry(uint256 anyId, IRegistry registry) public virtual;
```
`src/registry/PermissionedRegistry.sol:171`
```solidity
function setParent(IRegistry parent, string memory label)
    public onlyRootRoles(RegistryRolesLib.ROLE_SET_PARENT);
```
Interface declarations: `src/registry/interfaces/IStandardRegistry.sol:71` and `:82`.
On the wire (ABI) these are `setSubregistry(uint256,address)` and `setParent(address,string)`.

`setSubregistry` requires `ROLE_SET_SUBREGISTRY` on the token; `setParent` requires
`ROLE_SET_PARENT` at root. **Both calls exist — the plan's assumption holds.**

### Enhanced Access Control

`src/access-control/EnhancedAccessControl.sol:120`
```solidity
function grantRoles(uint256 resource, uint256 roleBitmap, address account)
    public virtual canGrantRoles(resource, roleBitmap) returns (bool);
```
`src/access-control/EnhancedAccessControl.sol:134`
```solidity
function grantRootRoles(uint256 roleBitmap, address account)
    public virtual canGrantRoles(ROOT_RESOURCE, roleBitmap) returns (bool);
```
Interface: `src/access-control/interfaces/IEnhancedAccessControl.sol:66` and `:74`.

**Gotcha:** base `grantRoles` reverts with `EACRootResourceNotAllowed()` if you pass
`ROOT_RESOURCE` — you must use `grantRootRoles` for root-level grants.

**Second gotcha:** `PermissionedRegistry` *overrides* `grantRoles`
(`src/registry/PermissionedRegistry.sol:233`) so the first argument is a **token id**, not a
raw resource — it internally does `super.grantRoles(getResource(anyId), …)`. Same 3-arg
shape, different meaning.

**Correction (2026-09-07, MOV-218 — verified against the deployed contract).** This file
previously said `PermissionedResolver` has an override at `:720` "where the first arg *is* a
resource". That is **wrong**. `PermissionedResolver.grantRoles` (`:720`) and `revokeRoles`
(`:734`) are `pure` and **revert unconditionally** — the resolver *disables* the function
rather than reinterpreting its argument. Every resolver grant goes through
`authorize(Name|Text|Data|Addr)Roles` instead. Pinned by
`contracts/test/OfferRecords.t.sol:test_resolverDisablesGrantRolesEntirely`.

The two *registry* gotchas above are unchanged and still correct; only the resolver claim was
wrong.

**Second correction: three roles are per-record, not eight.** Only `setText(key)`,
`setData(key)` and `setAddr(coinType)` are part-scoped; every other role passes `part = 0`.
Three is still sufficient for the cold/hot split — they are the three that matter.

### Registration

```solidity
// PermissionedRegistry.sol:181 — direct, permissioned (needs ROLE_REGISTRAR at root)
function register(
    string memory label, address owner, IRegistry registry,
    address resolver, uint256 roleBitmap, uint64 expiry
) public virtual returns (uint256);

// ETHRegistrar — the paid, commit/reveal path for real .eth names
function commit(bytes32 commitment);
function register(string label, address owner, bytes32 secret, address subregistry,
                  address resolver, uint64 duration, address paymentToken, bytes32 referrer);
```

### Deploying a UserRegistry / PermissionedResolver proxy

`VerifiableFactory` deployed ABI (only three functions):
```solidity
function deployProxy(address implementation, uint256 salt, bytes data);
function proxyLogic() view returns (address);
function verifyContract(address proxy) view returns (bool);
event ProxyDeployed(address indexed sender, address indexed proxyAddress, uint256 salt, address implementation);
```
`data` is the ABI-encoded initializer call, run against the new proxy:
```solidity
UserRegistry.initialize(address rootAccount, uint256 roleBitmap)          // src/registry/UserRegistry.sol:43
PermissionedResolver.initialize(address admin, uint256 roleBitmap, bytes[] setters)
```

There is a **working reference implementation in the repo** —
`contracts/test/integration/fixtures/deployVerifiableProxy.ts` — a viem helper that calls
`deployProxy`, parses `ProxyDeployed` from the receipt, and also exposes
`computeVerifiableProxyAddress()` for CREATE2 pre-computation
(outer salt = `keccak256(abi.encode(deployer, salt))`, minimal-proxy bytecode
`3d604d80600a3d3981f3363d3d373d3d3d363d73<proxyLogic>5af43d82803e903d91602b57fd5bf3`).
Copy this rather than writing our own.

### Role bitmap constants — `src/registry/libraries/RegistryRolesLib.sol`

Nybble-packed; admin counterpart is the role `<< 128`.
```
ROLE_REGISTRAR          1 << 0     (root only)
ROLE_REGISTER_RESERVED  1 << 4     (root only)
ROLE_SET_PARENT         1 << 8     (root only)
ROLE_UNREGISTER         1 << 12
ROLE_RENEW              1 << 16
ROLE_SET_SUBREGISTRY    1 << 20
ROLE_SET_RESOLVER       1 << 24
ROLE_CAN_TRANSFER_ADMIN (1 << 28) << 128
ROLE_WAS_RESERVED       1 << 32    (token only, not revokable)
ROLE_SET_URI            1 << 36    (root only)
ROLE_CAN_NAME           1 << 120   (root only)
ROLE_UPGRADE            1 << 124   (root only)
```

## Corrections to the earlier scraped list

- `ETHRegistry`, `RootRegistry`, `PublicResolverV2`, `UniversalResolverV2`, `UserRegistryImpl`,
  `WrapperRegistryImpl`, `VerifiableFactory` — **these names are all real** and present in the
  current deployment. The names were fine; the addresses were the unverified part, and are now
  superseded by the values in `addresses.sepolia.json`.
- `StandaloneHCAFactory` — **does not exist.** No such string anywhere in the repo. The closest
  thing is `HCAFactory`, which exists *only* in the archived 2026-05-25 namespace and was dropped
  from the current deployment. Do not use it.
- `SimpleSubnameRegistrar` — **does not exist.** `grep -rni simplesubnameregistrar` over the whole
  repo returns nothing. `src/registrar/` contains only `AbstractETHRegistrar`, `BatchRegistrar`,
  `ETHRegistrar`, `ETHRenewerV1`, `StandardRentPriceOracle`. If the plan depends on an example
  subname registrar, **we have to write it ourselves** — model it on `PermissionedRegistry.register()`
  plus a `deployProxy` of `UserRegistryImpl`.

## Unverified / still unknown

- **Whether `deployments/sepolia/` is what `sepolia.app.ens.domains` currently points at.** I proved
  the set is internally consistent and live on-chain (root → `.eth` link resolves), but I did not
  inspect the ENS app's own network requests. Low risk: it is the repo's default namespace at HEAD
  and the root registry genuinely points at it.
- **Whether the ENS team considers this deployment stable.** `deployments/README.md` documents that
  `phase deploy-v2` archives and redeploys fresh by default, and it has already happened once
  (May → June 2026). **A redeploy would change every address except `0xeEeE…EeEe`.** Re-check at the
  start of the hackathon build.
- **Etherscan verification status of the other 30 contracts.** I checked `ETHRegistry` only. The
  bytecode comparison covers correctness regardless, but I have not confirmed each has verified
  source on Etherscan.
- **Whether we have permission to register under `.eth` on this testnet deployment.**
  `PermissionedRegistry.register()` needs `ROLE_REGISTRAR` at root, which we will not have on
  `ETHRegistry`. The realistic path is the paid `ETHRegistrar` commit/reveal flow (which accepts
  `MockDAI` / `MockUSDC` — both deployed) and then owning our own `UserRegistry` beneath it. This
  needs a practical test before we design around it.
- **`lib/verifiable-factory/` source is not checked out** (git submodule, not fetched by
  `--depth 50` clone). The `VerifiableFactory` ABI above came from the deployed artifact, which is
  authoritative for calls; the Solidity source was not read.
- `ROLE_*` values are read correctly, but I did not verify *which* roles the ENS deployer actually
  holds vs. what is delegatable to us.
