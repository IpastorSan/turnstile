// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IEnhancedAccessControl} from
    "@ens/v2/access-control/interfaces/IEnhancedAccessControl.sol";
import {RegistryRolesLib} from "@ens/v2/registry/libraries/RegistryRolesLib.sol";
import {LibLabel} from "@ens/v2/utils/LibLabel.sol";

import {TurnstileRegistrar} from "../src/TurnstileRegistrar.sol";
import {TurnstileRegistry} from "../src/TurnstileRegistry.sol";

import {TurnstileFixture} from "./TurnstileFixture.sol";

/// @title RolesTest
/// @notice Pins the `grantRoles` / `grantRootRoles` distinction so a refactor
///         cannot silently regress it.
///
/// There are two traps here and both are silent — the wrong call compiles, and
/// on a `PermissionedRegistry` the wrong call has the *same three-argument shape*
/// as the right one.
///
/// 1. `EnhancedAccessControl.grantRoles(resource, bitmap, account)` reverts with
///    `EACRootResourceNotAllowed()` when handed `ROOT_RESOURCE`. Root grants have
///    to go through `grantRootRoles(bitmap, account)`.
///
/// 2. `PermissionedRegistry` *overrides* `grantRoles` (PermissionedRegistry.sol:233)
///    so its first argument is a **token id**, not a resource — it forwards
///    `getResource(anyId)` to the base. `PermissionedResolver` has an override at
///    the same arity (PermissionedResolver.sol:720) where the first argument *is*
///    a resource. Identical signatures, opposite meanings.
///
/// The failure mode this guards against: someone "fixes" the registrar wiring by
/// swapping `grantRootRoles(REGISTRAR_ROOT_ROLES, registrar)` for
/// `grantRoles(0, REGISTRAR_ROOT_ROLES, registrar)` because it reads more
/// explicitly. The tests below are what makes that not compile-and-ship.
contract RolesTest is TurnstileFixture {
    uint64 internal constant YEAR = 365 days;

    /// @dev `ROOT_RESOURCE` is 0. Named here so the tests below read as what they
    ///      are rather than as a magic zero.
    uint256 internal constant ROOT_RESOURCE = 0;

    ////////////////////////////////////////////////////////////////////////
    // Trap 1 — grantRoles cannot reach the root resource
    ////////////////////////////////////////////////////////////////////////

    /// @dev Passing ROOT_RESOURCE to `grantRoles` reverts. This is the guard rail
    ///      that makes the mistake loud rather than silent, and it only fires
    ///      because `getResource(0)` short-circuits back to 0 — see
    ///      `PermissionedRegistry._constructResource`, which returns `anyId`
    ///      unchanged when it is ROOT_RESOURCE.
    function test_grantRolesRejectsRootResource() public {
        address newRegistrar = makeAddr("newRegistrar");

        vm.prank(operator);
        vm.expectRevert(IEnhancedAccessControl.EACRootResourceNotAllowed.selector);
        registry.grantRoles(ROOT_RESOURCE, TurnstileRegistry.REGISTRAR_ROOT_ROLES, newRegistrar);

        assertFalse(
            registry.hasRootRoles(RegistryRolesLib.ROLE_REGISTRAR, newRegistrar),
            "nothing was granted"
        );
    }

    /// @dev And the call that does work.
    function test_grantRootRolesIsTheOnlyWayToGrantAtRoot() public {
        address newRegistrar = makeAddr("newRegistrar");

        vm.prank(operator);
        registry.grantRootRoles(TurnstileRegistry.REGISTRAR_ROOT_ROLES, newRegistrar);

        assertTrue(registry.hasRootRoles(RegistryRolesLib.ROLE_REGISTRAR, newRegistrar));
        assertTrue(registry.hasRootRoles(RegistryRolesLib.ROLE_RENEW, newRegistrar));
    }

    /// @dev The end-to-end consequence, which is the thing that actually breaks a
    ///      deployment: a registrar wired with the wrong call cannot mint.
    function test_registrarWiredWithoutGrantRootRolesCannotMint() public {
        TurnstileRegistrar rogue = new TurnstileRegistrar(
            registry,
            operator,
            payout,
            address(0),
            _priceTiers(),
            PRICE_BASE
        );

        // The wrong wiring, in full. It reverts, so a deploy script would fail
        // loudly here — but if it were ever caught and swallowed, the registrar
        // would look deployed and be unable to sell a single name.
        vm.prank(operator);
        vm.expectRevert(IEnhancedAccessControl.EACRootResourceNotAllowed.selector);
        registry.grantRoles(ROOT_RESOURCE, TurnstileRegistry.REGISTRAR_ROOT_ROLES, address(rogue));

        uint256 price = rogue.rentPrice("alice", YEAR);
        vm.deal(buyer, price);
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                ROOT_RESOURCE,
                RegistryRolesLib.ROLE_REGISTRAR,
                address(rogue)
            )
        );
        rogue.register{value: price}("alice", buyer, YEAR);
    }

    ////////////////////////////////////////////////////////////////////////
    // Trap 2 — on a registry, grantRoles's first argument is a token id
    ////////////////////////////////////////////////////////////////////////

    /// @dev The same three-argument call, given a token id, grants on that
    ///      *token's* resource and touches root not at all. If a future refactor
    ///      ever made `PermissionedRegistry.grantRoles` interpret its first
    ///      argument as a raw resource — matching `PermissionedResolver`'s
    ///      override — this assertion is what would catch it.
    function test_grantRolesFirstArgIsATokenIdNotAResource() public {
        uint256 price = registrar.rentPrice("alice", YEAR);
        vm.deal(buyer, price);
        vm.prank(buyer);
        uint256 tokenId = registrar.register{value: price}("alice", buyer, YEAR);

        uint256 labelId = LibLabel.id("alice");
        uint256 resource = registry.getResource(labelId);
        address delegate = makeAddr("delegate");

        // This is *why* the mix-up is silent. On a freshly registered name both
        // version counters are 0, so the token id and the resource are the same
        // number and either one "works". They only diverge later.
        assertEq(tokenId, resource, "token id and resource coincide at version 0");

        // Grant against the TOKEN ID.
        vm.prank(buyer);
        registry.grantRoles(tokenId, RegistryRolesLib.ROLE_SET_RESOLVER, delegate);

        // It landed on the token's resource...
        assertTrue(
            registry.hasRoles(resource, RegistryRolesLib.ROLE_SET_RESOLVER, delegate),
            "granted on the token's resource"
        );
        // ...and nowhere near root.
        assertFalse(
            registry.hasRootRoles(RegistryRolesLib.ROLE_SET_RESOLVER, delegate),
            "a token grant must never confer a root role"
        );

        // The grant regenerated the token (PermissionedRegistry._onRolesGranted
        // burns and re-mints so ERC1155 holders cannot be front-run by a role
        // change), which bumps tokenVersionId and leaves eacVersionId alone. The
        // two numbers have now come apart, and from here on passing one where the
        // other is meant addresses a different thing.
        uint256 newTokenId = registry.getTokenId(labelId);
        assertTrue(newTokenId != tokenId, "token regenerated");
        assertTrue(newTokenId != resource, "token id and resource have diverged");
        assertEq(registry.getResource(labelId), resource, "resource is unchanged");

        // And the override really is `getResource(anyId)`: the new token id maps
        // back to the same resource, so a second grant lands in the same place.
        assertEq(registry.getResource(newTokenId), resource);
    }

    /// @dev A root role holder's authority does not leak the other way either:
    ///      holding ROLE_REGISTRAR at root does not make you the owner of a token.
    function test_rootRolesApplyEverywhereButTokenRolesDoNot() public {
        uint256 price = registrar.rentPrice("alice", YEAR);
        vm.deal(buyer, price);
        vm.prank(buyer);
        registrar.register{value: price}("alice", buyer, YEAR);

        uint256 resource = registry.getResource(LibLabel.id("alice"));

        // ROOT_RESOURCE roles are OR-ed into every resource check, so the operator
        // reads as holding its root roles on this token too.
        assertTrue(
            registry.hasRoles(resource, RegistryRolesLib.ROLE_RENEW, operator),
            "root roles apply within every resource"
        );
        // The buyer's token roles stay put.
        assertFalse(
            registry.hasRootRoles(RegistryRolesLib.ROLE_SET_RESOLVER, buyer),
            "token roles do not climb to root"
        );
    }

    /// @dev Token admin roles are fixed at registration. `_getSettableRoles`
    ///      returns `bitmap >> 128` for a non-root resource, so the upper half is
    ///      unreachable afterwards — which is exactly why SUBNAME_OWNER_ROLES has
    ///      to carry the _ADMIN halves at mint time or the buyer can never
    ///      delegate.
    function test_tokenAdminRolesCannotBeGrantedAfterRegistration() public {
        uint256 price = registrar.rentPrice("alice", YEAR);
        vm.deal(buyer, price);
        vm.prank(buyer);
        uint256 tokenId = registrar.register{value: price}("alice", buyer, YEAR);

        address delegate = makeAddr("delegate");
        // Resolved before the prank on purpose: getResource is an external call,
        // and vm.prank applies to the next one.
        uint256 resource = registry.getResource(tokenId);

        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACCannotGrantRoles.selector,
                resource,
                RegistryRolesLib.ROLE_SET_RESOLVER_ADMIN,
                buyer
            )
        );
        registry.grantRoles(tokenId, RegistryRolesLib.ROLE_SET_RESOLVER_ADMIN, delegate);
    }

    ////////////////////////////////////////////////////////////////////////
    // The bitmaps themselves
    ////////////////////////////////////////////////////////////////////////

    /// @dev `hasRootRoles` compares raw bitmaps — it does not apply the
    ///      "admin implies regular" rule that `_getSettableRoles` does. So an
    ///      operator granted only the _ADMIN half could delegate a capability but
    ///      not use it. OPERATOR_ROOT_ROLES carries both halves for exactly that
    ///      reason, and this is the assertion that says so.
    function test_operatorHoldsBothHalvesOfEachCapability() public view {
        uint256[7] memory regular = [
            RegistryRolesLib.ROLE_REGISTRAR,
            RegistryRolesLib.ROLE_RENEW,
            RegistryRolesLib.ROLE_UNREGISTER,
            RegistryRolesLib.ROLE_SET_PARENT,
            RegistryRolesLib.ROLE_SET_URI,
            RegistryRolesLib.ROLE_CAN_NAME,
            RegistryRolesLib.ROLE_UPGRADE
        ];
        for (uint256 i; i < regular.length; ++i) {
            assertTrue(registry.hasRootRoles(regular[i], operator), "regular half");
            assertTrue(registry.hasRootRoles(regular[i] << 128, operator), "admin half");
        }
    }

    /// @dev The registrar's envelope, stated as an assertion rather than a comment.
    function test_registrarHoldsMintAndRenewAndNothingElse() public view {
        assertTrue(registry.hasRootRoles(RegistryRolesLib.ROLE_REGISTRAR, address(registrar)));
        assertTrue(registry.hasRootRoles(RegistryRolesLib.ROLE_RENEW, address(registrar)));

        assertFalse(registry.hasRootRoles(RegistryRolesLib.ROLE_UNREGISTER, address(registrar)));
        assertFalse(registry.hasRootRoles(RegistryRolesLib.ROLE_SET_PARENT, address(registrar)));
        assertFalse(registry.hasRootRoles(RegistryRolesLib.ROLE_UPGRADE, address(registrar)));
        assertFalse(registry.hasRootRoles(RegistryRolesLib.ROLE_SET_URI, address(registrar)));
        // No admin half at all: it can use what it has and delegate none of it.
        assertFalse(
            registry.hasRootRoles(RegistryRolesLib.ROLE_REGISTRAR_ADMIN, address(registrar)),
            "the registrar must not be able to appoint another registrar"
        );
    }

    /// @dev A registrar cannot grant itself more, because granting needs the
    ///      _ADMIN half and it holds none.
    function test_registrarCannotWidenItsOwnAuthority() public {
        vm.prank(address(registrar));
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACCannotGrantRoles.selector,
                ROOT_RESOURCE,
                RegistryRolesLib.ROLE_UNREGISTER,
                address(registrar)
            )
        );
        registry.grantRootRoles(RegistryRolesLib.ROLE_UNREGISTER, address(registrar));
    }
}
