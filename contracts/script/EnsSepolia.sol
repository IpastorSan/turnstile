// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Vm} from "forge-std/Vm.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice Loads ENSv2's Sepolia addresses out of `addresses.sepolia.json`.
///
/// That file is MOV-212's output: every address in it was checked against Sepolia
/// by comparing `eth_getCode` byte-for-byte with the deployment artifact from
/// ensdomains/contracts-v2 rev 48b3e2d, with all differences falling inside
/// declared immutable slots. Nothing here re-derives addresses or trusts a
/// documentation page — the two places a wrong ENSv2 address has come from so far.
///
/// Reading them at run time rather than hard-coding them in Solidity is also what
/// CHECKLIST.md's "no hard-coded values" gate asks for: when ENS redeploys, the
/// fix is to regenerate one JSON file, not to recompile.
///
/// @dev ENS's `phase deploy-v2` archives and redeploys by default, and has already
///      done so once (May to June 2026). A redeploy changes every address in this
///      file. `SepoliaCanaryTest` is what tells us it happened.
library EnsSepolia {
    using stdJson for string;

    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @dev Relative to the Foundry project root, i.e. `contracts/`.
    string internal constant ADDRESSES_PATH = "addresses.sepolia.json";

    /// @dev Upper bound on the scan. The file has 31 entries; this only has to
    ///      terminate a loop over a file we control.
    uint256 private constant MAX_ENTRIES = 256;

    /// @notice The public Sepolia endpoint MOV-212 verified against. Read-only
    ///         forking needs no API key, so tests work with no environment set.
    string internal constant DEFAULT_RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";

    /// @notice Raised when a contract name is not in the addresses file.
    error UnknownContract(string name);

    /// @notice The whole addresses file, as JSON text.
    function load() internal view returns (string memory) {
        return VM.readFile(string.concat(VM.projectRoot(), "/", ADDRESSES_PATH));
    }

    /// @notice The Sepolia RPC URL: `SEPOLIA_RPC_URL` if set and non-empty,
    ///         otherwise the public endpoint.
    function rpcUrl() internal view returns (string memory url) {
        url = VM.envOr("SEPOLIA_RPC_URL", string(""));
        if (bytes(url).length == 0) {
            url = DEFAULT_RPC_URL;
        }
    }

    /// @notice Look a deployment up by its artifact name, e.g. `ETHRegistry`.
    ///
    /// @dev The file keys on the *artifact* name, which is not always the Solidity
    ///      contract name — `RootRegistry` and `ETHRegistry` are both instances of
    ///      `PermissionedRegistry`, deployed twice.
    ///
    ///      Scanned by index rather than with a `.contracts[*].name` projection:
    ///      Foundry's JSON path support rejects a wildcard that yields more than
    ///      one value ("must return exactly one JSON value"). Decoding the array
    ///      into a struct is not an option either — entries carry different key
    ///      sets, since only the contracts MOV-212 cross-checked have a
    ///      `crossCheck` field, and stdJson's struct decoding needs them uniform.
    function lookup(string memory json, string memory name) internal view returns (address) {
        bytes32 wanted = keccak256(bytes(name));
        for (uint256 i; i < MAX_ENTRIES; ++i) {
            string memory entry = string.concat(".contracts[", VM.toString(i), "]");
            string memory nameKey = string.concat(entry, ".name");
            if (!VM.keyExistsJson(json, nameKey)) {
                break; // past the end of the array
            }
            if (keccak256(bytes(json.readString(nameKey))) == wanted) {
                return json.readAddress(string.concat(entry, ".address"));
            }
        }
        revert UnknownContract(name);
    }

    /// @notice Convenience: load the file and look one name up.
    function get(string memory name) internal view returns (address) {
        return lookup(load(), name);
    }
}
