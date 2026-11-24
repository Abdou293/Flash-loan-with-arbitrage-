// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IBalancerVault} from "./interfaces/IBalancerVault.sol";
import {IUniswapV4PoolManager} from "./interfaces/IUniswapV4PoolManager.sol";
import {IUniswapV3Router} from "./interfaces/IUniswapV3Router.sol";
import {IUniswapV2Router} from "./interfaces/IUniswapV2Router.sol";

/// @title FlashArb
/// @notice Educational flash-loan arbitrage executor funded ONLY by zero-interest flash loans, from either the
///         Balancer V2 Vault or the Uniswap V4 PoolManager ("flash accounting"). Borrows one token, runs a list of
///         swaps across DEX routers, repays the loan (plus any fee the lender charges; zero for both when checked),
///         and reverts the whole transaction unless the trade itself made at least `minProfit`.
/// @dev NOT security-audited. Educational / portfolio use only.
contract FlashArb is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum DexType {
        UNISWAP_V3, // router implements exactInputSingle (original SwapRouter)
        UNISWAP_V2 // router implements swapExactTokensForTokens (SushiSwap, etc.)
    }

    /// @notice Which zero-interest lender funds the trade.
    enum Lender {
        BALANCER_V2,
        UNISWAP_V4
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

    /// @notice Balancer V2 Vault: a lender, and the only address allowed to call `receiveFlashLoan`.
    address public immutable VAULT;
    /// @notice Uniswap V4 PoolManager (zero = disabled): a lender, and the only address allowed to call `unlockCallback`.
    address public immutable POOL_MANAGER;

    mapping(address => bool) public allowedRouters;

    /// @dev Hash of the loan this contract itself just requested; 0 when no loan is in flight.
    ///      Balancer does not report who initiated a loan, so this is how foreign loans are rejected.
    bytes32 private _pendingLoan;

    event RouterAllowed(address indexed router, bool allowed);
    event ArbExecuted(address indexed asset, uint256 amountBorrowed, uint256 fee, uint256 profit);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);

    error NotVault();
    error NotPoolManager();
    error LenderDisabled();
    error UnexpectedFlashLoan();
    error RouterNotAllowed(address router);
    error EmptyRoute();
    error RouteMustEndInBorrowedAsset();
    error InsufficientProfit(uint256 balanceAfter, uint256 required);
    error ZeroAddress();

    constructor(address vault_, address poolManager_) Ownable(msg.sender) {
        if (vault_ == address(0)) revert ZeroAddress();
        VAULT = vault_;
        POOL_MANAGER = poolManager_;
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

    /// @notice Start an arbitrage funded by a zero-interest flash loan. Owner only, blocked while paused.
    /// @param lender     Balancer V2 Vault or Uniswap V4 PoolManager (pick the one that holds enough of `asset`).
    /// @param asset      Token to borrow (and the token the route must end in).
    /// @param amount     Amount to borrow.
    /// @param steps      Swap route.
    /// @param minProfit  Minimum profit of THIS trade, in `asset` units, after any loan fee, or the tx reverts.
    function execute(Lender lender, address asset, uint256 amount, SwapStep[] calldata steps, uint256 minProfit)
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

        if (lender == Lender.BALANCER_V2) {
            address[] memory tokens = new address[](1);
            tokens[0] = asset;
            uint256[] memory amounts = new uint256[](1);
            amounts[0] = amount;
            _pendingLoan = keccak256(abi.encode(asset, amount, userData));
            IBalancerVault(VAULT).flashLoan(address(this), tokens, amounts, userData);
        } else {
            if (POOL_MANAGER == address(0)) revert LenderDisabled();
            bytes memory data = abi.encode(asset, amount, userData);
            _pendingLoan = keccak256(data);
            IUniswapV4PoolManager(POOL_MANAGER).unlock(data);
        }
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
        _runAndCheck(tokens[0], amounts[0], feeAmounts[0], userData);
        IERC20(tokens[0]).safeTransfer(VAULT, amounts[0] + feeAmounts[0]); // Balancer expects the repayment by transfer
    }

    /// @notice Uniswap V4 callback (flash accounting). The PoolManager only calls back whoever called `unlock`, and we
    ///         additionally require the exact data this contract just sent. Borrow with `take`, repay with sync/settle.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != POOL_MANAGER || POOL_MANAGER == address(0)) revert NotPoolManager();
        bytes32 expected = _pendingLoan;
        if (expected == bytes32(0) || keccak256(data) != expected) revert UnexpectedFlashLoan();
        (address asset, uint256 amount, bytes memory userData) = abi.decode(data, (address, uint256, bytes));

        IUniswapV4PoolManager pm = IUniswapV4PoolManager(POOL_MANAGER);
        pm.take(asset, address(this), amount); // borrow: creates a debt that must be settled before unlock ends
        _runAndCheck(asset, amount, 0, userData);
        pm.sync(asset);
        IERC20(asset).safeTransfer(POOL_MANAGER, amount);
        pm.settle(); // repay: the PoolManager reverts the whole unlock if any debt is left
        return "";
    }

    // ---------------------------------------------------------------- internals

    /// @dev Runs the route and enforces: balanceAfter >= balanceBefore + amount + fee + minProfit.
    ///      `balanceBefore` (measured before the loan) keeps old, un-withdrawn profits from hiding a losing trade.
    function _runAndCheck(address asset, uint256 amount, uint256 fee, bytes memory userData) internal {
        (SwapStep[] memory steps, uint256 minProfit, uint256 balanceBefore) =
            abi.decode(userData, (SwapStep[], uint256, uint256));

        address currentToken = asset;
        uint256 currentAmount = amount;
        for (uint256 i = 0; i < steps.length; i++) {
            currentAmount = _swap(steps[i], currentToken, currentAmount);
            currentToken = steps[i].tokenOut;
        }

        uint256 required = balanceBefore + amount + fee + minProfit;
        uint256 balanceAfter = IERC20(asset).balanceOf(address(this));
        if (balanceAfter < required) revert InsufficientProfit(balanceAfter, required);
        emit ArbExecuted(asset, amount, fee, balanceAfter - balanceBefore - amount - fee);
    }

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
