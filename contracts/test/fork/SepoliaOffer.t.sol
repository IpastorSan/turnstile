// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console2} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {IVerifiableFactory} from "@ensdomains/verifiable-factory/IVerifiableFactory.sol";

import {IEnhancedAccessControl} from
    "@ens/v2/access-control/interfaces/IEnhancedAccessControl.sol";
import {IPermissionedRegistry} from "@ens/v2/registry/interfaces/IPermissionedRegistry.sol";
import {IRegistry} from "@ens/v2/registry/interfaces/IRegistry.sol";
import {PermissionedResolver} from "@ens/v2/resolver/PermissionedResolver.sol";
import {PermissionedResolverLib} from "@ens/v2/resolver/libraries/PermissionedResolverLib.sol";

import {EnsSepolia} from "../../script/EnsSepolia.sol";
import {TurnstileName} from "../../src/TurnstileName.sol";
import {TurnstileOffer} from "../../src/TurnstileOffer.sol";

/// @title SepoliaOfferTest
/// @notice Fork tests against **our own** live Sepolia deployment.
///
/// `SepoliaEnsV2Test` is the canary for ENS redeploying underneath us. This file
/// is the canary for the demo itself: it reads `liquidity.turnstile.eth` off the
/// chain and asserts the offer is there, the standard keys resolve, and the hot
/// key still cannot move the payout address.
///
/// That last assertion is the one worth having in CI. Everything about the role
/// split is state on a contract we do not control the source of, and state can be
/// changed by any transaction — including one of ours, made carelessly, the day
/// before a demo. A green local `OfferRecordsTest` proves the design; only this
/// proves the deployment.
///
/// Every address, the seller label and the agent id come from
/// `addresses.turnstile.sepolia.json`, so nothing here is hard-coded — including
/// the name, which is walked out of the registry hierarchy exactly as the deploy
/// script does it.
contract SepoliaOfferTest is Test {
    using stdJson for string;

    /// @dev Skips the whole file rather than failing, so a network-less run does
    ///      not look like a broken deployment. Matching `SepoliaEnsV2Test`.
    bool internal forked;
    bool internal deployed;

    IPermissionedRegistry internal registry;
    PermissionedResolver internal resolver;
    address internal cold;
    address internal hot;
    address internal payout;
    string internal sellerLabel;
    uint256 internal agentId;
    address internal agentRegistry;

    string internal ensName;
    bytes internal dnsName;
    bytes32 internal node;

    function setUp() public {
        string memory ours =
            vm.readFile(string.concat(vm.projectRoot(), "/addresses.turnstile.sepolia.json"));

        // Before `PublishOffer.s.sol` runs, the file has no `resolver` key.
        deployed = ours.keyExists(".resolver") && ours.readAddress(".resolver") != address(0);
        if (!deployed) {
            console2.log("SKIPPING: no resolver in addresses.turnstile.sepolia.json");
            return;
        }

        registry = IPermissionedRegistry(ours.readAddress(".turnstileRegistry"));
        resolver = PermissionedResolver(ours.readAddress(".resolver"));
        cold = ours.readAddress(".coldKey");
        hot = ours.readAddress(".hotKey");
        payout = ours.readAddress(".payout");
        sellerLabel = ours.readString(".sellerLabel");
        agentId = ours.readUint(".erc8004AgentId");
        agentRegistry = ours.readAddress(".erc8004IdentityRegistry");

        try this.selectFork() {
            forked = true;
        } catch {
            forked = false;
            console2.log("SKIPPING fork tests: could not reach", EnsSepolia.rpcUrl());
            return;
        }

        ensName = TurnstileName.ensName(IRegistry(address(registry)), sellerLabel);
        dnsName = TurnstileName.dnsName(IRegistry(address(registry)), sellerLabel);
        node = TurnstileName.node(IRegistry(address(registry)), sellerLabel);
    }

    /// @dev External so `setUp` can try/catch it.
    function selectFork() external {
        vm.createSelectFork(EnsSepolia.rpcUrl());
    }

    modifier live() {
        if (!forked || !deployed) {
            vm.skip(true);
        }
        _;
    }

    /// @notice The resolver is attached to the seller subname, and is a stock ENS
    ///         `PermissionedResolver` — not a look-alike.
    function testFork_resolverIsAttachedAndVerifiable() public live {
        assertEq(registry.getResolver(sellerLabel), address(resolver), "resolver attached");

        address factory = EnsSepolia.get("VerifiableFactory");
        assertEq(
            IVerifiableFactory(factory).verifyContract(address(resolver)),
            EnsSepolia.get("PermissionedResolverImpl"),
            "the live resolver is ENS's stock implementation"
        );
    }

    /// @notice The offer resolves through ENSIP-25/26 keys, live.
    function testFork_offerResolvesWithStandardEnsipKeys() public live {
        assertGt(
            bytes(resolver.text(node, TurnstileOffer.KEY_AGENT_CONTEXT)).length,
            0,
            "ENSIP-26 agent-context"
        );
        assertGt(
            bytes(
                resolver.text(
                    node,
                    TurnstileOffer.agentEndpointKey(TurnstileOffer.PROTOCOL_MCP)
                )
            ).length,
            0,
            "ENSIP-26 agent-endpoint[mcp]"
        );
        assertEq(
            resolver.text(
                node,
                TurnstileOffer.agentRegistrationKey(block.chainid, agentRegistry, agentId)
            ),
            TurnstileOffer.AGENT_REGISTRATION_VALUE,
            "ENSIP-25 agent-registration"
        );
        assertGt(bytes(resolver.text(node, TurnstileOffer.KEY_PRICE)).length, 0, "price");
        assertGt(
            bytes(resolver.text(node, TurnstileOffer.KEY_PRICE_CEILING)).length,
            0,
            "ceiling"
        );
        assertEq(resolver.addr(node), payable(payout), "payout is addr(60)");
    }

    /// @notice The hot key still holds exactly its two authorizations, on the
    ///         part resources and nowhere wider.
    function testFork_hotKeyIsStillScopedToTwoRecords() public live {
        string[] memory keys = TurnstileOffer.hotKeyTextKeys();
        for (uint256 i; i < keys.length; ++i) {
            assertTrue(
                resolver.hasRoles(
                    PermissionedResolverLib.resource(
                        node,
                        PermissionedResolverLib.partHash(keys[i])
                    ),
                    PermissionedResolverLib.ROLE_SET_TEXT,
                    hot
                ),
                keys[i]
            );
        }
        assertFalse(
            resolver.hasRoles(
                PermissionedResolverLib.resource(node, bytes32(0)),
                PermissionedResolverLib.ROLE_SET_TEXT,
                hot
            ),
            "no name-level write"
        );
        assertFalse(
            resolver.hasRootRoles(PermissionedResolverLib.ROLE_SET_TEXT, hot),
            "no root write"
        );
    }

    /// @notice **The invariant, against the live deployment.** The hot key cannot
    ///         redirect payment on the contract that is actually deployed.
    function testFork_hotKeyCannotChangeThePayoutOnChain() public live {
        uint256 nameResource = PermissionedResolverLib.resource(node, bytes32(0));

        vm.prank(hot);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                nameResource,
                PermissionedResolverLib.ROLE_SET_ADDR,
                hot
            )
        );
        resolver.setAddr(node, makeAddr("attacker"));

        assertEq(resolver.addr(node), payable(payout), "payout is untouched");
    }

    /// @notice And it can still do its job — priced against the live state, so a
    ///         revoked-and-not-restored hot key shows up here rather than at the
    ///         demo.
    function testFork_hotKeyCanStillReprice() public live {
        vm.prank(hot);
        resolver.setText(node, TurnstileOffer.KEY_PRICE, "0.11");
        assertEq(resolver.text(node, TurnstileOffer.KEY_PRICE), "0.11");
    }

    /// @notice The ENSIP-25 backlink reads the same from the ERC-8004 side: the
    ///         cold key owns the agent, and its `tokenURI` is our name.
    function testFork_erc8004RegistrationPointsBack() public live {
        (bool okOwner, bytes memory owner) =
            agentRegistry.staticcall(abi.encodeWithSignature("ownerOf(uint256)", agentId));
        assertTrue(okOwner, "ownerOf");
        assertEq(abi.decode(owner, (address)), cold, "the cold key owns the agent");

        (bool okUri, bytes memory uri) =
            agentRegistry.staticcall(abi.encodeWithSignature("tokenURI(uint256)", agentId));
        assertTrue(okUri, "tokenURI");
        assertEq(abi.decode(uri, (string)), ensName, "the agent points back at the name");
    }

    /// @notice The name is walked out of the live hierarchy, not written down.
    function testFork_nameIsDerivedFromTheLiveHierarchy() public live {
        assertEq(ensName, string.concat(sellerLabel, ".turnstile.eth"));

        (IRegistry parent, string memory label) = registry.getParent();
        assertEq(address(parent), EnsSepolia.get("ETHRegistry"));
        assertEq(label, "turnstile");
    }
}
