// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FlashLiquidator} from "../src/FlashLiquidator.sol";

interface IAavePoolFork {
    function ADDRESSES_PROVIDER() external view returns (address);
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function borrow(address asset, uint256 amount, uint256 rateMode, uint16 referralCode, address onBehalfOf)
        external;
    function getUserAccountData(address user)
        external
        view
        returns (uint256, uint256 totalDebtBase, uint256, uint256, uint256, uint256 healthFactor);
}

interface IAaveProviderFork {
    function getPriceOracle() external view returns (address);
}

interface IAaveOracleFork {
    function getAssetPrice(address asset) external view returns (uint256);
}

interface IWETHFork {
    function deposit() external payable;
    function approve(address spender, uint256 amount) external returns (bool);
}

/// Arbitrum mainnet FORK tests of FlashLiquidator against the REAL Aave V3 pool, real Balancer vault, real Uniswap V4
/// PoolManager and real Uniswap V3 pools. Skipped automatically when ARBITRUM_RPC_URL is not set.
///
/// HOW THE POSITIONS WORK: each test opens a genuine Aave position (supply WETH, borrow USDC) from this test
/// contract, then makes it liquidatable by mocking ONLY Aave's oracle answer for WETH (-12%). Everything else (Aave
/// maths, close factor, liquidation bonus, lenders, DEX pools) is real.
///
/// HONESTY NOTE: the profit seen here is ARTIFICIAL. The market price of WETH is unchanged, only Aave's oracle was
/// lowered, so Aave hands out collateral that is "cheap" relative to the DEX. These tests prove the MECHANICS
/// (flash loan -> liquidate -> swap -> repay -> profit check) on real contracts. They say NOTHING about how often a
/// real liquidation is available to this bot: that is what the liquidation measurement reports are for.
///
/// Addresses are the same ones already checked on-chain by `scripts/verify-addresses.sh`.
contract FlashLiquidatorForkTest is Test {
    address constant AAVE_POOL = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;
    address constant UNI_V3_ROUTER = 0xE592427A0AEce92De3Edee1F18E0157C05861564;
    address constant WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;
    address constant USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
    address constant BALANCER_VAULT = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;
    address constant POOL_MANAGER = 0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32;

    FlashLiquidator liq;
    IAavePoolFork pool = IAavePoolFork(AAVE_POOL);
    address oracle;
    uint256 wethPrice; // Aave oracle price of WETH, 8 decimals

    function setUp() public {
        string memory rpc = vm.envOr("ARBITRUM_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        liq = new FlashLiquidator(AAVE_POOL, BALANCER_VAULT, POOL_MANAGER);
        liq.setRouterAllowed(UNI_V3_ROUTER, true);
        oracle = IAaveProviderFork(pool.ADDRESSES_PROVIDER()).getPriceOracle();
        wethPrice = IAaveOracleFork(oracle).getAssetPrice(WETH);
    }

    // ------------------------------------------------------------------ helpers

    function _route() internal pure returns (FlashLiquidator.SwapStep[] memory s) {
        s = new FlashLiquidator.SwapStep[](1);
        s[0] = FlashLiquidator.SwapStep(FlashLiquidator.DexType.UNISWAP_V3, UNI_V3_ROUTER, USDC, 500);
    }

    /// Opens a real position: supply `wethAmount` WETH, borrow 75% of its value in USDC. Returns the USDC debt.
    function _openPosition(address borrower, uint256 wethAmount) internal returns (uint256 usdcBorrowed) {
        vm.deal(borrower, wethAmount);
        vm.startPrank(borrower);
        IWETHFork(WETH).deposit{value: wethAmount}();
        IWETHFork(WETH).approve(AAVE_POOL, wethAmount);
        pool.supply(WETH, wethAmount, borrower, 0);
        // value in USDC (6 decimals) = wethAmount(18) * price(8) / 1e20
        usdcBorrowed = (wethAmount * wethPrice / 1e20) * 75 / 100;
        pool.borrow(USDC, usdcBorrowed, 2, 0, borrower);
        vm.stopPrank();
        (,,,,, uint256 hf) = pool.getUserAccountData(borrower);
        assertTrue(hf > 1e18, "position must start healthy");
    }

    /// Lowers only Aave's oracle answer for WETH by `pct` percent.
    function _crashAaveOracle(uint256 pct) internal {
        vm.mockCall(
            oracle,
            abi.encodeWithSelector(IAaveOracleFork.getAssetPrice.selector, WETH),
            abi.encode(wethPrice * (100 - pct) / 100)
        );
    }

    function _debt(address borrower) internal view returns (uint256 d) {
        (, d,,,,) = pool.getUserAccountData(borrower);
    }

    function _liquidation(address borrower, uint256 debtToCover)
        internal
        pure
        returns (FlashLiquidator.Liquidation memory)
    {
        return FlashLiquidator.Liquidation(WETH, USDC, borrower, debtToCover);
    }

    // ------------------------------------------------------------------ tests

    /// Uniswap V4 (zero fee) funds a 40%-of-debt liquidation of a real position. Aave's 50% close factor applies.
    function test_liquidateRealPositionWithV4() public {
        address borrower = makeAddr("borrowerV4");
        uint256 usdcDebt = _openPosition(borrower, 20 ether);
        _crashAaveOracle(12);
        (,,,,, uint256 hf) = pool.getUserAccountData(borrower);
        assertTrue(hf < 1e18, "position should be liquidatable after the oracle drop");
        uint256 debtBefore = _debt(borrower);

        uint256 cover = usdcDebt * 40 / 100;
        uint256 minProfit = 1_000e6; // 1,000 USDC
        liq.execute(FlashLiquidator.Lender.UNISWAP_V4, _liquidation(borrower, cover), _route(), minProfit);

        uint256 profit = IERC20(USDC).balanceOf(address(liq));
        emit log_named_uint("USDC debt covered (6 dec)", cover);
        emit log_named_uint("USDC profit, ARTIFICIAL (6 dec)", profit);
        assertTrue(profit >= minProfit, "profit below minProfit");
        assertEq(IERC20(WETH).balanceOf(address(liq)), 0, "no WETH may be left behind");
        assertTrue(_debt(borrower) < debtBefore, "borrower debt must have decreased");
        assertEq(IERC20(USDC).allowance(address(liq), AAVE_POOL), 0, "allowance to Aave must be reset");
    }

    /// Balancer holds only a few thousand USDC, so use a small position (~1.8k USDC of debt cover).
    function test_liquidateRealPositionWithBalancer() public {
        address borrower = makeAddr("borrowerBal");
        uint256 usdcDebt = _openPosition(borrower, 2 ether);
        _crashAaveOracle(12);
        uint256 cover = usdcDebt * 40 / 100;
        uint256 vaultUsdc = IERC20(USDC).balanceOf(BALANCER_VAULT);
        emit log_named_uint("Balancer USDC liquidity (6 dec)", vaultUsdc);
        if (vaultUsdc < cover) {
            // The vault cannot fund even this small loan right now: skip instead of failing for a market reason.
            vm.skip(true);
            return;
        }
        uint256 minProfit = 50e6; // 50 USDC
        liq.execute(FlashLiquidator.Lender.BALANCER_V2, _liquidation(borrower, cover), _route(), minProfit);
        uint256 profit = IERC20(USDC).balanceOf(address(liq));
        emit log_named_uint("USDC profit, ARTIFICIAL (6 dec)", profit);
        assertTrue(profit >= minProfit, "profit below minProfit");
        assertEq(IERC20(WETH).balanceOf(address(liq)), 0, "no WETH may be left behind");
    }

    /// A healthy borrower cannot be liquidated: the whole transaction reverts, nothing is spent.
    function test_healthyBorrowerReverts() public {
        address borrower = makeAddr("borrowerHealthy");
        uint256 usdcDebt = _openPosition(borrower, 20 ether);
        uint256 debtBefore = _debt(borrower);
        FlashLiquidator.Liquidation memory l = _liquidation(borrower, usdcDebt * 40 / 100);
        FlashLiquidator.SwapStep[] memory steps = _route();

        // We only assert "it reverts": Aave's exact error text is not part of OUR contract's behaviour.
        try liq.execute(FlashLiquidator.Lender.UNISWAP_V4, l, steps, 0) {
            fail("liquidating a healthy position must revert");
        } catch {}
        assertEq(IERC20(USDC).balanceOf(address(liq)), 0);
        assertEq(_debt(borrower), debtBefore, "debt must be untouched");
    }

    /// An unreachable minProfit reverts with InsufficientProfit and leaves the position and the contract untouched.
    function test_hugeMinProfitReverts() public {
        address borrower = makeAddr("borrowerMinProfit");
        uint256 usdcDebt = _openPosition(borrower, 20 ether);
        _crashAaveOracle(12);
        uint256 debtBefore = _debt(borrower);
        FlashLiquidator.Liquidation memory l = _liquidation(borrower, usdcDebt * 40 / 100);
        FlashLiquidator.SwapStep[] memory steps = _route();

        try liq.execute(FlashLiquidator.Lender.UNISWAP_V4, l, steps, 1_000_000e6) {
            fail("an impossible minProfit must revert");
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), FlashLiquidator.InsufficientProfit.selector);
        }
        assertEq(_debt(borrower), debtBefore, "revert must roll the liquidation back");
        assertEq(IERC20(USDC).balanceOf(address(liq)), 0);
    }

    /// Asking to cover 100% of the debt: Aave only takes its close-factor share (50% here); the unused USDC stays
    /// in the contract, the loan is repaid, and the trade is still profitable.
    function test_closeFactorLimitsWhatAaveTakes() public {
        address borrower = makeAddr("borrowerCloseFactor");
        uint256 usdcDebt = _openPosition(borrower, 20 ether);
        _crashAaveOracle(12);
        uint256 debtBefore = _debt(borrower);

        uint256 minProfit = 1_000e6;
        liq.execute(FlashLiquidator.Lender.UNISWAP_V4, _liquidation(borrower, usdcDebt), _route(), minProfit);

        uint256 profit = IERC20(USDC).balanceOf(address(liq));
        emit log_named_uint("USDC profit with 100% requested, ARTIFICIAL (6 dec)", profit);
        assertTrue(profit >= minProfit, "profit below minProfit");
        assertTrue(_debt(borrower) < debtBefore, "debt must have decreased");
        assertTrue(_debt(borrower) > 0, "close factor must leave part of the debt open");
    }

    /// Only the owner may start a liquidation, even on the real network.
    function test_nonOwnerCannotExecute() public {
        address borrower = makeAddr("borrowerAccess");
        FlashLiquidator.Liquidation memory l = _liquidation(borrower, 100e6);
        FlashLiquidator.SwapStep[] memory steps = _route();
        vm.prank(makeAddr("stranger"));
        try liq.execute(FlashLiquidator.Lender.UNISWAP_V4, l, steps, 0) {
            fail("a stranger must not be able to execute");
        } catch {}
    }
}
