// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {IVerifiableFactory} from "@ensdomains/verifiable-factory/IVerifiableFactory.sol";

import {IPermissionedRegistry} from "@ens/v2/registry/interfaces/IPermissionedRegistry.sol";
import {IRegistry} from "@ens/v2/registry/interfaces/IRegistry.sol";
import {PermissionedResolver} from "@ens/v2/resolver/PermissionedResolver.sol";
import {PermissionedResolverLib} from "@ens/v2/resolver/libraries/PermissionedResolverLib.sol";
import {LibLabel} from "@ens/v2/utils/LibLabel.sol";

import {TurnstileName} from "../src/TurnstileName.sol";
import {TurnstileOffer} from "../src/TurnstileOffer.sol";
import {TurnstileRegistrar} from "../src/TurnstileRegistrar.sol";
import {TurnstileRegistry} from "../src/TurnstileRegistry.sol";

import {EnsSepolia} from "./EnsSepolia.sol";

/// @notice The ERC-8004 `IdentityRegistry`, as much of it as we call.
interface IAgentIdentityRegistry {
    function register(string calldata agentURI) external returns (uint256 agentId);
    function ownerOf(uint256 tokenId) external view returns (address);
    function tokenURI(uint256 tokenId) external view returns (string memory);
}

/// @title PublishOffer
/// @notice Deploys the Turnstile resolver, mints a seller subname, publishes the
///         offer as ENSIP-25/26 records, and authorizes the hot key on exactly
///         two of them.
///
/// Runs after `Deploy.s.sol`, and reads that script's output rather than taking
/// the registry and registrar addresses again by hand.
///
/// ```bash
/// forge script script/PublishOffer.s.sol:PublishOffer \
///   --rpc-url "$SEPOLIA_RPC_URL" --broadcast
/// ```
///
/// Idempotent in the same way `Deploy.s.sol` is: the resolver lands at a CREATE2
/// address derived from a salt, and every other step is guarded by a read of the
/// state it would establish. Re-running after a partial failure resumes.
///
/// Environment:
///
/// | Variable                        | Required | Default                                |
/// |---------------------------------|----------|----------------------------------------|
/// | `DEPLOYER_PRIVATE_KEY`          | yes      | — (the **cold** key)                   |
/// | `TURNSTILE_HOT_KEY`             | yes      | — (address only; never its key)        |
/// | `TURNSTILE_SELLER_LABEL`        | no       | `liquidity`                            |
/// | `TURNSTILE_RESOLVER_SALT`       | no       | derived from the seller label          |
/// | `TURNSTILE_TERM_SECONDS`        | no       | 365 days                               |
/// | `TURNSTILE_PAYOUT`              | no       | `paymentReceiver` from the deploy file |
/// | `TURNSTILE_AGENT_CONTEXT`       | no       | see `_offer`                           |
/// | `TURNSTILE_MCP_ENDPOINT`        | no       | see `_offer`                           |
/// | `TURNSTILE_PRICE`               | no       | `0.05`                                 |
/// | `TURNSTILE_PRICE_CEILING`       | no       | `0.50`                                 |
/// | `TURNSTILE_RAILS`               | no       | `x402,usdc-arc`                        |
/// | `TURNSTILE_OPERATOR_PROOF`      | no       | `operator-key-role-scoped`                     |
/// | `TURNSTILE_AGENT_REGISTRY`      | no       | ERC-8004 `IdentityRegistry` on Sepolia |
/// | `TURNSTILE_AGENT_ID`            | no       | registers a new one and records it     |
///
/// The **hot key's private key is never read here**, by design. This script runs
/// entirely as the cold key: it grants the hot key its two authorizations and
/// stops. Proving the hot key can use them, and cannot exceed them, is a separate
/// signer — see `docs/ens-offer-records.md`.
contract PublishOffer is Script {
    using stdJson for string;

    /// @dev The ERC-8004 `IdentityRegistry` proxy on Sepolia. Verified: it holds
    ///      code, its ERC-1967 implementation slot points at
    ///      `0x7274e874ca62410a93bd8bf61c69d8045e399c02`, and it answers
    ///      `name() == "AgentIdentity"`. Overridable via `TURNSTILE_AGENT_REGISTRY`.
    address internal constant ERC8004_IDENTITY_REGISTRY_SEPOLIA =
        0x8004A818BFB912233c491871b3d84c89A494BD9e;

    /// @dev Our own deployment record, written by `Deploy.s.sol`.
    string internal constant TURNSTILE_ADDRESSES_PATH = "addresses.turnstile.sepolia.json";

    struct Config {
        address cold;
        address hot;
        string sellerLabel;
        uint256 resolverSalt;
        uint64 term;
        address payout;
        address agentRegistry;
        uint256 agentId;
    }

    function run() external {
        uint256 coldKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        Config memory cfg = _config(vm.addr(coldKey));

        string memory ens = EnsSepolia.load();
        IVerifiableFactory factory =
            IVerifiableFactory(EnsSepolia.lookup(ens, "VerifiableFactory"));
        address resolverImpl = EnsSepolia.lookup(ens, "PermissionedResolverImpl");

        string memory ours = _loadTurnstileAddresses();
        IPermissionedRegistry registry =
            IPermissionedRegistry(ours.readAddress(".turnstileRegistry"));
        TurnstileRegistrar registrar =
            TurnstileRegistrar(payable(ours.readAddress(".turnstileRegistrar")));

        // Derived, never written down. See TurnstileName.
        string memory ensName = TurnstileName.ensName(IRegistry(address(registry)), cfg.sellerLabel);
        bytes memory dnsName = TurnstileName.dnsName(IRegistry(address(registry)), cfg.sellerLabel);
        bytes32 node = TurnstileName.node(IRegistry(address(registry)), cfg.sellerLabel);

        console2.log("cold key          ", cfg.cold);
        console2.log("hot key           ", cfg.hot);
        console2.log("registry          ", address(registry));
        console2.log("registrar         ", address(registrar));
        console2.log("resolver impl     ", resolverImpl);
        console2.log("seller name       ", ensName);
        console2.log("namehash          ", vm.toString(node));

        vm.startBroadcast(coldKey);

        PermissionedResolver resolver =
            _deployResolver(cfg, factory, resolverImpl);
        _setDefaultResolver(registrar, resolver);
        cfg.agentId = _ensureAgentRegistration(cfg, ensName);
        uint256 tokenId = _mintSellerName(cfg, registry, registrar);
        _attachResolver(cfg, registry, tokenId, resolver);
        _publishOffer(cfg, resolver, node, ensName);
        _authorizeHotKey(cfg, resolver, dnsName, node);

        vm.stopBroadcast();

        _writeOfferFile(cfg, resolver, ensName, node, tokenId);
    }

    ////////////////////////////////////////////////////////////////////////
    // Steps
    ////////////////////////////////////////////////////////////////////////

    /// @dev A `PermissionedResolver` behind the canonical `VerifiableFactory`, so
    ///      a buyer's agent can call `verifyContract(resolver)` and confirm it is
    ///      ENS's stock implementation before trusting a price it reads there.
    ///      `TurnstileRegistry.predictAddress` is the factory's own CREATE2
    ///      derivation and does not depend on the implementation, so it works for
    ///      the resolver proxy unchanged.
    function _deployResolver(
        Config memory cfg,
        IVerifiableFactory factory,
        address resolverImpl
    )
        internal
        returns (PermissionedResolver resolver)
    {
        (bool ok, bytes memory ret) =
            address(factory).staticcall(abi.encodeWithSignature("proxyLogic()"));
        require(ok, "VerifiableFactory.proxyLogic() failed - wrong address?");
        address proxyLogic = abi.decode(ret, (address));

        address predicted = TurnstileRegistry.predictAddress(
            address(factory),
            proxyLogic,
            cfg.cold,
            cfg.resolverSalt
        );
        if (predicted.code.length > 0) {
            console2.log("resolver          ", predicted, "(already deployed)");
            return PermissionedResolver(predicted);
        }

        resolver = TurnstileOffer.deployResolver(
            factory,
            resolverImpl,
            cfg.resolverSalt,
            cfg.cold,
            TurnstileOffer.OPERATOR_RESOLVER_ROLES
        );
        require(address(resolver) == predicted, "predicted resolver address was wrong");
        console2.log("resolver          ", address(resolver), "(deployed)");
    }

    /// @dev So that every subname the registrar sells gets the resolver at mint,
    ///      rather than the demo name being special.
    function _setDefaultResolver(TurnstileRegistrar registrar, PermissionedResolver resolver)
        internal
    {
        if (registrar.defaultResolver() == address(resolver)) {
            console2.log("default resolver   already set");
            return;
        }
        registrar.setDefaultResolver(address(resolver));
        console2.log("default resolver   set");
    }

    /// @dev The ENSIP-25 record asserts "this name is agent `<id>` in registry
    ///      `<r>`". Pointing it at an id we do not own would make the record a
    ///      claim about somebody else's agent, so we register one.
    ///
    ///      `TURNSTILE_AGENT_ID`, or a previously recorded id in the offer file,
    ///      short-circuits this — otherwise a re-run would mint a second agent
    ///      and leave the first orphaned.
    function _ensureAgentRegistration(Config memory cfg, string memory ensName)
        internal
        returns (uint256 agentId)
    {
        if (cfg.agentId != 0) {
            console2.log("erc-8004 agent     already registered:", cfg.agentId);
            return cfg.agentId;
        }
        // The ENS name is the agent's identity; the registry entry points back at
        // it, so the ENSIP-25 link reads the same from either end.
        agentId = IAgentIdentityRegistry(cfg.agentRegistry).register(ensName);
        console2.log("erc-8004 agent     registered:", agentId);
    }

    function _mintSellerName(
        Config memory cfg,
        IPermissionedRegistry registry,
        TurnstileRegistrar registrar
    )
        internal
        returns (uint256 tokenId)
    {
        uint256 labelId = LibLabel.id(cfg.sellerLabel);
        if (registry.getStatus(labelId) == IPermissionedRegistry.Status.REGISTERED) {
            tokenId = registry.getTokenId(labelId);
            console2.log("seller name        already registered, token", tokenId);
            return tokenId;
        }
        uint256 price = registrar.rentPrice(cfg.sellerLabel, cfg.term);
        tokenId = registrar.register{value: price}(cfg.sellerLabel, cfg.cold, cfg.term);
        console2.log("seller name        minted, token", tokenId);
        console2.log("  paid (wei)       ", price);
    }

    /// @dev Covers a name minted before `defaultResolver` was set.
    function _attachResolver(
        Config memory cfg,
        IPermissionedRegistry registry,
        uint256 tokenId,
        PermissionedResolver resolver
    )
        internal
    {
        if (registry.getResolver(cfg.sellerLabel) == address(resolver)) {
            console2.log("resolver attached  already");
            return;
        }
        registry.setResolver(tokenId, address(resolver));
        console2.log("resolver attached  set");
    }

    /// @dev One multicall for the six text records, then the payout address. The
    ///      payout is a separate call on purpose: it is the one write in this
    ///      function the hot key may never make.
    function _publishOffer(
        Config memory cfg,
        PermissionedResolver resolver,
        bytes32 node,
        string memory ensName
    )
        internal
    {
        TurnstileOffer.Offer memory offer = _offer(cfg, ensName);
        TurnstileOffer.publish(resolver, node, offer);
        console2.log("offer              published");
        console2.log(
            "  ensip-25 key     ",
            TurnstileOffer.agentRegistrationKey(block.chainid, cfg.agentRegistry, cfg.agentId)
        );
        console2.log("  payout           ", offer.payout);
    }

    /// @dev `authorizeTextRoles` per key, from `TurnstileOffer.hotKeyTextKeys()`.
    ///      Not `grantRoles` — `PermissionedResolver` disables that outright, and
    ///      not `grantRootRoles`, which would be `ROLE_SET_TEXT` on every name.
    function _authorizeHotKey(
        Config memory cfg,
        PermissionedResolver resolver,
        bytes memory dnsName,
        bytes32 node
    )
        internal
    {
        string[] memory keys = TurnstileOffer.hotKeyTextKeys();
        bool needed;
        for (uint256 i; i < keys.length; ++i) {
            uint256 part = PermissionedResolverLib.resource(
                node,
                PermissionedResolverLib.partHash(keys[i])
            );
            if (!resolver.hasRoles(part, PermissionedResolverLib.ROLE_SET_TEXT, cfg.hot)) {
                needed = true;
            }
        }
        if (!needed) {
            console2.log("hot key            already authorized");
            return;
        }
        TurnstileOffer.authorizeHotKey(resolver, dnsName, cfg.hot, true);
        for (uint256 i; i < keys.length; ++i) {
            console2.log("hot key authorized ", keys[i]);
        }
    }

    ////////////////////////////////////////////////////////////////////////
    // Config and output
    ////////////////////////////////////////////////////////////////////////

    function _config(address cold) internal view returns (Config memory cfg) {
        cfg.cold = cold;
        cfg.hot = vm.envAddress("TURNSTILE_HOT_KEY");
        require(cfg.hot != cfg.cold, "the hot key must not be the cold key");
        cfg.sellerLabel = vm.envOr("TURNSTILE_SELLER_LABEL", string("liquidity"));
        cfg.resolverSalt = vm.envOr(
            "TURNSTILE_RESOLVER_SALT",
            uint256(keccak256(bytes(string.concat("turnstile:resolver:", cfg.sellerLabel))))
        );
        cfg.term = uint64(vm.envOr("TURNSTILE_TERM_SECONDS", uint256(365 days)));
        cfg.agentRegistry =
            vm.envOr("TURNSTILE_AGENT_REGISTRY", ERC8004_IDENTITY_REGISTRY_SEPOLIA);
        cfg.agentId =
            vm.envOr("TURNSTILE_AGENT_ID", _recordedAgentId(cold, cfg.agentRegistry));

        string memory ours = _loadTurnstileAddresses();
        cfg.payout = vm.envOr("TURNSTILE_PAYOUT", ours.readAddress(".paymentReceiver"));
    }

    function _offer(Config memory cfg, string memory ensName)
        internal
        view
        returns (TurnstileOffer.Offer memory)
    {
        return
            TurnstileOffer.Offer({
                context: vm.envOr(
                    "TURNSTILE_AGENT_CONTEXT",
                    string(
                        "Uniswap v4 pool liquidity analytics over Sepolia and mainnet. "
                        "Priced per query, paid on x402 or USDC. Sells answers, not the method."
                    )
                ),
                mcpEndpoint: vm.envOr(
                    "TURNSTILE_MCP_ENDPOINT",
                    string.concat("https://mcp.turnstile.xyz/", ensName, "/sse")
                ),
                price: vm.envOr("TURNSTILE_PRICE", string("0.05")),
                priceCeiling: vm.envOr("TURNSTILE_PRICE_CEILING", string("0.50")),
                rails: vm.envOr("TURNSTILE_RAILS", string("x402,usdc-arc")),
                // 2026-09-08, MOV-000: this default was "ledger-key-ring". The Ledger
                // track is not pursued (see CLAUDE.md), so publishing that string would
                // assert hardware we do not have. NOTE: the record already live on
                // Sepolia still reads "ledger-key-ring" — rewriting it is a cold-key
                // transaction, tracked in docs/ens-offer-records.md.
                operatorProof: vm.envOr("TURNSTILE_OPERATOR_PROOF", string("operator-key-role-scoped")),
                payout: cfg.payout,
                agentRegistryChainId: block.chainid,
                agentRegistry: cfg.agentRegistry,
                agentId: cfg.agentId
            });
    }

    function _loadTurnstileAddresses() internal view returns (string memory) {
        return vm.readFile(string.concat(vm.projectRoot(), "/", TURNSTILE_ADDRESSES_PATH));
    }

    /// @dev The agent id from a previous run, if there was one and we still own
    ///      it. Keeps a re-run from minting a second ERC-8004 agent and orphaning
    ///      the first.
    ///
    ///      The `ownerOf` check is what makes this safe against a **dry run**: a
    ///      simulation writes the offer file too, so without it the id minted in
    ///      simulation would be recorded, and the subsequent broadcast would skip
    ///      registration and publish an ENSIP-25 record pointing at an agent that
    ///      does not exist. `ownerOf` reverts `ERC721NonexistentToken` for that
    ///      id, so the catch falls through to registering for real.
    function _recordedAgentId(address cold, address agentRegistry)
        internal
        view
        returns (uint256)
    {
        string memory ours = _loadTurnstileAddresses();
        if (!ours.keyExists(".erc8004AgentId")) {
            return 0;
        }
        uint256 recorded = ours.readUint(".erc8004AgentId");
        if (recorded == 0) {
            return 0;
        }
        try IAgentIdentityRegistry(agentRegistry).ownerOf(recorded) returns (address owner) {
            return owner == cold ? recorded : 0;
        } catch {
            return 0;
        }
    }

    /// @dev Appended to `Deploy.s.sol`'s file rather than written beside it: the
    ///      resolver, the seller name and the hot key are part of the same
    ///      deployment record, and a second file would drift.
    function _writeOfferFile(
        Config memory cfg,
        PermissionedResolver resolver,
        string memory ensName,
        bytes32 node,
        uint256 tokenId
    )
        internal
    {
        string memory ours = _loadTurnstileAddresses();
        string memory obj = "turnstile";

        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeString(obj, "parentLabel", ours.readString(".parentLabel"));
        vm.serializeUint(obj, "salt", ours.readUint(".salt"));
        vm.serializeAddress(obj, "deployer", ours.readAddress(".deployer"));
        vm.serializeAddress(obj, "paymentReceiver", ours.readAddress(".paymentReceiver"));
        vm.serializeAddress(obj, "ensVerifiableFactory", ours.readAddress(".ensVerifiableFactory"));
        vm.serializeAddress(obj, "ensUserRegistryImpl", ours.readAddress(".ensUserRegistryImpl"));
        vm.serializeAddress(obj, "ensEthRegistry", ours.readAddress(".ensEthRegistry"));
        vm.serializeAddress(obj, "turnstileRegistry", ours.readAddress(".turnstileRegistry"));
        vm.serializeAddress(obj, "turnstileRegistrar", ours.readAddress(".turnstileRegistrar"));
        vm.serializeBool(obj, "linkedIntoHierarchy", ours.readBool(".linkedIntoHierarchy"));

        vm.serializeAddress(obj, "resolver", address(resolver));
        vm.serializeUint(obj, "resolverSalt", cfg.resolverSalt);
        vm.serializeAddress(obj, "coldKey", cfg.cold);
        vm.serializeAddress(obj, "hotKey", cfg.hot);
        vm.serializeAddress(obj, "payout", cfg.payout);
        vm.serializeString(obj, "sellerLabel", cfg.sellerLabel);
        vm.serializeString(obj, "sellerName", ensName);
        vm.serializeBytes32(obj, "sellerNode", node);
        vm.serializeUint(obj, "sellerTokenId", tokenId);
        vm.serializeAddress(obj, "erc8004IdentityRegistry", cfg.agentRegistry);
        string memory out = vm.serializeUint(obj, "erc8004AgentId", cfg.agentId);

        string memory path = string.concat(vm.projectRoot(), "/", TURNSTILE_ADDRESSES_PATH);
        vm.writeJson(out, path);
        console2.log("wrote              ", path);
    }
}
