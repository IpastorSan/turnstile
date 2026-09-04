// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ILabelStore} from "@ens/v2/utils/interfaces/ILabelStore.sol";
import {LibLabel} from "@ens/v2/utils/LibLabel.sol";

/// @notice Stand-in for ENS's shared `LabelStore` in local tests.
///
/// `PermissionedRegistry.register` calls `LABEL_STORE.setLabel(label)` on every
/// registration, so the local stack needs something at that address. The real
/// `LabelStore` additionally pulls in `NameCoder` and `DelegatedContractNamer`
/// from ens-contracts; none of that affects registration, so the local tests use
/// this and the fork tests use the real deployment at
/// 0xb03524289c16424f71802a1794c29c7bd1b9f577.
contract MockLabelStore is ILabelStore {
    mapping(uint256 truncatedLabelHash => string label) private _labels;

    /// @inheritdoc ILabelStore
    function setLabel(string calldata label) external {
        uint256 key = LibLabel.withVersion(LibLabel.id(label), 0);
        if (bytes(_labels[key]).length == 0) {
            _labels[key] = label;
            emit Label(bytes32(LibLabel.id(label)), label);
        }
    }

    /// @inheritdoc ILabelStore
    function getLabel(uint256 anyId) external view returns (string memory) {
        return _labels[LibLabel.withVersion(anyId, 0)];
    }
}
