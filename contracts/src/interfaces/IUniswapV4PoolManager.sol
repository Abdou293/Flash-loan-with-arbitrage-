// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal slice of the Uniswap V4 PoolManager used for zero-fee "flash accounting" loans.
///         `Currency` in V4 is an address-sized type (address(0) = native ETH); only ERC20s are used here.
interface IUniswapV4PoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
    function take(address currency, address to, uint256 amount) external;
    function sync(address currency) external;
    function settle() external payable returns (uint256 paid);
}

/// @notice Callback the PoolManager makes on whoever called `unlock`.
interface IUnlockCallback {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}
