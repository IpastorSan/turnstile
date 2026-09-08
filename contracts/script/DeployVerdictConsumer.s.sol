// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";

import {VerdictConsumer} from "../src/VerdictConsumer.sol";

/// @title DeployVerdictConsumer
/// @notice Deploys the settlement point for the CRE confidential workflow's
///         verdicts, and records the address where the premium tier reads it.
///
/// ```bash
/// forge script script/DeployVerdictConsumer.s.sol:DeployVerdictConsumer \
///   --rpc-url "$SEPOLIA_RPC_URL" --broadcast --verify
/// ```
///
/// | Variable | Required | Default |
/// |---|---|---|
/// | `DEPLOYER_PRIVATE_KEY` | yes | — |
/// | `CRE_FORWARDER` | no | the Sepolia Forwarder below |
/// | `VERDICT_SALT` | no | `keccak256("turnstile.verdict-consumer.v1")` |
///
/// CREATE2 so the address is derivable before the deploy and re-running is a
/// no-op rather than a second contract. The workflow config has to name the
/// consumer, and a redeploy that silently moved it would leave the workflow
/// writing into an address nobody reads.
///
/// The two identity gates are deliberately **not** set here. `expectedWorkflowId`
/// cannot be known until the workflow is registered — registration is what
/// produces the id — so this script deploys ungated and prints the follow-up.
/// See `verdictsAreGated()`, which exists so that follow-up not happening is
/// visible rather than silent.
contract DeployVerdictConsumer is Script {
    /// @dev The canonical CREATE2 factory. `new X{salt: ...}` routes through it.
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    /// @dev The CRE Forwarder on Sepolia, read from `~/.cre/context.yaml`
    ///      (chain selector 16015286601757825753) on 2026-09-07. Overridable,
    ///      because a Forwarder address is exactly the kind of thing that moves.
    address internal constant SEPOLIA_FORWARDER = 0xF8344CFd5c43616a4366C34E3EEE75af79a74482;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address forwarder = vm.envOr("CRE_FORWARDER", SEPOLIA_FORWARDER);
        bytes32 salt = bytes32(vm.envOr("VERDICT_SALT", uint256(keccak256("turnstile.verdict-consumer.v1"))));

        // The owner is passed explicitly: under CREATE2 the constructor's
        // `msg.sender` is the factory, so `owner = msg.sender` would lock the
        // identity gates behind an address nobody controls.
        address deployer = vm.addr(deployerKey);
        address predicted = vm.computeCreate2Address(
            salt,
            keccak256(
                abi.encodePacked(type(VerdictConsumer).creationCode, abi.encode(forwarder, deployer))
            ),
            CREATE2_DEPLOYER
        );

        vm.startBroadcast(deployerKey);

        VerdictConsumer consumer;
        if (predicted.code.length > 0) {
            console2.log("VerdictConsumer already at", predicted);
            consumer = VerdictConsumer(predicted);
        } else {
            consumer = new VerdictConsumer{salt: salt}(forwarder, deployer);
            require(address(consumer) == predicted, "CREATE2 address mismatch");
            console2.log("VerdictConsumer deployed at", address(consumer));
        }

        vm.stopBroadcast();

        console2.log("forwarder      ", consumer.forwarder());
        console2.log("owner          ", consumer.owner());
        console2.log("gated          ", consumer.verdictsAreGated());
        console2.log("");
        console2.log("Next, once `cre workflow deploy` has produced a workflow id:");
        console2.log("  consumer.setExpectedAuthor(<workflow owner>)");
        console2.log("  consumer.setExpectedWorkflowId(<workflow id>)");
        console2.log("Until then this consumer accepts any report the Forwarder delivers.");

        string memory out = string.concat(
            '{\n  "chainId": ',
            vm.toString(block.chainid),
            ',\n  "verdictConsumer": "',
            vm.toString(address(consumer)),
            '",\n  "creForwarder": "',
            vm.toString(forwarder),
            '",\n  "salt": "',
            vm.toString(uint256(salt)),
            '"\n}\n'
        );
        // The rehearsal deployment (CRE_FORWARDER set to the seller's own key)
        // must not clobber the production record — they are different contracts
        // with different trust properties and conflating them in one file is
        // exactly how the wrong address ends up in the workflow config.
        vm.writeFile(vm.envOr("VERDICT_ADDRESSES_FILE", string("addresses.verdict.sepolia.json")), out);
    }
}
