// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IBalancerVault} from "./interfaces/IBalancerVault.sol";
import {IUniswapV3Router} from "./interfaces/IUniswapV3Router.sol";
import {IUniswapV2Router} from "./interfaces/IUniswapV2Router.sol";

/// @title FlashArb
/// @notice Educational flash-loan arbitrage executor funded ONLY by zero-interest flash loans from the Balancer V2
///         Vault. Borrows one token, runs a list of swaps across DEX routers, repays the loan (plus whatever fee the
///         Vault charges, zero at the time of writing), and reverts the whole transaction unless the trade itself
///         made at least `minProfit`.
/// @dev NOT security-audited. Educational / portfolio use only.
contract FlashArb is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum DexType {
        UNISWAP_V3, // router implements exactInputSingle (original SwapRouter)
        UNISWAP_V2 // router implements swapExactTokensForTokens (SushiSwap, etc.)
    }

    /// @param dex       Which router ABI to use.
    /// @param router    Router address. Must be allow-listed by the owner.
    /// @param tokenOut  Token received from this step. tokenIn is the previous step's tokenOut.
    /// @param fee       Uniswap V3 pool fee tier (ignored for V2 routers).
    struct SwapStep {
        DexType dex;
        address router;
        address tokenOut;
        uint24 fee;
    }

    /// @notice Balancer V2 Vault: the lender, and the only address allowed to call `receiveFlashLoan`.
    address public immutable VAULT;

    mapping(address => bool) public allowedRouters;

    /// @dev Hash of the loan this contract itself just requested; 0 when no loan is in flight.
    ///      Balancer does not report who initiated a loan, so this is how foreign loans are rejected.
    bytes32 private _pendingLoan;

    event RouterAllowed(address indexed router, bool allowed);
    event ArbExecuted(address indexed asset, uint256 amountBorrowed, uint256 fee, uint256 profit);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);

    error NotVault();
    error UnexpectedFlashLoan();
    error RouterNotAllowed(address router);
    error EmptyRoute();
    error RouteMustEndInBorrowedAsset();
    error InsufficientProfit(uint256 balanceAfter, uint256 required);
    error ZeroAddress();

    constructor(address vault_) Ownable(msg.sender) {
        if (vault_ == address(0)) revert ZeroAddress();
        VAULT = vault_;
    }

    // ---------------------------------------------------------------- owner controls

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function setRouterAllowed(address router, bool allowed) external onlyOwner {
        if (router == address(0)) revert ZeroAddress();
        allowedRouters[router] = allowed;
        emit RouterAllowed(router, allowed);
    }

    /// @notice Owner-only: pull tokens (profits or stuck funds) out of the contract.
    function withdraw(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
        emit Withdrawn(token, to, amount);
    }

    // ---------------------------------------------------------------- entry point

    /// @notice Start an arbitrage funded by a Balancer V2 flash loan. Owner only, blocked while paused.
    /// @param asset      Token to borrow (and the token the route must end in).
    /// @param amount     Amount to borrow.
    /// @param steps      Swap route.
    /// @param minProfit  Minimum profit of THIS trade, in `asset` units, after any loan fee, or the tx reverts.
    function execute(address asset, uint256 amount, SwapStep[] calldata steps, uint256 minProfit)
        external
        onlyOwner
        whenNotPaused
        nonReentrant
    {
        if (steps.length == 0) revert EmptyRoute();
        if (steps[steps.length - 1].tokenOut != asset) revert RouteMustEndInBorrowedAsset();
        for (uint256 i = 0; i < steps.length; i++) {
            if (!allowedRouters[steps[i].router]) revert RouterNotAllowed(steps[i].router);
        }

        uint256 balanceBefore = IERC20(asset).balanceOf(address(this));
        bytes memory userData = abi.encode(steps, minProfit, balanceBefore);
        address[] memory tokens = new address[](1);
        tokens[0] = asset;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount;

        _pendingLoan = keccak256(abi.encode(asset, amount, userData));
        IBalancerVault(VAULT).flashLoan(address(this), tokens, amounts, userData);
        _pendingLoan = bytes32(0);
    }

    // ---------------------------------------------------------------- flash-loan callback

    /// @notice Balancer V2 callback. Only the Vault may call it, and only for the exact loan this contract requested.
    function receiveFlashLoan(
        address[] calldata tokens,
        uint256[] calldata amounts,
        uint256[] calldata feeAmounts,
        bytes calldata userData
    ) external {
        if (msg.sender != VAULT) revert NotVault();
        if (tokens.length != 1 || amounts.length != 1 || feeAmounts.length != 1) revert UnexpectedFlashLoan();
        bytes32 expected = _pendingLoan;
        if (expected == bytes32(0) || keccak256(abi.encode(tokens[0], amounts[0], userData)) != expected) {
            revert UnexpectedFlashLoan();
        }

        address asset = tokens[0];
        uint256 amount = amounts[0];
        uint256 fee = feeAmounts[0];
        (SwapStep[] memory steps, uint256 minProfit, uint256 balanceBefore) =
            abi.decode(userData, (SwapStep[], uint256, uint256));

        address currentToken = asset;
        uint256 currentAmount = amount;
        for (uint256 i = 0; i < steps.length; i++) {
            currentAmount = _swap(steps[i], currentToken, currentAmount);
            currentToken = steps[i].tokenOut;
        }

        // Measured against the balance BEFORE the loan, so old un-withdrawn profits can never hide a losing trade.
        uint256 required = balanceBefore + amount + fee + minProfit;
        uint256 balanceAfter = IERC20(asset).balanceOf(address(this));
        if (balanceAfter < required) revert InsufficientProfit(balanceAfter, required);

        IERC20(asset).safeTransfer(VAULT, amount + fee); // Balancer expects the repayment by transfer
        emit ArbExecuted(asset, amount, fee, balanceAfter - balanceBefore - amount - fee);
    }

    // ---------------------------------------------------------------- internals

    function _swap(SwapStep memory s, address tokenIn, uint256 amountIn) internal returns (uint256 amountOut) {
        IERC20(tokenIn).forceApprove(s.router, amountIn);
        // amountOutMin is 0 on purpose: the single end-to-end minProfit check protects the whole route.
        if (s.dex == DexType.UNISWAP_V3) {
            amountOut = IUniswapV3Router(s.router).exactInputSingle(
                IUniswapV3Router.ExactInputSingleParams({
                    tokenIn: tokenIn,
                    tokenOut: s.tokenOut,
                    fee: s.fee,
                    recipient: address(this),
                    deadline: block.timestamp,
                    amountIn: amountIn,
                    amountOutMinimum: 0,
                    sqrtPriceLimitX96: 0
                })
            );
        } else {
            address[] memory path = new address[](2);
            path[0] = tokenIn;
            path[1] = s.tokenOut;
            uint256[] memory amounts = IUniswapV2Router(s.router).swapExactTokensForTokens(
                amountIn, 0, path, address(this), block.timestamp
            );
            amountOut = amounts[amounts.length - 1];
        }
    }
}
