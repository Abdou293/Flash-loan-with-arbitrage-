// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal slice of the Aave V3 Pool interface that this project needs.
interface IAavePool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}
