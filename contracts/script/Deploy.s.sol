// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";

import {IVerifiableFactory} from "@ensdomains/verifiable-factory/IVerifiableFactory.sol";

import {IPermissionedRegistry} from "@ens/v2/registry/interfaces/IPermissionedRegistry.sol";
import {IRegistry} from "@ens/v2/registry/interfaces/IRegistry.sol";
import {LibLabel} from "@ens/v2/utils/LibLabel.sol";

import {TurnstileRegistrar} from "../src/TurnstileRegistrar.sol";
import {TurnstileRegistry} from "../src/TurnstileRegistry.sol";

import {EnsSepolia} from "./EnsSepolia.sol";

/// @title Deploy
/// @notice Deploys the Turnstile registry and registrar to Sepolia and links them
///         into the ENSv2 hierarchy.
///
/// Idempotent by construction. Both contracts land at CREATE2 addresses derived
/// from `TURNSTILE_SALT`, every wiring step is guarded by a check of the state it
/// would establish, and the ENS addresses come from `addresses.sepolia.json`
/// rather than from literals here. Re-running after a partial failure resumes;
/// re-running after a complete one is a no-op that re-writes the output file.
///
/// ```bash
/// forge script script/Deploy.s.sol:Deploy \
///   --rpc-url "$SEPOLIA_RPC_URL" --broadcast --verify
/// ```
///
/// Environment:
///
/// | Variable                      | Required | Default                        |
/// |-------------------------------|----------|--------------------------------|
/// | `DEPLOYER_PRIVATE_KEY`        | yes      | —                              |
/// | `TURNSTILE_PARENT_LABEL`      | no       | `turnstile`                    |
/// | `TURNSTILE_SALT`              | no       | derived from the parent label  |
/// | `TURNSTILE_PAYMENT_RECEIVER`  | no       | the deployer                   |
/// | `TURNSTILE_RESOLVER`          | no       | none                           |
/// | `TURNSTILE_PRICE_LEN3_WEI`    | no       | 0.01 ETH / year                |
/// | `TURNSTILE_PRICE_LEN4_WEI`    | no       | 0.005 ETH / year               |
/// | `TURNSTILE_PRICE_BASE_WEI`    | no       | 0.001 ETH / year               |
///
/// The price variables are quoted **per year**; the registrar stores wei per
/// second, and the conversion happens here.
contract Deploy is Script {
    /// @dev The canonical CREATE2 factory, present on every chain Foundry targets.
    ///      `new X{salt: ...}` in a broadcast goes through it.
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    uint64 internal constant YEAR = 365 days;

    struct Config {
        address deployer;
        string parentLabel;
        uint256 salt;
        address paymentReceiver;
        address resolver;
        uint256[5] tierPriceWeiPerSecond;
        uint256 basePriceWeiPerSecond;
    }

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        Config memory cfg = _config(vm.addr(deployerKey));

        string memory json = EnsSepolia.load();
        address factory = EnsSepolia.lookup(json, "VerifiableFactory");
        address userRegistryImpl = EnsSepolia.lookup(json, "UserRegistryImpl");
        address ethRegistry = EnsSepolia.lookup(json, "ETHRegistry");

        console2.log("deployer          ", cfg.deployer);
        console2.log("parent label      ", cfg.parentLabel);
        console2.log("VerifiableFactory ", factory);
        console2.log("UserRegistryImpl  ", userRegistryImpl);
        console2.log("ETHRegistry       ", ethRegistry);

        vm.startBroadcast(deployerKey);

        IPermissionedRegistry registry =
            _deployRegistry(cfg, IVerifiableFactory(factory), userRegistryImpl);
        TurnstileRegistrar registrar = _deployRegistrar(cfg, registry);

        _grantRegistrarRoles(registry, registrar);
        _linkIntoHierarchy(cfg, registry, IPermissionedRegistry(ethRegistry));

        vm.stopBroadcast();

        _writeAddresses(cfg, registry, registrar, factory, userRegistryImpl, ethRegistry);
    }

    ////////////////////////////////////////////////////////////////////////
    // Steps
    ////////////////////////////////////////////////////////////////////////

    /// @dev The registry is a `UserRegistry` proxy from the canonical factory, so
    ///      `VerifiableFactory.verifyContract` recognises it. Its address is
    ///      pre-computable, which is what makes the re-run check possible: the
    ///      factory's CREATE2 would revert on a second deploy at the same salt.
    function _deployRegistry(
        Config memory cfg,
        IVerifiableFactory factory,
        address userRegistryImpl
    )
        internal
        returns (IPermissionedRegistry registry)
    {
        (bool ok, bytes memory ret) =
            address(factory).staticcall(abi.encodeWithSignature("proxyLogic()"));
        require(ok, "VerifiableFactory.proxyLogic() failed - wrong address?");
        address proxyLogic = abi.decode(ret, (address));

        address predicted = TurnstileRegistry.predictAddress(
            address(factory),
            proxyLogic,
            cfg.deployer,
            cfg.salt
        );

        if (predicted.code.length > 0) {
            console2.log("registry          ", predicted, "(already deployed)");
            return IPermissionedRegistry(predicted);
        }

        registry = TurnstileRegistry.deploy(
            factory,
            userRegistryImpl,
            cfg.salt,
            cfg.deployer,
            TurnstileRegistry.OPERATOR_ROOT_ROLES
        );
        require(address(registry) == predicted, "predicted registry address was wrong");
        console2.log("registry          ", address(registry), "(deployed)");
    }

    /// @dev CREATE2 so a re-run finds the same registrar instead of orphaning the
    ///      previous one with root roles still granted to it.
    function _deployRegistrar(Config memory cfg, IPermissionedRegistry registry)
        internal
        returns (TurnstileRegistrar registrar)
    {
        bytes memory initCode = abi.encodePacked(
            type(TurnstileRegistrar).creationCode,
            abi.encode(
                registry,
                cfg.deployer,
                cfg.paymentReceiver,
                cfg.resolver,
                cfg.tierPriceWeiPerSecond,
                cfg.basePriceWeiPerSecond
            )
        );
        bytes32 salt = bytes32(cfg.salt);
        address predicted =
            vm.computeCreate2Address(salt, keccak256(initCode), CREATE2_DEPLOYER);

        if (predicted.code.length > 0) {
            console2.log("registrar         ", predicted, "(already deployed)");
            return TurnstileRegistrar(payable(predicted));
        }

        registrar = new TurnstileRegistrar{salt: salt}(
            registry,
            cfg.deployer,
            cfg.paymentReceiver,
            cfg.resolver,
            cfg.tierPriceWeiPerSecond,
            cfg.basePriceWeiPerSecond
        );
        require(address(registrar) == predicted, "predicted registrar address was wrong");
        console2.log("registrar         ", address(registrar), "(deployed)");
    }

    /// @dev `grantRootRoles`, never `grantRoles(ROOT_RESOURCE, ...)`. The latter
    ///      reverts with `EACRootResourceNotAllowed()`, and on a
    ///      `PermissionedRegistry` its first argument is a token id anyway. See
    ///      `test/Roles.t.sol`, which exists to keep this from being "simplified".
    function _grantRegistrarRoles(IPermissionedRegistry registry, TurnstileRegistrar registrar)
        internal
    {
        if (
            registry.hasRootRoles(TurnstileRegistry.REGISTRAR_ROOT_ROLES, address(registrar))
        ) {
            console2.log("roles              already granted");
            return;
        }
        registry.grantRootRoles(TurnstileRegistry.REGISTRAR_ROOT_ROLES, address(registrar));
        console2.log("roles              granted to the registrar");
    }

    /// @dev Two independent links, guarded separately.
    ///
    ///      `registry.setParent` is the back-pointer and needs only our own root
    ///      role, so it always runs.
    ///
    ///      `ethRegistry.setSubregistry` is the one that makes resolution descend
    ///      into us, and it needs `ROLE_SET_SUBREGISTRY` on the parent's token —
    ///      i.e. we must already own the parent name. Until MOV-211 funds a key
    ///      and the name is bought through the paid ETHRegistrar commit/reveal
    ///      flow, this step is skipped with a loud note rather than reverting the
    ///      whole deployment.
    function _linkIntoHierarchy(
        Config memory cfg,
        IPermissionedRegistry registry,
        IPermissionedRegistry ethRegistry
    )
        internal
    {
        (IRegistry currentParent, string memory currentLabel) = registry.getParent();
        if (
            address(currentParent) != address(ethRegistry) ||
            keccak256(bytes(currentLabel)) != keccak256(bytes(cfg.parentLabel))
        ) {
            registry.setParent(IRegistry(address(ethRegistry)), cfg.parentLabel);
            console2.log("parent             set");
        } else {
            console2.log("parent             already set");
        }

        uint256 parentTokenId = ethRegistry.getTokenId(LibLabel.id(cfg.parentLabel));
        address parentOwner = ethRegistry.getOwner(LibLabel.id(cfg.parentLabel));

        if (address(ethRegistry.getSubregistry(cfg.parentLabel)) == address(registry)) {
            console2.log("subregistry        already linked");
            return;
        }
        if (parentOwner != cfg.deployer) {
            console2.log("subregistry        SKIPPED - we do not own the parent name");
            console2.log("  parent label     ", cfg.parentLabel);
            console2.log("  parent owner     ", parentOwner);
            console2.log("  buy it through ETHRegistrar (commit/reveal), then re-run this script");
            return;
        }
        ethRegistry.setSubregistry(parentTokenId, IRegistry(address(registry)));
        console2.log("subregistry        linked");
    }

    ////////////////////////////////////////////////////////////////////////
    // Config and output
    ////////////////////////////////////////////////////////////////////////

    function _config(address deployer) internal view returns (Config memory cfg) {
        cfg.deployer = deployer;
        cfg.parentLabel = vm.envOr("TURNSTILE_PARENT_LABEL", string("turnstile"));
        cfg.salt = vm.envOr(
            "TURNSTILE_SALT",
            uint256(keccak256(bytes(string.concat("turnstile:", cfg.parentLabel))))
        );
        cfg.paymentReceiver = vm.envOr("TURNSTILE_PAYMENT_RECEIVER", deployer);
        cfg.resolver = vm.envOr("TURNSTILE_RESOLVER", address(0));

        // Quoted per year in the environment, stored per second on-chain.
        cfg.tierPriceWeiPerSecond[3] =
            vm.envOr("TURNSTILE_PRICE_LEN3_WEI", uint256(0.01 ether)) / YEAR;
        cfg.tierPriceWeiPerSecond[4] =
            vm.envOr("TURNSTILE_PRICE_LEN4_WEI", uint256(0.005 ether)) / YEAR;
        cfg.basePriceWeiPerSecond =
            vm.envOr("TURNSTILE_PRICE_BASE_WEI", uint256(0.001 ether)) / YEAR;
    }

    /// @dev Written to its own file. `addresses.sepolia.json` is MOV-212's
    ///      verified record of ENS's deployment and is not ours to append to.
    function _writeAddresses(
        Config memory cfg,
        IPermissionedRegistry registry,
        TurnstileRegistrar registrar,
        address factory,
        address userRegistryImpl,
        address ethRegistry
    )
        internal
    {
        string memory obj = "turnstile";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeString(obj, "parentLabel", cfg.parentLabel);
        vm.serializeUint(obj, "salt", cfg.salt);
        vm.serializeAddress(obj, "deployer", cfg.deployer);
        vm.serializeAddress(obj, "paymentReceiver", cfg.paymentReceiver);
        vm.serializeAddress(obj, "resolver", cfg.resolver);
        vm.serializeAddress(obj, "ensVerifiableFactory", factory);
        vm.serializeAddress(obj, "ensUserRegistryImpl", userRegistryImpl);
        vm.serializeAddress(obj, "ensEthRegistry", ethRegistry);
        vm.serializeAddress(obj, "turnstileRegistry", address(registry));
        vm.serializeBool(
            obj,
            "linkedIntoHierarchy",
            address(IPermissionedRegistry(ethRegistry).getSubregistry(cfg.parentLabel)) ==
                address(registry)
        );
        string memory out = vm.serializeAddress(obj, "turnstileRegistrar", address(registrar));

        string memory path =
            string.concat(vm.projectRoot(), "/addresses.turnstile.sepolia.json");
        vm.writeJson(out, path);
        console2.log("wrote              ", path);
    }
}
