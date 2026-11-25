// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IAavePoolLiquidation} from "./interfaces/IAavePoolLiquidation.sol";
import {IBalancerVault} from "./interfaces/IBalancerVault.sol";
import {IUniswapV4PoolManager} from "./interfaces/IUniswapV4PoolManager.sol";
import {IUniswapV3Router} from "./interfaces/IUniswapV3Router.sol";
import {IUniswapV2Router} from "./interfaces/IUniswapV2Router.sol";

/// @title FlashLiquidator
/// @notice Educational Aave V3 liquidation executor funded ONLY by zero-interest flash loans (Balancer V2 Vault or
///         Uniswap V4 PoolManager). In one transaction it borrows the borrower's debt asset, repays that debt on Aave,
///         receives the collateral plus the liquidation bonus, sells the collateral back into the debt asset, repays
///         the loan, and reverts unless the trade itself made at least `minProfit`.
/// @dev NOT security-audited. Educational / portfolio use only. Separate from FlashArb on purpose. Measurements in
///      docs/reports show professional bots take every liquidation worth taking in the block of the price update,
///      so this contract is a portfolio piece, not a profit source.
contract FlashLiquidator is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum DexType {
        UNISWAP_V3, // router implements exactInputSingle (original SwapRouter and forks)
        UNISWAP_V2 // router implements swapExactTokensForTokens (SushiSwap, etc.)
    }

    /// @notice Which zero-interest lender funds the trade (same order as FlashArb.Lender).
    enum Lender {
        BALANCER_V2,
        UNISWAP_V4
    }

    /// @param dex       Which router ABI to use.
    /// @param router    Router address. Must be allow-listed by the owner.
    /// @param tokenOut  Token received from this step. tokenIn is the previous step's tokenOut (the first step sells
    ///                  the collateral).
    /// @param fee       Uniswap V3 pool fee tier (ignored for V2 routers).
    struct SwapStep {
        DexType dex;
        address router;
        address tokenOut;
        uint24 fee;
    }

    /// @param collateralAsset Collateral token the borrower posted (received by this contract).
    /// @param debtAsset       Token the borrower owes (borrowed from the lender, repaid to Aave).
    /// @param user            The borrower being liquidated.
    /// @param debtToCover     Amount of debt to repay (also the flash-loan amount). Aave may take less.
    struct Liquidation {
        address collateralAsset;
        address debtAsset;
        address user;
        uint256 debtToCover;
    }

    /// @notice Aave V3 Pool: where the liquidation happens.
    address public immutable AAVE_POOL;
    /// @notice Balancer V2 Vault (zero = Balancer disabled). The only caller of `receiveFlashLoan`.
    address public immutable VAULT;
    /// @notice Uniswap V4 PoolManager (zero = disabled). The only caller of `unlockCallback`.
    address public immutable POOL_MANAGER;

    mapping(address => bool) public allowedRouters;

    /// @dev Hash of the loan this contract itself just requested; 0 when no loan is in flight. Lenders either do not
    ///      report who started a loan (Balancer) or call back anyone who called `unlock` (V4), so foreign loans naming
    ///      this contract are rejected by comparing the payload with this hash.
    bytes32 private _pendingLoan;

    event RouterAllowed(address indexed router, bool allowed);
    event Liquidated(
        address indexed user,
        address indexed collateralAsset,
        address indexed debtAsset,
        uint256 borrowed,
        uint256 fee,
        uint256 profit
    );
    event Withdrawn(address indexed token, address indexed to, uint256 amount);

    error NotVault();
    error NotPoolManager();
    error LenderDisabled();
    error UnexpectedFlashLoan();
    error RouterNotAllowed(address router);
    error RouteMissing();
    error RouteNotNeeded();
    error RouteMustEndInDebtAsset();
    error NothingLiquidated();
    error ZeroAmount();
    error ZeroAddress();
    error InsufficientProfit(uint256 balanceAfter, uint256 required);

    constructor(address aavePool_, address vault_, address poolManager_) Ownable(msg.sender) {
        if (aavePool_ == address(0)) revert ZeroAddress();
        if (vault_ == address(0) && poolManager_ == address(0)) revert ZeroAddress(); // at least one lender
        AAVE_POOL = aavePool_;
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

    /// @notice Liquidate `liq.user` using a zero-interest flash loan. Owner only, blocked while paused.
    /// @param steps     Route that sells the received collateral back into `liq.debtAsset`. Must be empty when the
    ///                  collateral IS the debt asset, and non-empty (ending in the debt asset) otherwise.
    /// @param minProfit Minimum profit of THIS trade, in debt-asset units, after any loan fee, or the tx reverts.
    function execute(Lender lender, Liquidation calldata liq, SwapStep[] calldata steps, uint256 minProfit)
        external
        onlyOwner
        whenNotPaused
        nonReentrant
    {
        if (liq.debtToCover == 0) revert ZeroAmount();
        if (liq.user == address(0) || liq.collateralAsset == address(0) || liq.debtAsset == address(0)) {
            revert ZeroAddress();
        }
        _validateRoute(liq, steps);

        uint256 balanceBefore = IERC20(liq.debtAsset).balanceOf(address(this));
        bytes memory userData = abi.encode(liq, steps, minProfit, balanceBefore);

        if (lender == Lender.BALANCER_V2) {
            if (VAULT == address(0)) revert LenderDisabled();
            address[] memory tokens = new address[](1);
            tokens[0] = liq.debtAsset;
            uint256[] memory amounts = new uint256[](1);
            amounts[0] = liq.debtToCover;
            _pendingLoan = keccak256(abi.encode(liq.debtAsset, liq.debtToCover, userData));
            IBalancerVault(VAULT).flashLoan(address(this), tokens, amounts, userData);
        } else {
            if (POOL_MANAGER == address(0)) revert LenderDisabled();
            bytes memory data = abi.encode(liq.debtAsset, liq.debtToCover, userData);
            _pendingLoan = keccak256(data);
            IUniswapV4PoolManager(POOL_MANAGER).unlock(data);
        }
        _pendingLoan = bytes32(0);
    }

    // ---------------------------------------------------------------- flash-loan callbacks

    /// @notice Balancer V2 callback. Only the Vault may call it, and only for the exact loan this contract requested.
    function receiveFlashLoan(
        address[] calldata tokens,
        uint256[] calldata amounts,
        uint256[] calldata feeAmounts,
        bytes calldata userData
    ) external {
        if (msg.sender != VAULT || VAULT == address(0)) revert NotVault();
        if (tokens.length != 1 || amounts.length != 1 || feeAmounts.length != 1) revert UnexpectedFlashLoan();
        bytes32 expected = _pendingLoan;
        if (expected == bytes32(0) || keccak256(abi.encode(tokens[0], amounts[0], userData)) != expected) {
            revert UnexpectedFlashLoan();
        }
        _liquidateAndCheck(tokens[0], amounts[0], feeAmounts[0], userData);
        IERC20(tokens[0]).safeTransfer(VAULT, amounts[0] + feeAmounts[0]); // Balancer expects repayment by transfer
    }

    /// @notice Uniswap V4 callback (flash accounting). Only the PoolManager may call it, and only with the exact data
    ///         this contract just sent to `unlock`. Borrow with `take`, repay with sync/transfer/settle.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != POOL_MANAGER || POOL_MANAGER == address(0)) revert NotPoolManager();
        bytes32 expected = _pendingLoan;
        if (expected == bytes32(0) || keccak256(data) != expected) revert UnexpectedFlashLoan();
        (address asset, uint256 amount, bytes memory userData) = abi.decode(data, (address, uint256, bytes));

        IUniswapV4PoolManager pm = IUniswapV4PoolManager(POOL_MANAGER);
        pm.take(asset, address(this), amount); // creates a debt that must be settled before unlock ends
        _liquidateAndCheck(asset, amount, 0, userData); // V4 flash accounting charges no fee
        pm.sync(asset);
        IERC20(asset).safeTransfer(POOL_MANAGER, amount);
        pm.settle(); // the PoolManager reverts the whole unlock if any debt is left
        return "";
    }

    // ---------------------------------------------------------------- internals

    function _validateRoute(Liquidation calldata liq, SwapStep[] calldata steps) internal view {
        if (liq.collateralAsset == liq.debtAsset) {
            if (steps.length != 0) revert RouteNotNeeded(); // nothing to sell: collateral is already the debt asset
            return;
        }
        if (steps.length == 0) revert RouteMissing();
        if (steps[steps.length - 1].tokenOut != liq.debtAsset) revert RouteMustEndInDebtAsset();
        for (uint256 i = 0; i < steps.length; i++) {
            if (!allowedRouters[steps[i].router]) revert RouterNotAllowed(steps[i].router);
        }
    }

    /// @dev Repays the borrower's debt on Aave, sells the collateral received, and enforces
    ///      balanceAfter >= balanceBefore + amount + fee + minProfit. `balanceBefore` (measured before the loan) keeps
    ///      old, un-withdrawn profits from hiding a losing trade. Debt tokens Aave did not use (close factor) stay
    ///      here and count toward the final balance.
    function _liquidateAndCheck(address asset, uint256 amount, uint256 fee, bytes memory userData) internal {
        (Liquidation memory liq, SwapStep[] memory steps, uint256 minProfit, uint256 balanceBefore) =
            abi.decode(userData, (Liquidation, SwapStep[], uint256, uint256));
        // Both are already pinned by the pending-loan hash; checked again so a future refactor cannot loosen them.
        if (asset != liq.debtAsset || amount != liq.debtToCover) revert UnexpectedFlashLoan();

        _liquidateAndSell(liq, steps);
        _enforceProfit(liq, fee, minProfit, balanceBefore);
    }

    function _liquidateAndSell(Liquidation memory liq, SwapStep[] memory steps) internal {
        bool sameAsset = liq.collateralAsset == liq.debtAsset;
        uint256 collateralBefore = sameAsset ? 0 : IERC20(liq.collateralAsset).balanceOf(address(this));

        IERC20(liq.debtAsset).forceApprove(AAVE_POOL, liq.debtToCover);
        IAavePoolLiquidation(AAVE_POOL).liquidationCall(
            liq.collateralAsset, liq.debtAsset, liq.user, liq.debtToCover, false
        );
        IERC20(liq.debtAsset).forceApprove(AAVE_POOL, 0); // never leave an allowance to the pool behind

        if (sameAsset) return; // the collateral already is the debt asset: nothing to sell

        uint256 received = IERC20(liq.collateralAsset).balanceOf(address(this)) - collateralBefore;
        if (received == 0) revert NothingLiquidated();
        address currentToken = liq.collateralAsset;
        uint256 currentAmount = received;
        for (uint256 i = 0; i < steps.length; i++) {
            currentAmount = _swap(steps[i], currentToken, currentAmount);
            currentToken = steps[i].tokenOut;
        }
    }

    function _enforceProfit(Liquidation memory liq, uint256 fee, uint256 minProfit, uint256 balanceBefore) internal {
        uint256 owed = liq.debtToCover + fee;
        uint256 required = balanceBefore + owed + minProfit;
        uint256 balanceAfter = IERC20(liq.debtAsset).balanceOf(address(this));
        if (balanceAfter < required) revert InsufficientProfit(balanceAfter, required);
        emit Liquidated(
            liq.user, liq.collateralAsset, liq.debtAsset, liq.debtToCover, fee, balanceAfter - balanceBefore - owed
        );
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
