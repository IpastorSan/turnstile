// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";

import {CloneProxyBytecode} from "@ensdomains/verifiable-factory/CloneProxyBytecode.sol";
import {IVerifiableFactory} from "@ensdomains/verifiable-factory/IVerifiableFactory.sol";

import {IPermissionedRegistry} from "@ens/v2/registry/interfaces/IPermissionedRegistry.sol";
import {RegistryRolesLib} from "@ens/v2/registry/libraries/RegistryRolesLib.sol";
import {UserRegistry} from "@ens/v2/registry/UserRegistry.sol";

/// @title TurnstileRegistry
/// @notice The registry that holds Turnstile's subnames — everything under the
///         seller's ENSv2 name, e.g. `alice.turnstile.eth`.
///
/// There is deliberately **no bespoke registry implementation in this repo.** The
/// Turnstile registry is an instance of ENS's own `UserRegistry`, deployed as a
/// verifiable proxy through the canonical `VerifiableFactory`. That is the whole
/// point of the factory: `VerifiableFactory.verifyContract(proxy)` recomputes the
/// proxy's CREATE2 address and returns its implementation, so anyone — the ENS
/// app, an indexer, a buyer's agent — can check that our registry is a stock
/// `UserRegistry` and not a look-alike with a rug in it. A custom implementation
/// would throw that away for no gain: all of Turnstile's policy (pricing,
/// availability, who may mint) lives in `TurnstileRegistrar`, outside the registry.
///
/// What this library provides is the deployment seam:
///
/// * `predictAddress` — CREATE2 pre-computation, so the registrar address and the
///   registry address are both known before either is deployed.
/// * `deploy` — the `deployProxy` call with the right initializer encoding.
/// * the two role bitmaps that define who may do what on the resulting registry.
///
/// Ported from `contracts/test/integration/fixtures/deployVerifiableProxy.ts` in
/// ensdomains/contracts-v2 rev 48b3e2d. The clone creation code is not re-derived
/// here — it is `CloneProxyBytecode.creationCode`, the same library the deployed
/// factory itself uses, so the two cannot drift.
library TurnstileRegistry {
    ////////////////////////////////////////////////////////////////////////
    // Role bitmaps
    ////////////////////////////////////////////////////////////////////////

    /// @notice Root roles held by the seller's operator identity — the cold tier
    ///         (`wallet-cli ring`), which owns the name and delegates from there.
    ///
    /// Both the regular role and its `_ADMIN` counterpart are granted for each
    /// capability, and the distinction is not cosmetic:
    ///
    /// * the regular role is what `onlyRootRoles(...)` checks, so it is what lets
    ///   the operator *use* the capability (e.g. call `setParent`);
    /// * the `_ADMIN` role is what `_getSettableRoles` checks, so it is what lets
    ///   the operator *delegate* the capability to someone else.
    ///
    /// `hasRootRoles` compares raw bitmaps and does **not** apply the "admin implies
    /// regular" rule — holding only `ROLE_SET_PARENT_ADMIN` would let the operator
    /// grant `ROLE_SET_PARENT` to a third party but not call `setParent` itself.
    uint256 internal constant OPERATOR_ROOT_ROLES =
        RegistryRolesLib.ROLE_REGISTRAR |
        RegistryRolesLib.ROLE_REGISTRAR_ADMIN |
        RegistryRolesLib.ROLE_RENEW |
        RegistryRolesLib.ROLE_RENEW_ADMIN |
        RegistryRolesLib.ROLE_UNREGISTER |
        RegistryRolesLib.ROLE_UNREGISTER_ADMIN |
        RegistryRolesLib.ROLE_SET_PARENT |
        RegistryRolesLib.ROLE_SET_PARENT_ADMIN |
        RegistryRolesLib.ROLE_SET_URI |
        RegistryRolesLib.ROLE_SET_URI_ADMIN |
        RegistryRolesLib.ROLE_CAN_NAME |
        RegistryRolesLib.ROLE_CAN_NAME_ADMIN |
        RegistryRolesLib.ROLE_UPGRADE |
        RegistryRolesLib.ROLE_UPGRADE_ADMIN;

    /// @notice Root roles granted to `TurnstileRegistrar`.
    ///
    /// Mint and renew, and nothing else. In particular **not** `ROLE_UNREGISTER`:
    /// the contract that takes buyers' money must not be able to delete the names
    /// it sold, and not `ROLE_UPGRADE` or `ROLE_SET_PARENT`, which would let it
    /// widen its own authority. Same invariant as the key tiers in CLAUDE.md —
    /// the thing that transacts every day may never raise its own limit.
    ///
    /// These are regular roles only. The registrar delegates nothing, so it needs
    /// no `_ADMIN` counterparts.
    uint256 internal constant REGISTRAR_ROOT_ROLES =
        RegistryRolesLib.ROLE_REGISTRAR | RegistryRolesLib.ROLE_RENEW;

    /// @notice Roles granted to the buyer of a subname, on that subname's own
    ///         token resource, at registration time.
    ///
    /// Token *admin* roles can only ever be assigned during registration —
    /// `PermissionedRegistry._getSettableRoles` returns `roleBitmap >> 128` for a
    /// non-root resource, so no later `grantRoles` call can add them. This bitmap
    /// is therefore the buyer's permanent envelope.
    ///
    /// Deliberately excluded: `ROLE_RENEW` (renewal is priced, so it goes through
    /// the registrar) and `ROLE_UNREGISTER`.
    uint256 internal constant SUBNAME_OWNER_ROLES =
        RegistryRolesLib.ROLE_SET_RESOLVER |
        RegistryRolesLib.ROLE_SET_RESOLVER_ADMIN |
        RegistryRolesLib.ROLE_SET_SUBREGISTRY |
        RegistryRolesLib.ROLE_SET_SUBREGISTRY_ADMIN |
        RegistryRolesLib.ROLE_CAN_TRANSFER_ADMIN;

    ////////////////////////////////////////////////////////////////////////
    // Deployment
    ////////////////////////////////////////////////////////////////////////

    /// @notice ABI-encoded `UserRegistry.initialize` call, run against the fresh
    ///         proxy by `VerifiableFactory.deployProxy`.
    /// @param rootAccount The account granted root roles on the new registry.
    /// @param roleBitmap The root roles to grant it — normally `OPERATOR_ROOT_ROLES`.
    function initializerData(address rootAccount, uint256 roleBitmap)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(UserRegistry.initialize, (rootAccount, roleBitmap));
    }

    /// @notice Deploy the Turnstile registry as a `UserRegistry` verifiable proxy.
    /// @param factory The `VerifiableFactory`.
    /// @param userRegistryImpl The canonical `UserRegistry` implementation.
    /// @param salt Caller-chosen salt. The factory derives its CREATE2 salt as
    ///        `keccak256(abi.encode(msg.sender, salt))`, so two deployers can reuse
    ///        the same value without colliding.
    /// @param rootAccount The account granted root roles on the new registry.
    /// @param roleBitmap The root roles to grant it.
    /// @return registry The deployed registry.
    function deploy(
        IVerifiableFactory factory,
        address userRegistryImpl,
        uint256 salt,
        address rootAccount,
        uint256 roleBitmap
    )
        internal
        returns (IPermissionedRegistry registry)
    {
        return
            IPermissionedRegistry(
                factory.deployProxy(
                    userRegistryImpl,
                    salt,
                    initializerData(rootAccount, roleBitmap)
                )
            );
    }

    /// @notice Pre-compute the address `deploy` will produce.
    ///
    /// Mirrors `computeVerifiableProxyAddress()` from contracts-v2's
    /// `deployVerifiableProxy.ts`, and reuses the factory's own
    /// `CloneProxyBytecode` so the creation code cannot drift from the deployed
    /// factory's. Note the implementation address is **not** an input: the clone
    /// delegates to the factory's shared `proxyLogic`, and the implementation is
    /// recorded in proxy storage by `initialize`, not baked into the code.
    ///
    /// @param factory The `VerifiableFactory` that will do the deploying.
    /// @param proxyLogic `factory.proxyLogic()`.
    /// @param deployer The account that will call `deployProxy` — the factory's
    ///        `msg.sender`, not the factory.
    /// @param salt The same caller-chosen salt passed to `deploy`.
    function predictAddress(address factory, address proxyLogic, address deployer, uint256 salt)
        internal
        pure
        returns (address)
    {
        bytes32 outerSalt = keccak256(abi.encode(deployer, salt));
        return
            Create2.computeAddress(
                outerSalt,
                keccak256(CloneProxyBytecode.creationCode(proxyLogic, outerSalt)),
                factory
            );
    }
}
