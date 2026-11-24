// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal Balancer V2 Vault interface (flash loans only). Tokens are passed as addresses (same ABI as IERC20).
interface IBalancerVault {
    function flashLoan(address recipient, address[] memory tokens, uint256[] memory amounts, bytes memory userData)
        external;
}
