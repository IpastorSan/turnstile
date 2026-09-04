// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IEnhancedAccessControl} from
    "@ens/v2/access-control/interfaces/IEnhancedAccessControl.sol";
import {IPermissionedRegistry} from "@ens/v2/registry/interfaces/IPermissionedRegistry.sol";
import {IRegistry} from "@ens/v2/registry/interfaces/IRegistry.sol";
import {IStandardRegistry} from "@ens/v2/registry/interfaces/IStandardRegistry.sol";
import {RegistryRolesLib} from "@ens/v2/registry/libraries/RegistryRolesLib.sol";
import {LibLabel} from "@ens/v2/utils/LibLabel.sol";

import {TurnstileRegistrar} from "../src/TurnstileRegistrar.sol";
import {TurnstileRegistry} from "../src/TurnstileRegistry.sol";

import {TurnstileFixture} from "./TurnstileFixture.sol";

contract TurnstileRegistrarTest is TurnstileFixture {
    uint64 internal constant YEAR = 365 days;

    function setUp() public override {
        super.setUp();
        vm.deal(buyer, 100 ether);
        vm.deal(stranger, 100 ether);
    }

    ////////////////////////////////////////////////////////////////////////
    // Minting
    ////////////////////////////////////////////////////////////////////////

    function test_registerMintsSubname() public {
        uint256 price = registrar.rentPrice("alice", YEAR);
        assertGt(price, 0, "price should not be free");
        assertTrue(registrar.available("alice"));

        vm.prank(buyer);
        uint256 tokenId = registrar.register{value: price}("alice", buyer, YEAR);

        uint256 labelId = LibLabel.id("alice");
        assertEq(registry.getOwner(labelId), buyer, "buyer owns the subname");
        assertEq(registry.ownerOf(tokenId), buyer, "erc1155 balance follows");
        assertEq(registry.getExpiry(labelId), uint64(block.timestamp) + YEAR);
        assertEq(
            uint8(registry.getStatus(labelId)),
            uint8(IPermissionedRegistry.Status.REGISTERED)
        );
        assertFalse(registrar.available("alice"), "no longer for sale");
        assertEq(address(registrar).balance, price, "proceeds held for withdrawal");
    }

    function test_registerGrantsBuyerExactlyTheIntendedRoles() public {
        _buy("alice", buyer, YEAR);
        uint256 resource = registry.getResource(LibLabel.id("alice"));

        assertTrue(
            registry.hasRoles(resource, RegistryRolesLib.ROLE_SET_RESOLVER, buyer),
            "buyer may set their own resolver"
        );
        assertTrue(
            registry.hasRoles(resource, RegistryRolesLib.ROLE_SET_SUBREGISTRY, buyer),
            "buyer may attach their own subregistry"
        );
        // Renewal is priced, so it goes through the registrar, not the token.
        assertFalse(
            registry.hasRoles(resource, RegistryRolesLib.ROLE_RENEW, buyer),
            "buyer must not renew for free"
        );
        assertFalse(
            registry.hasRoles(resource, RegistryRolesLib.ROLE_UNREGISTER, buyer),
            "buyer must not unregister"
        );
    }

    function test_registerRefundsOverpayment() public {
        uint256 price = registrar.rentPrice("alice", YEAR);
        uint256 before = buyer.balance;

        vm.prank(buyer);
        registrar.register{value: price + 3 ether}("alice", buyer, YEAR);

        assertEq(buyer.balance, before - price, "surplus refunded");
        assertEq(address(registrar).balance, price);
    }

    function test_registerPricesByLabelLength() public view {
        // 3 and 4 are tiered; 5 and up fall through to the base rate.
        assertEq(registrar.rentPrice("abc", YEAR), PRICE_LEN3 * YEAR);
        assertEq(registrar.rentPrice("abcd", YEAR), PRICE_LEN4 * YEAR);
        assertEq(registrar.rentPrice("abcde", YEAR), PRICE_BASE * YEAR);
        assertEq(registrar.rentPrice("abcdefghijkl", YEAR), PRICE_BASE * YEAR);
        assertGt(registrar.rentPrice("abc", YEAR), registrar.rentPrice("abcde", YEAR));
    }

    ////////////////////////////////////////////////////////////////////////
    // Duplicate minting
    ////////////////////////////////////////////////////////////////////////

    /// @dev The registrar refuses before it ever reaches the registry.
    function test_registerRejectsDuplicate() public {
        _buy("alice", buyer, YEAR);

        uint256 price = registrar.rentPrice("alice", YEAR);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(TurnstileRegistrar.LabelUnavailable.selector, "alice"));
        registrar.register{value: price}("alice", stranger, YEAR);
    }

    /// @dev And so does the registry itself, if anything ever bypasses the
    ///      registrar's own availability check. Belt and braces: the registry is
    ///      the authority on what is taken, and it must be the one to say no.
    function test_registryRejectsDuplicateAtItsOwnLayer() public {
        _buy("alice", buyer, YEAR);

        vm.prank(operator); // holds ROLE_REGISTRAR at root, so authorisation is not what fails
        vm.expectRevert(
            abi.encodeWithSelector(IStandardRegistry.LabelAlreadyRegistered.selector, "alice")
        );
        registry.register(
            "alice",
            stranger,
            IRegistry(address(0)),
            address(0),
            TurnstileRegistry.SUBNAME_OWNER_ROLES,
            uint64(block.timestamp) + YEAR
        );
    }

    /// @dev Once a name expires it is available again, and the buyer's roles do
    ///      not carry over to the next holder — the registry bumps the resource
    ///      version, so the old grants address a resource nobody can reach.
    function test_expiredNameBecomesAvailableAgain() public {
        _buy("alice", buyer, YEAR);
        assertFalse(registrar.available("alice"));

        vm.warp(block.timestamp + YEAR + 1);
        assertTrue(registrar.available("alice"), "expired name is back on sale");

        _buy("alice", stranger, YEAR);
        assertEq(registry.getOwner(LibLabel.id("alice")), stranger);

        uint256 resource = registry.getResource(LibLabel.id("alice"));
        assertFalse(
            registry.hasRoles(resource, RegistryRolesLib.ROLE_SET_RESOLVER, buyer),
            "previous owner's roles do not survive expiry"
        );
    }

    ////////////////////////////////////////////////////////////////////////
    // Authorisation
    ////////////////////////////////////////////////////////////////////////

    /// @dev A registrar that was never granted root roles cannot mint. This is the
    ///      whole reason `grantRootRoles` has to be called at deploy time.
    function test_unauthorizedRegistrarCannotMint() public {
        TurnstileRegistrar rogue = new TurnstileRegistrar(
            registry,
            operator,
            payout,
            address(0),
            _priceTiers(),
            PRICE_BASE
        );

        assertFalse(
            registry.hasRootRoles(RegistryRolesLib.ROLE_REGISTRAR, address(rogue)),
            "rogue registrar holds no root roles"
        );

        uint256 price = rogue.rentPrice("alice", YEAR);
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                uint256(0), // ROOT_RESOURCE
                RegistryRolesLib.ROLE_REGISTRAR,
                address(rogue)
            )
        );
        rogue.register{value: price}("alice", buyer, YEAR);
    }

    function test_strangerCannotMintDirectlyOnTheRegistry() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                uint256(0),
                RegistryRolesLib.ROLE_REGISTRAR,
                stranger
            )
        );
        registry.register(
            "alice",
            stranger,
            IRegistry(address(0)),
            address(0),
            TurnstileRegistry.SUBNAME_OWNER_ROLES,
            uint64(block.timestamp) + YEAR
        );
    }

    /// @dev The registrar takes the money, so it must not be able to destroy what
    ///      it sold. It holds ROLE_REGISTRAR | ROLE_RENEW and nothing more.
    function test_registrarCannotUnregisterOrReparent() public {
        _buy("alice", buyer, YEAR);

        assertFalse(
            registry.hasRootRoles(RegistryRolesLib.ROLE_UNREGISTER, address(registrar))
        );
        assertFalse(
            registry.hasRootRoles(RegistryRolesLib.ROLE_SET_PARENT, address(registrar))
        );
        assertFalse(registry.hasRootRoles(RegistryRolesLib.ROLE_UPGRADE, address(registrar)));

        vm.prank(address(registrar));
        vm.expectRevert();
        registry.unregister(LibLabel.id("alice"));
    }

    function test_onlyOwnerMayChangePricesAndPayout() public {
        vm.prank(stranger);
        vm.expectRevert();
        registrar.setPaymentReceiver(stranger);

        vm.prank(stranger);
        vm.expectRevert();
        registrar.setPrices(_priceTiers(), 1);

        vm.prank(operator);
        registrar.setPaymentReceiver(stranger);
        assertEq(registrar.paymentReceiver(), stranger);
    }

    ////////////////////////////////////////////////////////////////////////
    // Payment
    ////////////////////////////////////////////////////////////////////////

    function test_registerRejectsUnderpayment() public {
        uint256 price = registrar.rentPrice("alice", YEAR);
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(
                TurnstileRegistrar.InsufficientPayment.selector,
                price,
                price - 1
            )
        );
        registrar.register{value: price - 1}("alice", buyer, YEAR);
    }

    function test_withdrawSweepsToPaymentReceiver() public {
        _buy("alice", buyer, YEAR);
        uint256 proceeds = address(registrar).balance;
        assertGt(proceeds, 0);

        uint256 before = payout.balance;
        registrar.withdraw(); // permissionless: it can only reach the configured payout
        assertEq(payout.balance, before + proceeds);
        assertEq(address(registrar).balance, 0);

        vm.expectRevert(TurnstileRegistrar.NothingToWithdraw.selector);
        registrar.withdraw();
    }

    ////////////////////////////////////////////////////////////////////////
    // Renewal
    ////////////////////////////////////////////////////////////////////////

    function test_renewExtendsExpiry() public {
        _buy("alice", buyer, YEAR);
        uint256 labelId = LibLabel.id("alice");
        uint64 expiry = registry.getExpiry(labelId);

        uint256 price = registrar.rentPrice("alice", YEAR);
        vm.prank(buyer);
        registrar.renew{value: price}("alice", YEAR);

        assertEq(registry.getExpiry(labelId), expiry + YEAR);
    }

    function test_renewRejectsUnregisteredLabel() public {
        uint256 price = registrar.rentPrice("alice", YEAR);
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(TurnstileRegistrar.LabelNotRegistered.selector, "alice")
        );
        registrar.renew{value: price}("alice", YEAR);
    }

    ////////////////////////////////////////////////////////////////////////
    // Label policy
    ////////////////////////////////////////////////////////////////////////

    function test_labelValidation() public view {
        assertTrue(registrar.validLabel("alice"));
        assertTrue(registrar.validLabel("a-b-c"));
        assertTrue(registrar.validLabel("agent007"));

        assertFalse(registrar.validLabel("ab"), "too short");
        assertFalse(registrar.validLabel("-alice"), "leading hyphen");
        assertFalse(registrar.validLabel("alice-"), "trailing hyphen");
        assertFalse(registrar.validLabel("Alice"), "uppercase");
        assertFalse(registrar.validLabel(unicode"alicé"), "non-ascii");
        // The one that actually matters: a dot would mint a name with no
        // well-defined position in the hierarchy.
        assertFalse(registrar.validLabel("a.b"), "dot");
    }

    function test_registerRejectsInvalidLabel() public {
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(TurnstileRegistrar.InvalidLabel.selector, "a.b"));
        registrar.register{value: 1 ether}("a.b", buyer, YEAR);
    }

    function test_reservedLabelsAreWithheld() public {
        string[] memory labels = new string[](1);
        labels[0] = "admin";

        vm.prank(operator);
        registrar.setReserved(labels, true);
        assertFalse(registrar.available("admin"));

        uint256 price = registrar.rentPrice("admin", YEAR);
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(TurnstileRegistrar.LabelUnavailable.selector, "admin")
        );
        registrar.register{value: price}("admin", buyer, YEAR);

        vm.prank(operator);
        registrar.setReserved(labels, false);
        assertTrue(registrar.available("admin"));
    }

    function test_registerRejectsOutOfRangeDuration() public {
        uint64 tooShort = registrar.MIN_DURATION() - 1;
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(TurnstileRegistrar.DurationOutOfRange.selector, tooShort)
        );
        registrar.register{value: 1 ether}("alice", buyer, tooShort);
    }

    ////////////////////////////////////////////////////////////////////////
    // Hierarchy
    ////////////////////////////////////////////////////////////////////////

    /// @dev The two-sided link. `setSubregistry` on the parent is what actually
    ///      makes resolution descend into our registry; `setParent` on ours is the
    ///      back-pointer that lets anything holding the registry work out its own
    ///      canonical name.
    function test_linkIntoHierarchy() public {
        assertEq(
            address(ethRegistry.getSubregistry(PARENT_LABEL)),
            address(0),
            "not linked yet"
        );

        _linkIntoHierarchy();

        assertEq(
            address(ethRegistry.getSubregistry(PARENT_LABEL)),
            address(registry),
            "parent descends into the Turnstile registry"
        );
        (IRegistry parent, string memory label) = registry.getParent();
        assertEq(address(parent), address(ethRegistry));
        assertEq(label, PARENT_LABEL);

        // And a subname bought through the registrar is reachable from the top.
        _buy("alice", buyer, YEAR);
        IRegistry child = ethRegistry.getSubregistry(PARENT_LABEL);
        assertEq(
            IPermissionedRegistry(address(child)).getOwner(LibLabel.id("alice")),
            buyer
        );
    }

    function test_strangerCannotReparentTheRegistry() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                uint256(0),
                RegistryRolesLib.ROLE_SET_PARENT,
                stranger
            )
        );
        registry.setParent(IRegistry(address(ethRegistry)), PARENT_LABEL);
    }

    ////////////////////////////////////////////////////////////////////////
    // Deployment
    ////////////////////////////////////////////////////////////////////////

    /// @dev The CREATE2 pre-computation ported from contracts-v2's
    ///      deployVerifiableProxy.ts must land on the address the factory actually
    ///      produces, or the deploy script cannot wire the registrar before the
    ///      registry exists.
    function test_predictAddressMatchesDeployedProxy() public {
        uint256 salt = uint256(keccak256("predict"));
        address predicted = TurnstileRegistry.predictAddress(
            address(factory),
            factory.proxyLogic(),
            operator,
            salt
        );

        vm.prank(operator);
        address deployed = address(
            TurnstileRegistry.deploy(
                factory,
                address(userRegistryImpl),
                salt,
                operator,
                TurnstileRegistry.OPERATOR_ROOT_ROLES
            )
        );

        assertEq(deployed, predicted, "predicted proxy address");
        assertEq(
            factory.verifyContract(deployed),
            address(userRegistryImpl),
            "factory verifies it as a stock UserRegistry"
        );
    }

    ////////////////////////////////////////////////////////////////////////
    // Helpers
    ////////////////////////////////////////////////////////////////////////

    function _buy(string memory label, address owner, uint64 duration)
        internal
        returns (uint256)
    {
        uint256 price = registrar.rentPrice(label, duration);
        vm.deal(owner, owner.balance + price);
        vm.prank(owner);
        return registrar.register{value: price}(label, owner, duration);
    }
}
