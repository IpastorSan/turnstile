// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {PermissionedResolver} from "@ens/v2/resolver/PermissionedResolver.sol";
import {IPermissionedRegistry} from "@ens/v2/registry/interfaces/IPermissionedRegistry.sol";
import {IRegistry} from "@ens/v2/registry/interfaces/IRegistry.sol";
import {RegistryRolesLib} from "@ens/v2/registry/libraries/RegistryRolesLib.sol";

import {TurnstileName} from "../src/TurnstileName.sol";
import {TurnstileOffer} from "../src/TurnstileOffer.sol";
import {TurnstileRegistry} from "../src/TurnstileRegistry.sol";

import {TurnstileFixture} from "./TurnstileFixture.sol";

/// @notice `TurnstileFixture` plus the pieces MOV-218 adds: a full registry
///         hierarchy up to a root, a real `PermissionedResolver` behind a real
///         `VerifiableFactory`, and a seller subname with the offer published and
///         the hot key authorized.
///
/// The hierarchy is built all the way to a root registry on purpose. The base
/// fixture stops at a stand-in `.eth` registry, whose `getParent()` is the zero
/// address — which would make `TurnstileName` derive `<label>.turnstile` and
/// every namehash in these tests wrong in a way that still looks plausible.
/// Sepolia's real `ETHRegistry.getParent()` returns `(RootRegistry, "eth")`, so
/// the fixture models that.
abstract contract OfferFixture is TurnstileFixture {
    /// @dev The seller's day-to-day signer. Authorized on exactly two text keys.
    address internal hotKey = makeAddr("hotKey");
    /// @dev Where a rotated-in replacement hot key lives.
    address internal newHotKey = makeAddr("newHotKey");
    /// @dev The address a compromised hot key would try to redirect payment to.
    address internal attacker = makeAddr("attacker");

    /// @dev Stands in for ENS's `RootRegistry`, so `ethRegistry` has a parent and
    ///      the name walk terminates at `.eth` rather than one hop early.
    IPermissionedRegistry internal rootRegistry;

    PermissionedResolver internal resolverImpl;
    PermissionedResolver internal resolver;

    /// @dev The seller's subname label. Read from an env var so that even the
    ///      tests never hard-code the demo name.
    string internal sellerLabel;

    uint256 internal sellerTokenId;
    bytes internal sellerDnsName;
    bytes32 internal sellerNode;

    uint64 internal constant TERM = 365 days;

    /// @dev Sepolia. Only used to exercise a multi-byte ERC-7930 chain reference.
    uint256 internal constant SEPOLIA_CHAIN_ID = 11155111;
    /// @dev The ERC-8004 `IdentityRegistry` proxy on Sepolia, verified to hold
    ///      code and to answer `name() == "AgentIdentity"`.
    address internal constant ERC8004_IDENTITY_REGISTRY_SEPOLIA =
        0x8004A818BFB912233c491871b3d84c89A494BD9e;

    function setUp() public virtual override {
        super.setUp();

        sellerLabel = vm.envOr("TURNSTILE_SELLER_LABEL", string("liquidity"));

        rootRegistry = _deployRegistry(
            operator,
            TurnstileRegistry.OPERATOR_ROOT_ROLES,
            SALT - 2
        );

        vm.startPrank(operator);
        // Root -> .eth -> turnstile, both directions, so `getParent()` walks.
        rootRegistry.register(
            "eth",
            operator,
            IRegistry(address(ethRegistry)),
            address(0),
            RegistryRolesLib.ROLE_SET_SUBREGISTRY | RegistryRolesLib.ROLE_SET_SUBREGISTRY_ADMIN,
            uint64(block.timestamp) + TERM
        );
        ethRegistry.setParent(IRegistry(address(rootRegistry)), "eth");
        vm.stopPrank();

        _linkIntoHierarchy();

        resolverImpl = new PermissionedResolver(makeAddr("namer"));
        vm.prank(operator);
        resolver = TurnstileOffer.deployResolver(
            factory,
            address(resolverImpl),
            // A distinct salt: the factory derives CREATE2 from
            // `keccak256(abi.encode(msg.sender, salt))`, so `operator` reusing
            // SALT would collide with the registry proxy and revert.
            SALT + 1,
            operator,
            TurnstileOffer.OPERATOR_RESOLVER_ROLES
        );

        // Every subname the registrar sells gets this resolver attached at mint.
        vm.prank(operator);
        registrar.setDefaultResolver(address(resolver));

        // The seller buys their own offer name, so the cold key owns it.
        uint256 price = registrar.rentPrice(sellerLabel, TERM);
        vm.deal(operator, price);
        vm.prank(operator);
        sellerTokenId = registrar.register{value: price}(sellerLabel, operator, TERM);

        sellerDnsName = TurnstileName.dnsName(IRegistry(address(registry)), sellerLabel);
        sellerNode = TurnstileName.node(IRegistry(address(registry)), sellerLabel);

        vm.startPrank(operator);
        TurnstileOffer.publish(resolver, sellerNode, _offer());
        TurnstileOffer.authorizeHotKey(resolver, sellerDnsName, hotKey, true);
        vm.stopPrank();
    }

    /// @dev The demo offer. Placeholder values, but every field is a real key.
    function _offer() internal view returns (TurnstileOffer.Offer memory) {
        return
            TurnstileOffer.Offer({
                context: "Uniswap v4 pool liquidity analytics. Answers, not the method.",
                mcpEndpoint: "https://mcp.turnstile.example/v1/sse",
                price: "0.05",
                priceCeiling: "0.50",
                rails: "x402,usdc-arc",
                operatorProof: "operator-key-role-scoped",
                payout: payout,
                agentRegistryChainId: SEPOLIA_CHAIN_ID,
                agentRegistry: ERC8004_IDENTITY_REGISTRY_SEPOLIA,
                agentId: 1
            });
    }

    /// @dev The ENSIP-25 key for `_offer()`.
    function _registrationKey() internal view returns (string memory) {
        TurnstileOffer.Offer memory offer = _offer();
        return
            TurnstileOffer.agentRegistrationKey(
                offer.agentRegistryChainId,
                offer.agentRegistry,
                offer.agentId
            );
    }
}
