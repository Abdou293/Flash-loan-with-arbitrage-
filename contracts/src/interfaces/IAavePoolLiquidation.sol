// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice The one Aave V3 Pool function the liquidator calls. Aave pulls `debtToCover` of `debtAsset` from the caller
///         (needs an allowance) and sends the caller the collateral plus the liquidation bonus (minus Aave's protocol
///         fee on the bonus). It reverts if the borrower's health factor is not below 1, and it liquidates less than
///         `debtToCover` when the close factor allows less (the unspent debt tokens stay with the caller).
interface IAavePoolLiquidation {
    function liquidationCall(
        address collateralAsset,
        address debtAsset,
        address user,
        uint256 debtToCover,
        bool receiveAToken
    ) external;
}
