// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

import {VerifiableFactory} from "@ensdomains/verifiable-factory/VerifiableFactory.sol";

import {IPermissionedRegistry} from "@ens/v2/registry/interfaces/IPermissionedRegistry.sol";
import {IRegistry} from "@ens/v2/registry/interfaces/IRegistry.sol";
import {RegistryRolesLib} from "@ens/v2/registry/libraries/RegistryRolesLib.sol";
import {UserRegistry} from "@ens/v2/registry/UserRegistry.sol";
import {ILabelStore} from "@ens/v2/utils/interfaces/ILabelStore.sol";

import {TurnstileRegistrar} from "../src/TurnstileRegistrar.sol";
import {TurnstileRegistry} from "../src/TurnstileRegistry.sol";

import {MockLabelStore} from "./mocks/MockLabelStore.sol";

/// @notice Stands up the whole Turnstile stack locally: a stand-in `.eth`
///         registry, the Turnstile registry as a real `UserRegistry` proxy behind
///         a real `VerifiableFactory`, and the registrar wired to it.
///
/// Everything except `LabelStore` is the genuine ENS contract, compiled from the
/// same revision as the Sepolia deployment, so these tests exercise the real
/// `PermissionedRegistry` semantics rather than a mock's idea of them.
abstract contract TurnstileFixture is Test {
    /// @dev The label the Turnstile registry hangs off, i.e. `turnstile.eth`.
    string internal constant PARENT_LABEL = "turnstile";

    uint256 internal constant SALT = uint256(keccak256("turnstile.v1"));

    /// @dev Seller's operator identity — the cold tier. Owns the parent name and
    ///      holds root roles on the Turnstile registry.
    address internal operator = makeAddr("operator");
    /// @dev Seller's payout address.
    address internal payout = makeAddr("payout");
    /// @dev A buyer.
    address internal buyer = makeAddr("buyer");
    /// @dev Somebody with no roles anywhere.
    address internal stranger = makeAddr("stranger");

    ILabelStore internal labelStore;
    VerifiableFactory internal factory;
    UserRegistry internal userRegistryImpl;

    /// @dev Stands in for ENS's `ETHRegistry` — same contract type, and on Sepolia
    ///      `ETHRegistry` is likewise just a `PermissionedRegistry`.
    IPermissionedRegistry internal ethRegistry;
    /// @dev The `turnstile` token id inside `ethRegistry`.
    uint256 internal parentTokenId;

    IPermissionedRegistry internal registry;
    TurnstileRegistrar internal registrar;

    // 0.01 / 0.005 / 0.001 ETH per year, by label length.
    uint256 internal constant PRICE_LEN3 = 0.01 ether / uint256(365 days);
    uint256 internal constant PRICE_LEN4 = 0.005 ether / uint256(365 days);
    uint256 internal constant PRICE_BASE = 0.001 ether / uint256(365 days);

    function setUp() public virtual {
        labelStore = new MockLabelStore();
        factory = new VerifiableFactory();
        userRegistryImpl = new UserRegistry(labelStore, address(this));

        ethRegistry = _deployRegistry(operator, TurnstileRegistry.OPERATOR_ROOT_ROLES, SALT - 1);
        registry = _deployRegistry(operator, TurnstileRegistry.OPERATOR_ROOT_ROLES, SALT);
        registrar = new TurnstileRegistrar(
            registry,
            operator,
            payout,
            address(0),
            _priceTiers(),
            PRICE_BASE
        );

        vm.startPrank(operator);

        // The registrar mints and renews. Root grants MUST go through
        // grantRootRoles — see RolesTest for why passing ROOT_RESOURCE to
        // grantRoles does not do this.
        registry.grantRootRoles(TurnstileRegistry.REGISTRAR_ROOT_ROLES, address(registrar));

        // Own `turnstile.eth`, then link the Turnstile registry underneath it.
        parentTokenId = ethRegistry.register(
            PARENT_LABEL,
            operator,
            IRegistry(address(0)),
            address(0),
            RegistryRolesLib.ROLE_SET_SUBREGISTRY |
                RegistryRolesLib.ROLE_SET_SUBREGISTRY_ADMIN |
                RegistryRolesLib.ROLE_SET_RESOLVER |
                RegistryRolesLib.ROLE_SET_RESOLVER_ADMIN,
            uint64(block.timestamp) + 365 days
        );

        vm.stopPrank();
    }

    /// @dev Deploy a `UserRegistry` proxy through the factory, as `operator`.
    function _deployRegistry(address rootAccount, uint256 roleBitmap, uint256 salt)
        internal
        returns (IPermissionedRegistry)
    {
        vm.prank(operator);
        return
            TurnstileRegistry.deploy(
                factory,
                address(userRegistryImpl),
                salt,
                rootAccount,
                roleBitmap
            );
    }

    function _priceTiers() internal pure returns (uint256[5] memory tiers) {
        tiers[3] = PRICE_LEN3;
        tiers[4] = PRICE_LEN4;
    }

    /// @dev Link both directions: the parent points down at us, we point up at the
    ///      parent. `setSubregistry` is authorised by `ROLE_SET_SUBREGISTRY` on the
    ///      parent's token; `setParent` by `ROLE_SET_PARENT` at root on ours.
    function _linkIntoHierarchy() internal {
        vm.startPrank(operator);
        ethRegistry.setSubregistry(parentTokenId, IRegistry(address(registry)));
        registry.setParent(IRegistry(address(ethRegistry)), PARENT_LABEL);
        vm.stopPrank();
    }
}
