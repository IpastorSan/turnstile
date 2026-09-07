// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";

import {IEnhancedAccessControl} from
    "@ens/v2/access-control/interfaces/IEnhancedAccessControl.sol";
import {IRegistry} from "@ens/v2/registry/interfaces/IRegistry.sol";
import {PermissionedResolverLib} from "@ens/v2/resolver/libraries/PermissionedResolverLib.sol";

import {TurnstileName} from "../src/TurnstileName.sol";
import {TurnstileOffer} from "../src/TurnstileOffer.sol";

import {OfferFixture} from "./OfferFixture.sol";

/// @dev Both libraries are `internal`, so their calls inline into the test and
///      `vm.expectRevert` — which needs the revert to happen at a lower call
///      depth than the cheatcode — never fires. This wrapper puts a real external
///      call boundary in front of the two that are supposed to revert.
contract LibraryHarness {
    function ensName(IRegistry registry, string memory label)
        external
        view
        returns (string memory)
    {
        return TurnstileName.ensName(registry, label);
    }

    function chainReference(uint256 chainId) external pure returns (bytes memory) {
        return TurnstileOffer.chainReference(chainId);
    }
}

/// @title OfferRecordsTest
/// @notice The offer, and the cold/hot split that guards it.
///
/// The load-bearing assertion in this file is
/// `test_hotKeyCannotChangeThePayoutAddress`. Everything else establishes that
/// the hot key is genuinely useful — it reprices and moves its endpoint without a
/// Ledger — so that the one thing it cannot do reads as a boundary rather than as
/// a key that was never wired up.
contract OfferRecordsTest is OfferFixture {
    LibraryHarness internal harness = new LibraryHarness();

    ////////////////////////////////////////////////////////////////////////
    // The records
    ////////////////////////////////////////////////////////////////////////

    /// @dev The offer is readable through ENSIP-25/26 keys, not a Turnstile
    ///      schema. An agent that has never heard of us can find the service from
    ///      `agent-context` and connect through `agent-endpoint[mcp]`.
    function test_offerIsReadableWithStandardEnsipKeys() public view {
        TurnstileOffer.Offer memory offer = _offer();

        assertEq(
            resolver.text(sellerNode, TurnstileOffer.KEY_AGENT_CONTEXT),
            offer.context,
            "ENSIP-26 agent-context"
        );
        assertEq(
            resolver.text(
                sellerNode,
                TurnstileOffer.agentEndpointKey(TurnstileOffer.PROTOCOL_MCP)
            ),
            offer.mcpEndpoint,
            "ENSIP-26 agent-endpoint[mcp]"
        );
        assertEq(
            resolver.text(sellerNode, _registrationKey()),
            TurnstileOffer.AGENT_REGISTRATION_VALUE,
            "ENSIP-25 agent-registration"
        );
    }

    /// @dev And the Turnstile keys on top of them, including the payout address —
    ///      which is the name's ENSIP-1 `addr()`, not a bespoke text key.
    function test_turnstileKeysAndPayoutAreReadable() public view {
        TurnstileOffer.Offer memory offer = _offer();

        assertEq(resolver.text(sellerNode, TurnstileOffer.KEY_PRICE), offer.price);
        assertEq(
            resolver.text(sellerNode, TurnstileOffer.KEY_PRICE_CEILING),
            offer.priceCeiling
        );
        assertEq(resolver.text(sellerNode, TurnstileOffer.KEY_RAILS), offer.rails);
        assertEq(
            resolver.text(sellerNode, TurnstileOffer.KEY_OPERATOR_PROOF),
            offer.operatorProof
        );
        assertEq(resolver.addr(sellerNode), payable(offer.payout), "payout is addr(60)");
    }

    /// @dev The registrar attaches the resolver at mint, so this is the state of
    ///      *every* seller subname, not something done by hand for the demo one.
    function test_registrarAttachesTheResolverToEverySubname() public {
        assertEq(registry.getResolver(sellerLabel), address(resolver));

        uint256 price = registrar.rentPrice("another", TERM);
        vm.deal(buyer, price);
        vm.prank(buyer);
        registrar.register{value: price}("another", buyer, TERM);
        assertEq(registry.getResolver("another"), address(resolver));
    }

    ////////////////////////////////////////////////////////////////////////
    // ENSIP-25 key encoding
    ////////////////////////////////////////////////////////////////////////

    /// @dev The ENSIP-25 specification's own worked example, reproduced byte for
    ///      byte. If our ERC-7930 encoder ever drifts from the standard — a wrong
    ///      version word, a padded chain reference, uppercase hex — this is what
    ///      catches it, and nothing else would: a malformed key still stores and
    ///      still reads back, it is just invisible to every ENSIP-25 client.
    function test_agentRegistrationKeyMatchesTheEnsip25Example() public pure {
        assertEq(
            TurnstileOffer.agentRegistrationKey(
                1, // mainnet
                0x8004A169FB4a3325136EB29fA0ceB6D2e539a432, // ERC-8004 IdentityRegistry
                42
            ),
            "agent-registration[0x000100000101148004a169fb4a3325136eb29fa0ceb6d2e539a432][42]"
        );
    }

    /// @dev A chain id wider than one byte. Sepolia is `0xaa36a7`, so the chain
    ///      reference is three bytes and the length prefix is `0x03` — the case a
    ///      fixed-width encoder would get wrong while still passing the mainnet
    ///      example above.
    function test_erc7930UsesAMinimalChainReference() public pure {
        assertEq(TurnstileOffer.chainReference(1), hex"01");
        assertEq(TurnstileOffer.chainReference(SEPOLIA_CHAIN_ID), hex"aa36a7");
        assertEq(
            TurnstileOffer.erc7930(SEPOLIA_CHAIN_ID, ERC8004_IDENTITY_REGISTRY_SEPOLIA),
            hex"0001000003aa36a7148004a818bfb912233c491871b3d84c89a494bd9e"
        );
    }

    /// @dev Chain id 0 is not an `eip155` chain, and silently encoding it as an
    ///      empty reference would produce a key that looks valid.
    function test_erc7930RejectsChainIdZero() public {
        vm.expectRevert(TurnstileOffer.InvalidChainId.selector);
        harness.chainReference(0);
    }

    ////////////////////////////////////////////////////////////////////////
    // No hard-coded names
    ////////////////////////////////////////////////////////////////////////

    /// @dev The full name is walked out of the registry hierarchy. Nothing in the
    ///      demo path contains the string `liquidity.turnstile.eth`.
    function test_nameIsDerivedFromTheRegistryHierarchy() public view {
        assertEq(
            TurnstileName.ensName(IRegistry(address(registry)), sellerLabel),
            string.concat(sellerLabel, ".", PARENT_LABEL, ".eth")
        );
        assertEq(sellerDnsName, NameCoder.encode(string.concat(sellerLabel, ".turnstile.eth")));
        assertEq(sellerNode, NameCoder.namehash(sellerDnsName, 0));
    }

    /// @dev And it follows the hierarchy rather than restating it: re-parent the
    ///      Turnstile registry under a different label and the derived name — and
    ///      therefore every namehash and every role resource — moves with it. A
    ///      hard-coded constant would keep pointing at a name we no longer own.
    function test_derivedNameFollowsAReparent() public {
        vm.prank(operator);
        registry.setParent(IRegistry(address(ethRegistry)), "elsewhere");

        assertEq(
            TurnstileName.ensName(IRegistry(address(registry)), sellerLabel),
            string.concat(sellerLabel, ".elsewhere.eth")
        );
        assertTrue(
            TurnstileName.node(IRegistry(address(registry)), sellerLabel) != sellerNode,
            "the namehash moved with the name"
        );
    }

    /// @dev A registry whose parent chain never terminates reverts by name rather
    ///      than running out of gas.
    function test_nameWalkIsBounded() public {
        vm.prank(operator);
        registry.setParent(IRegistry(address(registry)), "loop");

        vm.expectRevert(
            abi.encodeWithSelector(TurnstileName.ParentChainTooDeep.selector, TurnstileName.MAX_DEPTH)
        );
        harness.ensName(IRegistry(address(registry)), sellerLabel);
    }

    ////////////////////////////////////////////////////////////////////////
    // What the hot key may do
    ////////////////////////////////////////////////////////////////////////

    /// @dev The hot key's whole job: reprice and move the endpoint, every day,
    ///      without touching a Ledger.
    function test_hotKeyCanUpdateEndpointAndPrice() public {
        vm.startPrank(hotKey);
        resolver.setText(
            sellerNode,
            TurnstileOffer.agentEndpointKey(TurnstileOffer.PROTOCOL_MCP),
            "https://mcp-2.turnstile.example/v1/sse"
        );
        resolver.setText(sellerNode, TurnstileOffer.KEY_PRICE, "0.07");
        vm.stopPrank();

        assertEq(
            resolver.text(
                sellerNode,
                TurnstileOffer.agentEndpointKey(TurnstileOffer.PROTOCOL_MCP)
            ),
            "https://mcp-2.turnstile.example/v1/sse"
        );
        assertEq(resolver.text(sellerNode, TurnstileOffer.KEY_PRICE), "0.07");
    }

    /// @dev The authorization is exactly the two keys `hotKeyTextKeys()` names —
    ///      the same list the deploy script grants from — and it is scoped to the
    ///      part resource, not to the name.
    function test_hotKeyHoldsRoleSetTextOnExactlyTwoPartResources() public view {
        string[] memory keys = TurnstileOffer.hotKeyTextKeys();
        assertEq(keys.length, 2);

        for (uint256 i; i < keys.length; ++i) {
            uint256 part = uint256(
                PermissionedResolverLib.resource(
                    sellerNode,
                    PermissionedResolverLib.partHash(keys[i])
                )
            );
            assertTrue(
                resolver.hasRoles(part, PermissionedResolverLib.ROLE_SET_TEXT, hotKey),
                "authorized on its own part resource"
            );
        }

        // Not at the name level, and not at root.
        assertFalse(
            resolver.hasRoles(
                PermissionedResolverLib.resource(sellerNode, bytes32(0)),
                PermissionedResolverLib.ROLE_SET_TEXT,
                hotKey
            ),
            "no name-level write"
        );
        assertFalse(
            resolver.hasRootRoles(PermissionedResolverLib.ROLE_SET_TEXT, hotKey),
            "no root write"
        );
    }

    ////////////////////////////////////////////////////////////////////////
    // What the hot key may not do
    ////////////////////////////////////////////////////////////////////////

    /// @dev **The invariant, stated as a test.**
    ///
    /// A hot key that can reprice cannot redirect payment. `setAddr` is gated by
    /// `ROLE_SET_ADDR`, which the hot key holds on no resource at all, so
    /// `onlyPartRoles` falls through to the widest resource — the name — and
    /// reverts there.
    ///
    /// This is the difference between "the seller's day-to-day key is hot" and
    /// "the seller's money is hot". A stolen hot key costs the seller a wrong
    /// price for as long as it takes the cold key to rotate it. It cannot cost
    /// them a single payment.
    function test_hotKeyCannotChangeThePayoutAddress() public {
        uint256 nameResource = PermissionedResolverLib.resource(sellerNode, bytes32(0));

        vm.prank(hotKey);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                nameResource,
                PermissionedResolverLib.ROLE_SET_ADDR,
                hotKey
            )
        );
        resolver.setAddr(sellerNode, attacker);

        assertEq(resolver.addr(sellerNode), payable(payout), "payout is untouched");
    }

    /// @dev Not just `addr(60)` — the hot key holds `ROLE_SET_ADDR` nowhere, so no
    ///      coin type is reachable. Setting a Base or Solana payout address would
    ///      redirect payment just as effectively.
    function test_hotKeyCannotChangeThePayoutOnAnyOtherChainEither() public {
        uint256 baseCoinType = 0x80000000 | 8453;
        uint256 nameResource = PermissionedResolverLib.resource(sellerNode, bytes32(0));

        vm.prank(hotKey);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                nameResource,
                PermissionedResolverLib.ROLE_SET_ADDR,
                hotKey
            )
        );
        resolver.setAddr(sellerNode, baseCoinType, abi.encodePacked(attacker));
    }

    /// @dev The ceiling is the limit the spending tier must not be able to raise.
    ///      The hot key sets `turnstile:price`; only the cold key sets the bound
    ///      it is checked against.
    function test_hotKeyCannotRaiseThePriceCeiling() public {
        _expectHotKeyTextDenied();
        resolver.setText(sellerNode, TurnstileOffer.KEY_PRICE_CEILING, "999");

        assertEq(
            resolver.text(sellerNode, TurnstileOffer.KEY_PRICE_CEILING),
            _offer().priceCeiling
        );
    }

    /// @dev Nor may it rewrite what the service claims to be, or the ENSIP-25
    ///      backlink that ties the name to an ERC-8004 identity.
    function test_hotKeyCannotRewriteTheContextOrTheRegistration() public {
        _expectHotKeyTextDenied();
        resolver.setText(sellerNode, TurnstileOffer.KEY_AGENT_CONTEXT, "something else");

        _expectHotKeyTextDenied();
        resolver.setText(sellerNode, _registrationKey(), "");
    }

    /// @dev The authorization is per-name. A hot key for one seller subname is
    ///      powerless on the next one, even for the key it does hold.
    function test_hotKeyAuthorizationDoesNotSpreadToOtherNames() public {
        uint256 price = registrar.rentPrice("another", TERM);
        vm.deal(operator, price);
        vm.prank(operator);
        registrar.register{value: price}("another", operator, TERM);

        bytes32 otherNode = TurnstileName.node(IRegistry(address(registry)), "another");

        vm.prank(hotKey);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                PermissionedResolverLib.resource(otherNode, bytes32(0)),
                PermissionedResolverLib.ROLE_SET_TEXT,
                hotKey
            )
        );
        resolver.setText(otherNode, TurnstileOffer.KEY_PRICE, "0.01");
    }

    /// @dev And it cannot widen its own envelope. Granting needs
    ///      `ROLE_SET_TEXT_ADMIN`, which the hot key is never given — the same
    ///      rule that stops `TurnstileRegistrar` appointing a second registrar.
    function test_hotKeyCannotWidenItsOwnAuthority() public {
        uint256 nameResource = PermissionedResolverLib.resource(sellerNode, bytes32(0));

        vm.prank(hotKey);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACCannotGrantRoles.selector,
                nameResource,
                PermissionedResolverLib.ROLE_SET_TEXT,
                hotKey
            )
        );
        resolver.authorizeTextRoles(
            sellerDnsName,
            TurnstileOffer.KEY_AGENT_CONTEXT,
            hotKey,
            true
        );
    }

    ////////////////////////////////////////////////////////////////////////
    // What the cold key may do
    ////////////////////////////////////////////////////////////////////////

    /// @dev Rotation, in full: revoke the old hot key, authorize a new one. After
    ///      it, the old key is inert and the new one works — which is the whole
    ///      remedy for a hot-key compromise.
    function test_coldKeyRotatesTheHotKey() public {
        vm.startPrank(operator);
        TurnstileOffer.authorizeHotKey(resolver, sellerDnsName, hotKey, false);
        TurnstileOffer.authorizeHotKey(resolver, sellerDnsName, newHotKey, true);
        vm.stopPrank();

        _expectHotKeyTextDenied();
        resolver.setText(sellerNode, TurnstileOffer.KEY_PRICE, "0.09");

        vm.prank(newHotKey);
        resolver.setText(sellerNode, TurnstileOffer.KEY_PRICE, "0.09");
        assertEq(resolver.text(sellerNode, TurnstileOffer.KEY_PRICE), "0.09");
    }

    /// @dev The payout address moves only with the cold key.
    function test_coldKeyChangesThePayoutAddress() public {
        address newPayout = makeAddr("newPayout");

        vm.prank(operator);
        resolver.setAddr(sellerNode, newPayout);

        assertEq(resolver.addr(sellerNode), payable(newPayout));
    }

    /// @dev And the ceiling.
    function test_coldKeyRaisesThePriceCeiling() public {
        vm.prank(operator);
        resolver.setText(sellerNode, TurnstileOffer.KEY_PRICE_CEILING, "1.50");

        assertEq(resolver.text(sellerNode, TurnstileOffer.KEY_PRICE_CEILING), "1.50");
    }

    ////////////////////////////////////////////////////////////////////////
    // The third grantRoles trap
    ////////////////////////////////////////////////////////////////////////

    /// @dev `RolesTest` pins two `grantRoles` traps on the registry. There is a
    ///      third on the resolver, and it is the opposite of what MOV-212's notes
    ///      recorded: `PermissionedResolver` does not reinterpret `grantRoles`'s
    ///      first argument as a resource — it **disables the function outright**,
    ///      `pure` and always reverting. Every resolver grant has to go through
    ///      `authorize(Name|Text|Data|Addr)Roles`.
    ///
    ///      This one is loud rather than silent, but only if you try it. Code
    ///      written from the notes would reach for `grantRoles(resource, …)` and
    ///      find a revert with no hint about the replacement, so the note is
    ///      pinned here where the next person will read it.
    function test_resolverDisablesGrantRolesEntirely() public {
        uint256 nameResource = PermissionedResolverLib.resource(sellerNode, bytes32(0));

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACCannotGrantRoles.selector,
                nameResource,
                PermissionedResolverLib.ROLE_SET_TEXT,
                hotKey
            )
        );
        resolver.grantRoles(nameResource, PermissionedResolverLib.ROLE_SET_TEXT, hotKey);

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACCannotRevokeRoles.selector,
                nameResource,
                PermissionedResolverLib.ROLE_SET_TEXT,
                hotKey
            )
        );
        resolver.revokeRoles(nameResource, PermissionedResolverLib.ROLE_SET_TEXT, hotKey);
    }

    /// @dev Root grants on the resolver behave like everywhere else in EAC:
    ///      `grantRootRoles` is the only way in, and it is a cold-key operation.
    ///      A resolver root role is `ROLE_SET_TEXT` on *every* name at once, which
    ///      is precisely what the hot key must never receive.
    function test_grantingRootRolesOnTheResolverIsColdKeyOnly() public {
        vm.prank(hotKey);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACCannotGrantRoles.selector,
                uint256(0), // ROOT_RESOURCE
                PermissionedResolverLib.ROLE_SET_TEXT,
                hotKey
            )
        );
        resolver.grantRootRoles(PermissionedResolverLib.ROLE_SET_TEXT, hotKey);
    }

    ////////////////////////////////////////////////////////////////////////
    // Helpers
    ////////////////////////////////////////////////////////////////////////

    /// @dev Prank as `hotKey` and expect the name-level `setText` denial. The
    ///      resource in the error is the *name*, not the part: `onlyPartRoles`
    ///      falls through to the widest resource before reverting, so this is what
    ///      every unauthorized key produces.
    function _expectHotKeyTextDenied() internal {
        vm.prank(hotKey);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                PermissionedResolverLib.resource(sellerNode, bytes32(0)),
                PermissionedResolverLib.ROLE_SET_TEXT,
                hotKey
            )
        );
    }
}
