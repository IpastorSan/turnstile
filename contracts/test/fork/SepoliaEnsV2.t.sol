// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console2} from "forge-std/Test.sol";

import {IVerifiableFactory} from "@ensdomains/verifiable-factory/IVerifiableFactory.sol";

import {IPermissionedRegistry} from "@ens/v2/registry/interfaces/IPermissionedRegistry.sol";
import {IRegistry} from "@ens/v2/registry/interfaces/IRegistry.sol";
import {RegistryRolesLib} from "@ens/v2/registry/libraries/RegistryRolesLib.sol";
import {LibLabel} from "@ens/v2/utils/LibLabel.sol";

import {EnsSepolia} from "../../script/EnsSepolia.sol";
import {TurnstileRegistrar} from "../../src/TurnstileRegistrar.sol";
import {TurnstileRegistry} from "../../src/TurnstileRegistry.sol";

/// @title SepoliaEnsV2Test
/// @notice Fork tests against the live ENSv2 Sepolia deployment.
///
/// Read-only forking needs no API key, so these run with no environment set;
/// `SEPOLIA_RPC_URL` overrides the endpoint if you have a better one.
///
/// The first test is the **redeploy canary** and is the reason this file exists.
/// ENS's `phase deploy-v2` archives and redeploys by default, and has already
/// done it once — the May 2026 namespace is orphaned and every address in it
/// differs from the June 2026 one. If `testFork_ethIsStillTheKnownEthRegistry`
/// fails, `addresses.sepolia.json` is stale and so is everything built on it.
contract SepoliaEnsV2Test is Test {
    /// @dev The `.eth` registry as of the deployment MOV-212 verified
    ///      (deployedAt 2026-06-29). Hard-coded on purpose: this is the one place
    ///      a literal belongs, because the test's job is to detect the file
    ///      changing out from under us as well as the chain doing so.
    address internal constant KNOWN_ETH_REGISTRY = 0x67b728a792e789a8978b30cF1b3b641f19354b43;
    address internal constant KNOWN_ROOT_REGISTRY = 0x11b5BfbE9078D826b1eDBDd1cFC12f5828D9F50C;

    uint64 internal constant YEAR = 365 days;

    bool internal forked;
    string internal json;

    address internal rootRegistry;
    address internal ethRegistry;
    address internal verifiableFactory;
    address internal userRegistryImpl;

    address internal operator = makeAddr("operator");
    address internal payout = makeAddr("payout");
    address internal buyer = makeAddr("buyer");

    function setUp() public {
        json = EnsSepolia.load();
        rootRegistry = EnsSepolia.lookup(json, "RootRegistry");
        ethRegistry = EnsSepolia.lookup(json, "ETHRegistry");
        verifiableFactory = EnsSepolia.lookup(json, "VerifiableFactory");
        userRegistryImpl = EnsSepolia.lookup(json, "UserRegistryImpl");

        // Skip rather than fail when the endpoint is unreachable, so a network-less
        // CI run does not look like a failed canary. A skipped canary is reported
        // as skipped; it is never reported as green.
        try this.selectFork() {
            forked = true;
        } catch {
            forked = false;
            console2.log("SKIPPING fork tests: could not reach", EnsSepolia.rpcUrl());
        }
    }

    /// @dev External so `setUp` can try/catch it.
    function selectFork() external {
        vm.createSelectFork(EnsSepolia.rpcUrl());
    }

    modifier onlyForked() {
        if (!forked) {
            vm.skip(true);
        }
        _;
    }

    ////////////////////////////////////////////////////////////////////////
    // The redeploy canary
    ////////////////////////////////////////////////////////////////////////

    /// @notice `RootRegistry.getSubregistry("eth")` must still return the
    ///         `ETHRegistry` we recorded.
    ///
    /// This single call proves both addresses at once and proves the root/`.eth`
    /// link is live, which no amount of `eth_getCode` can. If it fails, ENS has
    /// redeployed: regenerate `addresses.sepolia.json` from
    /// `contracts/deployments/sepolia/` at the new revision and re-check every
    /// issue that consumed it.
    function testFork_ethIsStillTheKnownEthRegistry() public onlyForked {
        assertEq(ethRegistry, KNOWN_ETH_REGISTRY, "addresses.sepolia.json was edited");
        assertEq(rootRegistry, KNOWN_ROOT_REGISTRY, "addresses.sepolia.json was edited");

        address live = address(IRegistry(rootRegistry).getSubregistry("eth"));
        assertEq(live, KNOWN_ETH_REGISTRY, "ENS REDEPLOYED - every recorded address is stale");
    }

    /// @notice Every address we actually build on still has code.
    function testFork_recordedAddressesStillHaveCode() public onlyForked {
        assertGt(rootRegistry.code.length, 0, "RootRegistry");
        assertGt(ethRegistry.code.length, 0, "ETHRegistry");
        assertGt(verifiableFactory.code.length, 0, "VerifiableFactory");
        assertGt(userRegistryImpl.code.length, 0, "UserRegistryImpl");
        assertGt(EnsSepolia.lookup(json, "LabelStore").code.length, 0, "LabelStore");
    }

    ////////////////////////////////////////////////////////////////////////
    // The factory
    ////////////////////////////////////////////////////////////////////////

    /// @notice `verifyContract` returns the implementation **address**, not a bool.
    ///
    /// MOV-212's notes record it as `returns (bool)`. The deployed ABI and the
    /// verifiable-factory source both say `returns (address implementation)`, and
    /// so does this call against the live contract. Harmless — the selector is
    /// unchanged, so nothing MOV-212 verified is affected — but the note is wrong
    /// and anyone coding against it from memory would get a garbage bool.
    function testFork_verifyContractReturnsAnImplementationAddress() public onlyForked {
        address proxy = _deployRegistry(uint256(keccak256("verify-shape")));
        address implementation = IVerifiableFactory(verifiableFactory).verifyContract(proxy);
        assertEq(implementation, userRegistryImpl, "returns the implementation address");
    }

    /// @notice The CREATE2 pre-computation matches what the **live** factory
    ///         produces, not just what our locally compiled copy produces.
    function testFork_predictAddressMatchesTheLiveFactory() public onlyForked {
        uint256 salt = uint256(keccak256("predict-on-fork"));

        (bool ok, bytes memory ret) =
            verifiableFactory.staticcall(abi.encodeWithSignature("proxyLogic()"));
        assertTrue(ok, "proxyLogic()");
        address proxyLogic = abi.decode(ret, (address));

        address predicted = TurnstileRegistry.predictAddress(
            verifiableFactory,
            proxyLogic,
            operator,
            salt
        );
        assertEq(_deployRegistry(salt), predicted, "predicted == deployed");
    }

    ////////////////////////////////////////////////////////////////////////
    // The full flow, against live contracts
    ////////////////////////////////////////////////////////////////////////

    /// @notice Deploy the registry and registrar exactly as `Deploy.s.sol` does,
    ///         and sell a subname — against the live factory, the live
    ///         `UserRegistry` implementation and the live `LabelStore`.
    ///
    /// The local suite proves the same flow against contracts we compiled
    /// ourselves. This proves it against the bytecode that is actually on Sepolia,
    /// which is the only thing that answers "will the deploy script work".
    function testFork_fullMintFlowAgainstLiveContracts() public onlyForked {
        IPermissionedRegistry registry =
            IPermissionedRegistry(_deployRegistry(uint256(keccak256("turnstile.v1"))));

        assertTrue(
            registry.hasRootRoles(RegistryRolesLib.ROLE_REGISTRAR, operator),
            "initialize granted the operator its root roles"
        );

        uint256[5] memory tiers;
        TurnstileRegistrar registrar = new TurnstileRegistrar(
            registry,
            operator,
            payout,
            address(0),
            tiers,
            0.001 ether / uint256(YEAR)
        );

        vm.prank(operator);
        registry.grantRootRoles(TurnstileRegistry.REGISTRAR_ROOT_ROLES, address(registrar));

        uint256 price = registrar.rentPrice("alice", YEAR);
        vm.deal(buyer, price);
        vm.prank(buyer);
        uint256 tokenId = registrar.register{value: price}("alice", buyer, YEAR);

        assertEq(registry.getOwner(LibLabel.id("alice")), buyer);
        assertEq(registry.ownerOf(tokenId), buyer);

        // The live LabelStore recorded the label — PermissionedRegistry.register
        // calls into it on every mint, so a mismatch there would break minting.
        address labelStore = EnsSepolia.lookup(json, "LabelStore");
        (bool ok, bytes memory ret) = labelStore.staticcall(
            abi.encodeWithSignature("getLabel(uint256)", LibLabel.id("alice"))
        );
        assertTrue(ok, "getLabel");
        assertEq(abi.decode(ret, (string)), "alice", "live LabelStore round-trips the label");
    }

    ////////////////////////////////////////////////////////////////////////
    // The known blocker
    ////////////////////////////////////////////////////////////////////////

    /// @notice We cannot mint `turnstile.eth` by calling `ETHRegistry.register`.
    ///
    /// MOV-212 flagged this as unverified. Asserting it here turns it from a note
    /// into a fact: `PermissionedRegistry.register` needs `ROLE_REGISTRAR` at root
    /// and no address of ours holds it on the `.eth` registry. The parent name has
    /// to come from the paid `ETHRegistrar` commit/reveal flow, which needs a
    /// funded key — MOV-211.
    function testFork_weHoldNoRegistrarRoleOnTheEthRegistry() public onlyForked {
        IPermissionedRegistry eth = IPermissionedRegistry(ethRegistry);
        assertFalse(
            eth.hasRootRoles(RegistryRolesLib.ROLE_REGISTRAR, operator),
            "we do not get to mint under .eth for free"
        );

        // Whether the label is even free is worth knowing before MOV-211 lands.
        uint256 labelId = LibLabel.id("turnstile");
        console2.log("turnstile.eth status (0=AVAILABLE 1=RESERVED 2=REGISTERED):");
        console2.log(uint256(uint8(eth.getStatus(labelId))));
        console2.log("turnstile.eth owner:", eth.getOwner(labelId));
    }

    ////////////////////////////////////////////////////////////////////////
    // Helpers
    ////////////////////////////////////////////////////////////////////////

    function _deployRegistry(uint256 salt) internal returns (address) {
        vm.prank(operator);
        return
            address(
                TurnstileRegistry.deploy(
                    IVerifiableFactory(verifiableFactory),
                    userRegistryImpl,
                    salt,
                    operator,
                    TurnstileRegistry.OPERATOR_ROOT_ROLES
                )
            );
    }
}
