// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IAavePool} from "./interfaces/IAavePool.sol";
import {IUniswapV3Router} from "./interfaces/IUniswapV3Router.sol";
import {IUniswapV2Router} from "./interfaces/IUniswapV2Router.sol";

/// @title FlashArb
/// @notice Educational flash-loan arbitrage executor. Borrows one token from Aave V3, runs a
///         list of swaps across DEX routers, repays loan + premium, and reverts the whole
///         transaction if the net profit is below `minProfit`.
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

    /// @notice Aave V3 Pool. The only address allowed to call `executeOperation`.
    address public immutable POOL;

    mapping(address => bool) public allowedRouters;

    event RouterAllowed(address indexed router, bool allowed);
    event ArbExecuted(address indexed asset, uint256 amountBorrowed, uint256 premium, uint256 profit);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);

    error NotPool();
    error BadInitiator();
    error RouterNotAllowed(address router);
    error EmptyRoute();
    error RouteMustEndInBorrowedAsset();
    error InsufficientProfit(uint256 balanceAfter, uint256 required);
    error ZeroAddress();

    constructor(address pool_) Ownable(msg.sender) {
        if (pool_ == address(0)) revert ZeroAddress();
        POOL = pool_;
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

    /// @notice Start an arbitrage. Owner only, blocked while paused.
    /// @param asset      Token to borrow (and the token the route must end in).
    /// @param amount     Amount to borrow.
    /// @param steps      Swap route.
    /// @param minProfit  Minimum profit (in `asset` units, after the Aave premium) or the tx reverts.
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
        IAavePool(POOL).flashLoanSimple(address(this), asset, amount, abi.encode(steps, minProfit), 0);
    }

    // ---------------------------------------------------------------- Aave callback

    /// @notice Called by the Aave Pool during the flash loan. Anyone else is rejected.
    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params)
        external
        returns (bool)
    {
        if (msg.sender != POOL) revert NotPool();
        if (initiator != address(this)) revert BadInitiator();

        (SwapStep[] memory steps, uint256 minProfit) = abi.decode(params, (SwapStep[], uint256));

        address currentToken = asset;
        uint256 currentAmount = amount;
        for (uint256 i = 0; i < steps.length; i++) {
            currentAmount = _swap(steps[i], currentToken, currentAmount);
            currentToken = steps[i].tokenOut;
        }

        uint256 owed = amount + premium;
        uint256 balanceAfter = IERC20(asset).balanceOf(address(this));
        // The contract holds no borrowed funds beforehand, so balanceAfter - owed is the net profit.
        if (balanceAfter < owed + minProfit) revert InsufficientProfit(balanceAfter, owed + minProfit);

        IERC20(asset).forceApprove(POOL, owed);
        emit ArbExecuted(asset, amount, premium, balanceAfter - owed);
        return true;
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
