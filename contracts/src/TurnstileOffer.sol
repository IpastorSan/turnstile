// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {IVerifiableFactory} from "@ensdomains/verifiable-factory/IVerifiableFactory.sol";

import {COIN_TYPE_ETH} from "@ens/contracts/utils/ENSIP19.sol";

import {PermissionedResolver} from "@ens/v2/resolver/PermissionedResolver.sol";
import {PermissionedResolverLib} from "@ens/v2/resolver/libraries/PermissionedResolverLib.sol";

/// @title TurnstileOffer
/// @notice The seller's offer, expressed as ENS records, plus the cold/hot role
///         split that decides who may rewrite which of them.
///
/// ## The records are standard, not bespoke
///
/// A Turnstile offer is discoverable by any ENS-aware agent that has never heard
/// of Turnstile, because the entry point is three keys from the AI-agent ENSIPs
/// rather than a schema we invented:
///
/// | Key | Standard | What it carries |
/// | --- | --- | --- |
/// | `agent-context` | ENSIP-26 | Free-form service description — the discovery entry point |
/// | `agent-endpoint[mcp]` | ENSIP-26 | The MCP endpoint URI (`mcp`, `a2a`, `web` are the known protocols) |
/// | `agent-registration[<registry>][<agentId>]` | ENSIP-25 | Backlink to an ERC-8004 registry entry; value `"1"` |
///
/// Only then do the Turnstile-specific keys sit on top — `turnstile:price`,
/// `turnstile:rails`, `turnstile:operator-proof`, `turnstile:price-ceiling`. An
/// agent that understands only the ENSIPs can still find the service and connect
/// to it; the `turnstile:` keys are what it needs to *pay*.
///
/// The payout address is deliberately **not** a `turnstile:` text record. It is
/// the name's ENSIP-1 `addr()` record — the one record every ENS client already
/// knows means "send funds here". Making it a bespoke text key would have hidden
/// the single most security-relevant field behind a schema nobody else reads.
///
/// ## The role split
///
/// `PermissionedResolver` scopes roles by `resource(node, part)` where `part` is
/// a record-type identifier, so a role can be scoped to **one text key on one
/// name**. Three setters are part-scoped this way — `setText(key)`,
/// `setData(key)` and `setAddr(coinType)`; the rest (`setName`, `setABI`,
/// `setContenthash`, `setPubkey`, `setInterface`, `clearRecords`) pass `part = 0`
/// and are therefore name-level only.
///
/// That is exactly the granularity the cold/warm/hot invariant in `CLAUDE.md`
/// needs:
///
/// * **Cold key** (held offline) holds root roles on the resolver. It owns the
///   name, publishes the offer, rotates the hot key, changes the payout address,
///   and raises `turnstile:price-ceiling`.
/// * **Hot key** (the seller's day-to-day signer) is authorized on exactly two
///   part resources: `agent-endpoint[mcp]` and `turnstile:price`. It can move its
///   endpoint and reprice, every day, without the cold key. It cannot touch the
///   payout address, the ceiling, the context, or anything else — and because it
///   is never granted `ROLE_SET_TEXT_ADMIN`, it cannot grant itself more either.
///
/// `turnstile:price-ceiling` is where the invariant bites: the hot key sets the
/// price and the cold key sets the bound, so the key that transacts cannot raise
/// its own limit. What the resolver enforces on-chain is *who may write which
/// key*; comparing the two values is the buyer's agent's job, and it can do it
/// from two `text()` calls.
///
/// ## Why this types against ENS's contract
///
/// This library imports the concrete `PermissionedResolver` rather than declaring
/// a local interface. `authorizeTextRoles` and friends are not in
/// `IPermissionedResolver`, so a local interface would be a hand-copied ABI that
/// can drift from the deployment silently. The submodule is pinned to the exact
/// revision MOV-212 verified byte-for-byte against the Sepolia implementation, so
/// typing against the source is typing against what is deployed.
library TurnstileOffer {
    using Strings for uint256;

    ////////////////////////////////////////////////////////////////////////
    // Record keys
    ////////////////////////////////////////////////////////////////////////

    /// @notice ENSIP-26. Free-form description of the service; the discovery
    ///         entry point for an agent that knows nothing about Turnstile.
    string internal constant KEY_AGENT_CONTEXT = "agent-context";

    /// @notice ENSIP-26 protocol identifier for Model Context Protocol endpoints.
    ///         The other known values are `a2a` and `web`.
    string internal constant PROTOCOL_MCP = "mcp";

    /// @notice ENSIP-25 record value. Any non-empty value asserts the link; the
    ///         spec's canonical value is `"1"`.
    string internal constant AGENT_REGISTRATION_VALUE = "1";

    /// @notice Price per query, as a decimal string in the unit named by
    ///         `KEY_RAILS`. Hot-key writable.
    string internal constant KEY_PRICE = "turnstile:price";

    /// @notice The ceiling `turnstile:price` may not exceed. **Cold key only** —
    ///         this is the limit the spending tier must not be able to raise.
    string internal constant KEY_PRICE_CEILING = "turnstile:price-ceiling";

    /// @notice Payment rails the seller accepts, e.g. `x402,usdc-arc`.
    string internal constant KEY_RAILS = "turnstile:rails";

    /// @notice Attestation that the operator identity behind this name is
    ///         device-backed. Cold key only, by construction.
    string internal constant KEY_OPERATOR_PROOF = "turnstile:operator-proof";

    ////////////////////////////////////////////////////////////////////////
    // Role bitmaps
    ////////////////////////////////////////////////////////////////////////

    /// @notice Root roles held by the seller's cold operator identity on the
    ///         Turnstile resolver.
    ///
    /// Both halves of every capability, for the same reason as
    /// `TurnstileRegistry.OPERATOR_ROOT_ROLES`: the regular role is what
    /// `onlyPartRoles` checks, so it is what lets the cold key *write* a record;
    /// the `_ADMIN` half is what `_getSettableRoles` checks, so it is what lets
    /// the cold key *delegate* that write to the hot key. `hasRootRoles` compares
    /// raw bitmaps and does not apply the "admin implies regular" rule, so
    /// holding one does not imply the other.
    uint256 internal constant OPERATOR_RESOLVER_ROLES =
        PermissionedResolverLib.ROLE_SET_ADDR |
        PermissionedResolverLib.ROLE_SET_ADDR_ADMIN |
        PermissionedResolverLib.ROLE_SET_TEXT |
        PermissionedResolverLib.ROLE_SET_TEXT_ADMIN |
        PermissionedResolverLib.ROLE_SET_DATA |
        PermissionedResolverLib.ROLE_SET_DATA_ADMIN |
        PermissionedResolverLib.ROLE_SET_CONTENTHASH |
        PermissionedResolverLib.ROLE_SET_CONTENTHASH_ADMIN |
        PermissionedResolverLib.ROLE_SET_PUBKEY |
        PermissionedResolverLib.ROLE_SET_PUBKEY_ADMIN |
        PermissionedResolverLib.ROLE_SET_ABI |
        PermissionedResolverLib.ROLE_SET_ABI_ADMIN |
        PermissionedResolverLib.ROLE_SET_INTERFACE |
        PermissionedResolverLib.ROLE_SET_INTERFACE_ADMIN |
        PermissionedResolverLib.ROLE_SET_NAME |
        PermissionedResolverLib.ROLE_SET_NAME_ADMIN |
        PermissionedResolverLib.ROLE_SET_ALIAS |
        PermissionedResolverLib.ROLE_SET_ALIAS_ADMIN |
        PermissionedResolverLib.ROLE_CLEAR |
        PermissionedResolverLib.ROLE_CLEAR_ADMIN |
        PermissionedResolverLib.ROLE_UPGRADE |
        PermissionedResolverLib.ROLE_UPGRADE_ADMIN;

    ////////////////////////////////////////////////////////////////////////
    // Deployment
    ////////////////////////////////////////////////////////////////////////

    /// @notice Deploy the Turnstile resolver as a `PermissionedResolver`
    ///         verifiable proxy, exactly as `TurnstileRegistry.deploy` does for
    ///         the registry.
    ///
    /// @dev Same reasoning as the registry: behind a `VerifiableFactory` anyone
    ///      can call `verifyContract(proxy)` and confirm the implementation is
    ///      ENS's stock `PermissionedResolver` rather than a look-alike that
    ///      answers `text()` honestly for a while. A buyer's agent trusting a
    ///      price record needs that.
    ///
    /// @param factory The `VerifiableFactory`.
    /// @param resolverImpl The canonical `PermissionedResolver` implementation.
    /// @param salt Caller-chosen salt; the factory derives its CREATE2 salt as
    ///        `keccak256(abi.encode(msg.sender, salt))`.
    /// @param admin The cold key, granted `roleBitmap` at root.
    /// @param roleBitmap Normally `OPERATOR_RESOLVER_ROLES`.
    function deployResolver(
        IVerifiableFactory factory,
        address resolverImpl,
        uint256 salt,
        address admin,
        uint256 roleBitmap
    )
        internal
        returns (PermissionedResolver)
    {
        // No initializer-time setters: records are written afterwards by the cold
        // key, through the same permission checks everyone else goes through.
        // `PermissionedResolver._checkRoles` is a no-op while initializing, so a
        // record smuggled in here would bypass the role split this whole library
        // exists to enforce.
        bytes[] memory setters = new bytes[](0);
        return
            PermissionedResolver(
                factory.deployProxy(
                    resolverImpl,
                    salt,
                    abi.encodeCall(PermissionedResolver.initialize, (admin, roleBitmap, setters))
                )
            );
    }

    ////////////////////////////////////////////////////////////////////////
    // The offer
    ////////////////////////////////////////////////////////////////////////

    /// @notice One seller's offer, as it will be written to the resolver.
    struct Offer {
        string context; //          agent-context                       (ENSIP-26)
        string mcpEndpoint; //      agent-endpoint[mcp]                 (ENSIP-26)
        string price; //            turnstile:price                     hot-writable
        string priceCeiling; //     turnstile:price-ceiling             cold only
        string rails; //            turnstile:rails
        string operatorProof; //    turnstile:operator-proof
        address payout; //          addr(60)                            cold only
        uint256 agentRegistryChainId; // ENSIP-25 <registry>, chain half
        address agentRegistry; //        ENSIP-25 <registry>, address half
        uint256 agentId; //              ENSIP-25 <agentId>
    }

    /// @notice ENSIP-26 `agent-endpoint[<protocol>]`.
    function agentEndpointKey(string memory protocol) internal pure returns (string memory) {
        return string.concat("agent-endpoint[", protocol, "]");
    }

    /// @notice ENSIP-25 `agent-registration[<registry>][<agentId>]`, where
    ///         `<registry>` is the ERC-7930 interoperable address of the agent
    ///         registry, lowercase hex with an `0x` prefix.
    ///
    /// @dev The spec's own example is
    ///      `agent-registration[0x000100000101148004a169fb4a3325136eb29fa0ceb6d2e539a432][42]`
    ///      — the ERC-8004 IdentityRegistry at `0x8004A169…a432` on mainnet, agent
    ///      42. `OfferRecordsTest.test_agentRegistrationKeyMatchesTheEnsip25Example`
    ///      reproduces that string exactly, so this encoder cannot drift from the
    ///      standard without a test failing.
    function agentRegistrationKey(uint256 chainId, address registry, uint256 agentId)
        internal
        pure
        returns (string memory)
    {
        return
            string.concat(
                "agent-registration[",
                toHexString(erc7930(chainId, registry)),
                "][",
                agentId.toString(),
                "]"
            );
    }

    /// @notice The exact text keys the hot key is authorized to write.
    ///
    /// @dev Single source of truth. The deploy script grants from this list and
    ///      the tests assert against it, so the deployed authorization and the
    ///      documented one cannot disagree.
    function hotKeyTextKeys() internal pure returns (string[] memory keys) {
        keys = new string[](2);
        keys[0] = agentEndpointKey(PROTOCOL_MCP);
        keys[1] = KEY_PRICE;
    }

    ////////////////////////////////////////////////////////////////////////
    // Publishing
    ////////////////////////////////////////////////////////////////////////

    /// @notice The calls that write `offer` to `node`, ready for
    ///         `PermissionedResolver.multicall`.
    ///
    /// @dev Returned as calldata rather than executed so the whole offer lands in
    ///      one transaction — which matters when the signer is a cold key and
    ///      every extra transaction is another offline signing ceremony.
    function publishCalls(bytes32 node, Offer memory offer)
        internal
        pure
        returns (bytes[] memory calls)
    {
        calls = new bytes[](7);
        calls[0] = abi.encodeCall(
            PermissionedResolver.setText,
            (node, KEY_AGENT_CONTEXT, offer.context)
        );
        calls[1] = abi.encodeCall(
            PermissionedResolver.setText,
            (node, agentEndpointKey(PROTOCOL_MCP), offer.mcpEndpoint)
        );
        calls[2] = abi.encodeCall(
            PermissionedResolver.setText,
            (
                node,
                agentRegistrationKey(offer.agentRegistryChainId, offer.agentRegistry, offer.agentId),
                AGENT_REGISTRATION_VALUE
            )
        );
        calls[3] = abi.encodeCall(PermissionedResolver.setText, (node, KEY_PRICE, offer.price));
        calls[4] = abi.encodeCall(
            PermissionedResolver.setText,
            (node, KEY_PRICE_CEILING, offer.priceCeiling)
        );
        calls[5] = abi.encodeCall(PermissionedResolver.setText, (node, KEY_RAILS, offer.rails));
        calls[6] = abi.encodeCall(
            PermissionedResolver.setText,
            (node, KEY_OPERATOR_PROOF, offer.operatorProof)
        );
    }

    /// @notice Write `offer` to `node`, and set the payout address.
    /// @dev Caller must hold the cold key's roles. `setAddr` is a separate call
    ///      because it is `public`, not `external`, so it cannot be routed through
    ///      the resolver's `multicall` — `multicall` delegatecalls into `this`,
    ///      and `abi.encodeCall` on a public function is fine, but keeping the
    ///      payout write visibly separate is also the honest shape: it is the one
    ///      write in this function the hot key may never make.
    function publish(PermissionedResolver resolver, bytes32 node, Offer memory offer) internal {
        resolver.multicall(publishCalls(node, offer));
        resolver.setAddr(node, COIN_TYPE_ETH, abi.encodePacked(offer.payout));
    }

    ////////////////////////////////////////////////////////////////////////
    // Hot-key authorization
    ////////////////////////////////////////////////////////////////////////

    /// @notice Grant or revoke the hot key's per-record authorization.
    ///
    /// @dev Rotation is `authorizeHotKey(resolver, name, oldHot, false)` followed
    ///      by `authorizeHotKey(resolver, name, newHot, true)`. Both require the
    ///      cold key's `ROLE_SET_TEXT_ADMIN`, which the hot key never holds.
    ///
    /// @param resolver The Turnstile resolver.
    /// @param dnsName The DNS-encoded name, from `TurnstileName.dnsName`.
    /// @param hotKey The seller's day-to-day signer.
    /// @param grant `true` to authorize, `false` to revoke.
    function authorizeHotKey(
        PermissionedResolver resolver,
        bytes memory dnsName,
        address hotKey,
        bool grant
    )
        internal
    {
        string[] memory keys = hotKeyTextKeys();
        for (uint256 i; i < keys.length; ++i) {
            resolver.authorizeTextRoles(dnsName, keys[i], hotKey, grant);
        }
    }

    ////////////////////////////////////////////////////////////////////////
    // ERC-7930
    ////////////////////////////////////////////////////////////////////////

    /// @notice ERC-7930 interoperable binary address for an EVM contract.
    ///
    /// @dev Layout, all big-endian:
    ///      `version(2) || chainType(2) || refLen(1) || chainRef(refLen) || addrLen(1) || addr(20)`
    ///      with version `0x0001` and chain type `0x0000` (CAIP-2 `eip155`). The
    ///      chain reference is the chain id with leading zero bytes stripped, so
    ///      mainnet is one byte (`0x01`) and Sepolia is three (`0xaa36a7`).
    function erc7930(uint256 chainId, address addr) internal pure returns (bytes memory) {
        bytes memory ref = chainReference(chainId);
        return
            abi.encodePacked(
                bytes2(0x0001), //     version 1
                bytes2(0x0000), //     chain type: eip155
                uint8(ref.length),
                ref,
                uint8(20), //          address length
                addr
            );
    }

    /// @notice A chain id is zero, which is not an `eip155` chain.
    error InvalidChainId();

    /// @notice The chain id as minimal-length big-endian bytes.
    function chainReference(uint256 chainId) internal pure returns (bytes memory ref) {
        if (chainId == 0) {
            revert InvalidChainId();
        }
        uint256 length;
        for (uint256 v = chainId; v != 0; v >>= 8) {
            ++length;
        }
        ref = new bytes(length);
        for (uint256 i; i < length; ++i) {
            ref[length - 1 - i] = bytes1(uint8(chainId >> (8 * i)));
        }
    }

    /// @notice Lowercase `0x`-prefixed hex, as ENSIP-25 writes the registry half
    ///         of its key.
    /// @dev `Strings.toHexString` only takes a `uint256` or an `address`, and the
    ///      ERC-7930 encoding is neither — it is a variable-length byte string
    ///      whose leading zero bytes are significant.
    function toHexString(bytes memory raw) internal pure returns (string memory) {
        bytes memory digits = "0123456789abcdef";
        bytes memory out = new bytes(2 + raw.length * 2);
        out[0] = "0";
        out[1] = "x";
        for (uint256 i; i < raw.length; ++i) {
            out[2 + i * 2] = digits[uint8(raw[i]) >> 4];
            out[3 + i * 2] = digits[uint8(raw[i]) & 0x0f];
        }
        return string(out);
    }
}
