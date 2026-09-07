// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";

import {IRegistry} from "@ens/v2/registry/interfaces/IRegistry.sol";

/// @title TurnstileName
/// @notice Derives a subname's full ENS name, DNS encoding and namehash by
///         walking the ENSv2 registry hierarchy, so that **no name is ever
///         hard-coded anywhere on the demo path.**
///
/// This is not a style preference. Every record we write and every role we grant
/// on a `PermissionedResolver` is keyed by namehash, and a namehash is only
/// computable from the *whole* name. The obvious implementation is a constant —
/// `"liquidity.turnstile.eth"` — and that constant is wrong the moment the
/// parent name changes, the registry is re-parented, or the same code is pointed
/// at a second seller. Worse, it is wrong *silently*: a stale namehash still
/// resolves, it just resolves to a name nobody owns.
///
/// ENSv2 already carries the answer on-chain. `IRegistry.getParent()` returns the
/// parent registry and the label this registry hangs off it under, and the chain
/// terminates at the root registry, whose parent is the zero address. So the full
/// name of `label` inside `registry` is a walk:
///
/// ```
/// TurnstileRegistry.getParent() -> (ETHRegistry,  "turnstile")
/// ETHRegistry.getParent()       -> (RootRegistry, "eth")
/// RootRegistry.getParent()      -> (address(0),   "")
/// ```
///
/// which for `label = "liquidity"` yields `liquidity.turnstile.eth`. Verified
/// against live Sepolia — all three calls above are real returns from the
/// deployed contracts, not an assumption.
library TurnstileName {
    /// @notice Longest parent chain we will walk.
    ///
    /// ENS names are at most 255 bytes and each label costs at least two, but the
    /// real reason for a bound is that `getParent` is attacker-controlled for any
    /// registry we do not own: a registry whose parent points back at itself would
    /// otherwise spin until out of gas. A bound turns that into a named revert.
    uint256 internal constant MAX_DEPTH = 8;

    /// @notice The parent chain did not terminate within `MAX_DEPTH` hops.
    error ParentChainTooDeep(uint256 maxDepth);

    /// @notice The full ENS name of `label` registered in `registry`.
    /// @dev e.g. `("liquidity", TurnstileRegistry) -> "liquidity.turnstile.eth"`.
    function ensName(IRegistry registry, string memory label)
        internal
        view
        returns (string memory name)
    {
        name = label;
        IRegistry current = registry;
        for (uint256 i; i < MAX_DEPTH; ++i) {
            (IRegistry parent, string memory parentLabel) = current.getParent();
            if (address(parent) == address(0)) {
                return name;
            }
            name = string.concat(name, ".", parentLabel);
            current = parent;
        }
        revert ParentChainTooDeep(MAX_DEPTH);
    }

    /// @notice The DNS-encoded form of `ensName`, which is what every
    ///         `PermissionedResolver.authorize*Roles` call takes.
    function dnsName(IRegistry registry, string memory label)
        internal
        view
        returns (bytes memory)
    {
        return NameCoder.encode(ensName(registry, label));
    }

    /// @notice The namehash of `ensName`, which is what every resolver record is
    ///         keyed by.
    function node(IRegistry registry, string memory label) internal view returns (bytes32) {
        return NameCoder.namehash(dnsName(registry, label), 0);
    }
}
