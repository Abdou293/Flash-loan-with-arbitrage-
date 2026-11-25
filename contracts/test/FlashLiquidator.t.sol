// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {FlashLiquidator} from "../src/FlashLiquidator.sol";
import {MockToken, MockRouter, MockBalancerVault, MockPoolManager, MockAaveLiquidationPool} from "./mocks/Mocks.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// Logic tests with mocks (no network needed). Real-chain tests are in FlashLiquidator.fork.t.sol.
///
/// Reference numbers (all tokens 18 decimals): collateral price $2000, debt price $1, loan 1000 debt tokens,
/// 5% bonus, 10% of the bonus kept by Aave:
///   Aave repays 1000 debt  ->  base 0.5 coll + bonus 0.025 - fee 0.0025 = 0.5225 collateral to the liquidator
///   sold at 1990 debt per collateral (0.5% cost) -> 1039.775 debt  ->  profit 39.775 after repaying 1000.
contract FlashLiquidatorTest is Test {
    FlashLiquidator liq;
    MockAaveLiquidationPool aave;
    MockBalancerVault vault;
    MockPoolManager manager;
    MockRouter v3Router;
    MockRouter v2Router;
    MockToken coll;
    MockToken debt;

    address borrower = address(0xB0B);
    address attacker = address(0xBAD);

    uint256 constant LOAN = 1000 ether;
    FlashLiquidator.Lender constant BAL = FlashLiquidator.Lender.BALANCER_V2;
    FlashLiquidator.Lender constant V4 = FlashLiquidator.Lender.UNISWAP_V4;

    function setUp() public {
        aave = new MockAaveLiquidationPool();
        vault = new MockBalancerVault();
        manager = new MockPoolManager();
        liq = new FlashLiquidator(address(aave), address(vault), address(manager));
        v3Router = new MockRouter();
        v2Router = new MockRouter();
        coll = new MockToken("COLL");
        debt = new MockToken("DEBT");
        liq.setRouterAllowed(address(v3Router), true);
        liq.setRouterAllowed(address(v2Router), true);

        aave.setPrice(address(coll), 2000 ether);
        aave.setPrice(address(debt), 1 ether);
        aave.setLiquidatable(borrower, true);
        // selling collateral on the DEX: 1990 debt per collateral (0.5% worse than the oracle price)
        v3Router.setRate(address(coll), address(debt), 1990 ether);
    }

    function _liquidation() internal view returns (FlashLiquidator.Liquidation memory) {
        return FlashLiquidator.Liquidation(address(coll), address(debt), borrower, LOAN);
    }

    function _route() internal view returns (FlashLiquidator.SwapStep[] memory s) {
        s = new FlashLiquidator.SwapStep[](1);
        s[0] = FlashLiquidator.SwapStep(FlashLiquidator.DexType.UNISWAP_V3, address(v3Router), address(debt), 500);
    }

    function _noRoute() internal pure returns (FlashLiquidator.SwapStep[] memory s) {
        s = new FlashLiquidator.SwapStep[](0);
    }

    // ------------------------------------------------------------ success (zero-interest loan)

    function test_balancer_liquidationKeepsTheWholeProfit() public {
        liq.execute(BAL, _liquidation(), _route(), 39 ether);
        assertEq(debt.balanceOf(address(liq)), 39.775 ether);
        assertEq(debt.balanceOf(address(vault)), LOAN); // loan repaid in full
        assertEq(coll.balanceOf(address(liq)), 0); // all collateral sold
        assertEq(debt.balanceOf(address(aave)), LOAN); // Aave received the repaid debt
    }

    function test_v4_liquidationKeepsTheWholeProfit() public {
        liq.execute(V4, _liquidation(), _route(), 39 ether);
        assertEq(debt.balanceOf(address(liq)), 39.775 ether);
        assertEq(debt.balanceOf(address(manager)), LOAN);
        assertTrue(manager.delta(address(debt)) == 0); // no debt left with the PoolManager
    }

    function test_ownerCanWithdrawProfit() public {
        liq.execute(BAL, _liquidation(), _route(), 0);
        liq.withdraw(address(debt), address(this), 39.775 ether);
        assertEq(debt.balanceOf(address(this)), 39.775 ether);
        assertEq(debt.balanceOf(address(liq)), 0);
    }

    function test_paysTheFeeIfBalancerStartsChargingOne() public {
        vault.setFeeBps(10); // 0.10% of 1000 = 1
        liq.execute(BAL, _liquidation(), _route(), 0);
        assertEq(debt.balanceOf(address(liq)), 38.775 ether);
    }

    function test_feeThatEatsTheProfitReverts() public {
        vault.setFeeBps(500); // 5% = 50 > 39.775
        vm.expectRevert();
        liq.execute(BAL, _liquidation(), _route(), 0);
    }

    function test_allowanceToAaveIsResetToZero() public {
        liq.execute(BAL, _liquidation(), _route(), 0);
        assertEq(debt.allowance(address(liq), address(aave)), 0);
    }

    function test_allowanceToAaveIsZeroEvenWhenAaveTakesLessThanAsked() public {
        // Aave only uses 500 of the 1000 approved: without the reset, 500 of allowance would stay open for good.
        aave.setCloseFactorBps(5000);
        liq.execute(BAL, _liquidation(), _route(), 0);
        assertEq(debt.allowance(address(liq), address(aave)), 0);
    }

    function test_emitsLiquidatedWithTheRealProfit() public {
        vm.expectEmit(true, true, true, true);
        emit FlashLiquidator.Liquidated(borrower, address(coll), address(debt), LOAN, 0, 39.775 ether);
        liq.execute(BAL, _liquidation(), _route(), 0);
    }

    // ------------------------------------------------------------ Aave takes less than asked (close factor)

    function test_partialLiquidationReturnsTheUnusedDebtTokens() public {
        aave.setCloseFactorBps(5000); // Aave only liquidates half: 500 of the 1000 borrowed
        liq.execute(BAL, _liquidation(), _route(), 0);
        assertEq(aave.lastDebtTaken(), 500 ether);
        // 500 unused + 0.26125 coll * 1990 = 519.8875 -> 1019.8875, minus 1000 repaid = 19.8875
        assertEq(debt.balanceOf(address(liq)), 19.8875 ether);
        assertEq(debt.balanceOf(address(vault)), LOAN);
    }

    // ------------------------------------------------------------ collateral is already the debt asset

    function test_sameAssetNeedsNoSwap() public {
        aave.setPrice(address(debt), 1 ether); // same token on both sides, price 1
        FlashLiquidator.Liquidation memory l = FlashLiquidator.Liquidation(address(debt), address(debt), borrower, LOAN);
        liq.execute(BAL, l, _noRoute(), 0);
        // base 1000 + bonus 50 - fee 5 = 1045 back for 1000 repaid -> profit 45
        assertEq(debt.balanceOf(address(liq)), 45 ether);
    }

    // ------------------------------------------------------------ reverts when it does not pay

    function test_revertsWhenSellingTheCollateralCostsMoreThanTheBonus() public {
        v3Router.setRate(address(coll), address(debt), 1900 ether); // 5% slippage: 0.5225 * 1900 = 992.75
        vm.expectRevert(abi.encodeWithSelector(FlashLiquidator.InsufficientProfit.selector, 992.75 ether, LOAN));
        liq.execute(BAL, _liquidation(), _route(), 0);
    }

    function test_revertsWhenProfitBelowMinProfit() public {
        vm.expectRevert(abi.encodeWithSelector(FlashLiquidator.InsufficientProfit.selector, 1039.775 ether, 1040 ether));
        liq.execute(BAL, _liquidation(), _route(), 40 ether);
    }

    function test_revertLeavesNoStateChange() public {
        v3Router.setRate(address(coll), address(debt), 1000 ether);
        try liq.execute(BAL, _liquidation(), _route(), 0) {
            fail();
        } catch {}
        assertEq(debt.balanceOf(address(liq)), 0);
        assertEq(coll.balanceOf(address(liq)), 0);
        assertEq(debt.balanceOf(address(aave)), 0); // Aave's side was rolled back too
    }

    function test_revertsWhenTheBorrowerIsHealthy() public {
        aave.setLiquidatable(borrower, false);
        vm.expectRevert(bytes("45")); // Aave's own error bubbles up
        liq.execute(BAL, _liquidation(), _route(), 0);
    }

    function test_revertsWhenAaveGivesNoCollateral() public {
        aave.setBonusBps(0);
        aave.setPrice(address(coll), type(uint256).max); // base rounds to zero: nothing received
        vm.expectRevert(FlashLiquidator.NothingLiquidated.selector);
        liq.execute(BAL, _liquidation(), _route(), 0);
    }

    // ------------------------------------------------------------ old profits must not hide a losing trade

    function test_leftoverProfitCannotHideALoss() public {
        // The old balance (50) is BIGGER than this trade's loss (7.25): a check on the total balance would let it pass
        // and silently eat the old profit; measuring against the balance before the loan must revert.
        debt.mint(address(liq), 50 ether);
        v3Router.setRate(address(coll), address(debt), 1900 ether); // this trade loses 7.25
        vm.expectRevert(abi.encodeWithSelector(FlashLiquidator.InsufficientProfit.selector, 1042.75 ether, 1050 ether));
        liq.execute(BAL, _liquidation(), _route(), 0);
        assertEq(debt.balanceOf(address(liq)), 50 ether); // old profit untouched
    }

    function test_profitWithLeftoverBalanceIsMeasuredCorrectly() public {
        debt.mint(address(liq), 5 ether);
        liq.execute(BAL, _liquidation(), _route(), 39.775 ether); // exactly this trade's own profit
        assertEq(debt.balanceOf(address(liq)), 44.775 ether);
    }

    // ------------------------------------------------------------ access control

    function test_nonOwnerCannotExecute() public {
        FlashLiquidator.Liquidation memory l = _liquidation();
        FlashLiquidator.SwapStep[] memory r = _route();
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        liq.execute(BAL, l, r, 0);
    }

    function test_nonOwnerCannotWithdrawPauseOrAllowRouters() public {
        debt.mint(address(liq), 1 ether);
        vm.startPrank(attacker);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        liq.withdraw(address(debt), attacker, 1 ether);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        liq.pause();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        liq.setRouterAllowed(attacker, true);
        vm.stopPrank();
    }

    function test_nonVaultCannotCallBalancerCallback() public {
        address[] memory tokens = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        uint256[] memory fees = new uint256[](1);
        vm.prank(attacker);
        vm.expectRevert(FlashLiquidator.NotVault.selector);
        liq.receiveFlashLoan(tokens, amounts, fees, "");
    }

    function test_nonManagerCannotCallV4Callback() public {
        vm.prank(attacker);
        vm.expectRevert(FlashLiquidator.NotPoolManager.selector);
        liq.unlockCallback("");
    }

    function test_foreignBalancerLoanNamingUsAsRecipientReverts() public {
        // Anyone can ask the Vault for a loan and name our contract as recipient. It must be refused.
        address[] memory tokens = new address[](1);
        tokens[0] = address(debt);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = LOAN;
        bytes memory userData = abi.encode(_liquidation(), _route(), uint256(0), uint256(0));
        vm.prank(attacker);
        vm.expectRevert(FlashLiquidator.UnexpectedFlashLoan.selector);
        vault.flashLoan(address(liq), tokens, amounts, userData);
    }

    function test_unexpectedV4CallbackEvenFromTheRealManagerReverts() public {
        bytes memory data =
            abi.encode(address(debt), LOAN, abi.encode(_liquidation(), _route(), uint256(0), uint256(0)));
        vm.expectRevert(FlashLiquidator.UnexpectedFlashLoan.selector);
        manager.callbackOn(address(liq), data);
    }

    // ------------------------------------------------------------ pause, lenders, route validation

    function test_pauseBlocksExecuteAndUnpauseRestores() public {
        liq.pause();
        FlashLiquidator.Liquidation memory l = _liquidation();
        FlashLiquidator.SwapStep[] memory r = _route();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        liq.execute(BAL, l, r, 0);
        liq.unpause();
        liq.execute(BAL, l, r, 0);
    }

    function test_disabledLendersRevertClearly() public {
        FlashLiquidator onlyVault = new FlashLiquidator(address(aave), address(vault), address(0));
        FlashLiquidator onlyV4 = new FlashLiquidator(address(aave), address(0), address(manager));
        onlyVault.setRouterAllowed(address(v3Router), true);
        onlyV4.setRouterAllowed(address(v3Router), true);
        FlashLiquidator.Liquidation memory l = _liquidation();
        FlashLiquidator.SwapStep[] memory r = _route();
        vm.expectRevert(FlashLiquidator.LenderDisabled.selector);
        onlyVault.execute(V4, l, r, 0);
        vm.expectRevert(FlashLiquidator.LenderDisabled.selector);
        onlyV4.execute(BAL, l, r, 0);
    }

    function test_rejectsUnallowedRouter() public {
        MockRouter rogue = new MockRouter();
        FlashLiquidator.SwapStep[] memory r = _route();
        r[0].router = address(rogue);
        FlashLiquidator.Liquidation memory l = _liquidation();
        vm.expectRevert(abi.encodeWithSelector(FlashLiquidator.RouterNotAllowed.selector, address(rogue)));
        liq.execute(BAL, l, r, 0);
    }

    function test_rejectsRouteNotEndingInTheDebtAsset() public {
        FlashLiquidator.SwapStep[] memory r = _route();
        r[0].tokenOut = address(coll);
        FlashLiquidator.Liquidation memory l = _liquidation();
        vm.expectRevert(FlashLiquidator.RouteMustEndInDebtAsset.selector);
        liq.execute(BAL, l, r, 0);
    }

    function test_rejectsMissingOrUnneededRoute() public {
        FlashLiquidator.Liquidation memory l = _liquidation();
        FlashLiquidator.SwapStep[] memory none = _noRoute();
        vm.expectRevert(FlashLiquidator.RouteMissing.selector);
        liq.execute(BAL, l, none, 0);

        FlashLiquidator.Liquidation memory same = FlashLiquidator.Liquidation(address(debt), address(debt), borrower, LOAN);
        FlashLiquidator.SwapStep[] memory r = _route();
        vm.expectRevert(FlashLiquidator.RouteNotNeeded.selector);
        liq.execute(BAL, same, r, 0);
    }

    function test_rejectsZeroAmountAndZeroAddresses() public {
        FlashLiquidator.SwapStep[] memory r = _route();
        FlashLiquidator.Liquidation memory l = _liquidation();
        l.debtToCover = 0;
        vm.expectRevert(FlashLiquidator.ZeroAmount.selector);
        liq.execute(BAL, l, r, 0);
        l = _liquidation();
        l.user = address(0);
        vm.expectRevert(FlashLiquidator.ZeroAddress.selector);
        liq.execute(BAL, l, r, 0);
    }

    function test_constructorRejectsZeroPoolAndNoLender() public {
        vm.expectRevert(FlashLiquidator.ZeroAddress.selector);
        new FlashLiquidator(address(0), address(vault), address(manager));
        vm.expectRevert(FlashLiquidator.ZeroAddress.selector);
        new FlashLiquidator(address(aave), address(0), address(0));
    }

    /// Fuzz: whatever the bonus, the DEX cost, the lender fee and minProfit, a run never succeeds with less than
    /// minProfit of its own profit, and a failed run leaves nothing behind.
    function testFuzz_neverBelowMinProfit(uint256 bonusBps, uint256 dexRate, uint256 feeBps, uint256 minProfit, bool useV4)
        public
    {
        bonusBps = bound(bonusBps, 0, 2000);
        dexRate = bound(dexRate, 1900 ether, 2010 ether);
        feeBps = bound(feeBps, 0, 100);
        minProfit = bound(minProfit, 0, 200 ether);
        aave.setBonusBps(bonusBps);
        v3Router.setRate(address(coll), address(debt), dexRate);
        vault.setFeeBps(feeBps);
        try liq.execute(useV4 ? V4 : BAL, _liquidation(), _route(), minProfit) {
            assertGe(debt.balanceOf(address(liq)), minProfit);
        } catch {
            assertEq(debt.balanceOf(address(liq)), 0);
        }
    }
}
