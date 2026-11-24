// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {FlashArb} from "../src/FlashArb.sol";
import {MockToken, MockRouter, MockBalancerVault, MockPoolManager} from "./mocks/Mocks.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// Logic tests with mocks (no network needed). Real-chain tests are in FlashArb.fork.t.sol.
contract FlashArbTest is Test {
    FlashArb arb;
    MockBalancerVault vault;
    MockPoolManager manager;
    MockRouter v3Router; // "Uniswap V3"
    MockRouter v2Router; // "SushiSwap"
    MockToken weth;
    MockToken usdc;

    address attacker = address(0xBAD);
    uint256 constant LOAN = 100 ether;
    FlashArb.Lender constant BAL = FlashArb.Lender.BALANCER_V2;
    FlashArb.Lender constant V4 = FlashArb.Lender.UNISWAP_V4;

    function setUp() public {
        vault = new MockBalancerVault();
        manager = new MockPoolManager();
        arb = new FlashArb(address(vault), address(manager));
        v3Router = new MockRouter();
        v2Router = new MockRouter();
        weth = new MockToken("WETH");
        usdc = new MockToken("USDC");
        arb.setRouterAllowed(address(v3Router), true);
        arb.setRouterAllowed(address(v2Router), true);
    }

    function _route() internal view returns (FlashArb.SwapStep[] memory s) {
        s = new FlashArb.SwapStep[](2);
        s[0] = FlashArb.SwapStep(FlashArb.DexType.UNISWAP_V3, address(v3Router), address(usdc), 500);
        s[1] = FlashArb.SwapStep(FlashArb.DexType.UNISWAP_V2, address(v2Router), address(weth), 0);
    }

    /// weth -> usdc at `r1`, usdc -> weth at `r2` (both scaled 1e18)
    function _setRates(uint256 r1, uint256 r2) internal {
        v3Router.setRate(address(weth), address(usdc), r1);
        v2Router.setRate(address(usdc), address(weth), r2);
    }

    // ------------------------------------------------------------ success (zero-interest loan)

    function test_profitableArbitrageKeepsTheWholeProfit() public {
        _setRates(2000e18, 0.00052e18); // 100 WETH -> 200,000 USDC -> 104 WETH, no loan fee
        arb.execute(BAL, address(weth), LOAN, _route(), 4 ether);
        assertEq(weth.balanceOf(address(arb)), 4 ether);
        assertEq(weth.balanceOf(address(vault)), LOAN); // loan fully repaid
    }

    function test_ownerCanWithdrawProfit() public {
        _setRates(2000e18, 0.00052e18);
        arb.execute(BAL, address(weth), LOAN, _route(), 1 ether);
        arb.withdraw(address(weth), address(this), 4 ether);
        assertEq(weth.balanceOf(address(this)), 4 ether);
        assertEq(weth.balanceOf(address(arb)), 0);
    }

    function test_paysTheFeeIfTheVaultStartsChargingOne() public {
        vault.setFeeBps(10); // 0.10%: the contract repays it and still checks profit
        _setRates(2000e18, 0.00052e18);
        arb.execute(BAL, address(weth), LOAN, _route(), 0);
        assertEq(weth.balanceOf(address(arb)), 4 ether - 0.1 ether);
    }

    function test_feeIncreaseThatEatsTheProfitReverts() public {
        vault.setFeeBps(500); // 5%: more than the 4% gross profit
        _setRates(2000e18, 0.00052e18);
        vm.expectRevert();
        arb.execute(BAL, address(weth), LOAN, _route(), 0);
    }

    // ------------------------------------------------------------ reverts when unprofitable

    function test_revertsWhenLoss() public {
        _setRates(2000e18, 0.0004999e18); // ends with < 100 WETH
        vm.expectRevert();
        arb.execute(BAL, address(weth), LOAN, _route(), 0);
    }

    function test_revertsAtExactBreakEvenWhenMinProfitIsPositive() public {
        _setRates(2000e18, 0.0005e18); // exactly 100 WETH back
        vm.expectRevert(abi.encodeWithSelector(FlashArb.InsufficientProfit.selector, 100 ether, 100 ether + 1));
        arb.execute(BAL, address(weth), LOAN, _route(), 1);
    }

    function test_revertsWhenProfitBelowMinProfit() public {
        _setRates(2000e18, 0.00052e18); // profit 4 WETH
        vm.expectRevert(abi.encodeWithSelector(FlashArb.InsufficientProfit.selector, 104 ether, 105 ether));
        arb.execute(BAL, address(weth), LOAN, _route(), 5 ether);
    }

    function test_revertLeavesNoStateChange() public {
        _setRates(2000e18, 0.0004e18);
        try arb.execute(BAL, address(weth), LOAN, _route(), 0) {
            fail();
        } catch {}
        assertEq(weth.balanceOf(address(arb)), 0);
        assertEq(usdc.balanceOf(address(arb)), 0);
    }

    // ------------------------------------------------------------ old profits must not hide a losing trade

    function test_leftoverProfitCannotHideALoss() public {
        weth.mint(address(arb), 5 ether); // un-withdrawn profit from earlier trades
        _setRates(2000e18, 0.000495e18); // this trade loses ~1 WETH
        vm.expectRevert();
        arb.execute(BAL, address(weth), LOAN, _route(), 0);
        assertEq(weth.balanceOf(address(arb)), 5 ether); // old profit untouched
    }

    function test_profitWithLeftoverBalanceIsMeasuredCorrectly() public {
        weth.mint(address(arb), 5 ether);
        _setRates(2000e18, 0.00052e18); // +4 WETH
        arb.execute(BAL, address(weth), LOAN, _route(), 4 ether); // exactly the trade's own profit
        assertEq(weth.balanceOf(address(arb)), 9 ether);
    }

    // ------------------------------------------------------------ access control

    function test_nonOwnerCannotExecute() public {
        _setRates(2000e18, 0.00052e18);
        FlashArb.SwapStep[] memory r = _route();
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        arb.execute(BAL, address(weth), LOAN, r, 0);
    }

    function test_foreignLoanToOurContractReverts() public {
        // Anyone can ask the Vault for a loan and name our contract as recipient. It must be refused.
        _setRates(2000e18, 0.00052e18);
        address[] memory tokens = new address[](1);
        tokens[0] = address(weth);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = LOAN;
        bytes memory userData = abi.encode(_route(), uint256(0), uint256(0));
        vm.prank(attacker);
        vm.expectRevert(FlashArb.UnexpectedFlashLoan.selector);
        vault.flashLoan(address(arb), tokens, amounts, userData);
    }

    function test_nonVaultCannotCallCallback() public {
        address[] memory tokens = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        uint256[] memory fees = new uint256[](1);
        vm.prank(attacker);
        vm.expectRevert(FlashArb.NotVault.selector);
        arb.receiveFlashLoan(tokens, amounts, fees, "");
    }

    function test_nonOwnerCannotWithdraw() public {
        weth.mint(address(arb), 1 ether);
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        arb.withdraw(address(weth), attacker, 1 ether);
    }

    function test_nonOwnerCannotPauseOrAllowRouters() public {
        vm.startPrank(attacker);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        arb.pause();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        arb.setRouterAllowed(attacker, true);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ pause + route validation

    function test_pauseBlocksExecuteAndUnpauseRestores() public {
        _setRates(2000e18, 0.00052e18);
        arb.pause();
        FlashArb.SwapStep[] memory r = _route();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        arb.execute(BAL, address(weth), LOAN, r, 0);
        arb.unpause();
        arb.execute(BAL, address(weth), LOAN, r, 0);
    }

    function test_rejectsUnallowedRouter() public {
        MockRouter rogue = new MockRouter();
        FlashArb.SwapStep[] memory r = _route();
        r[0].router = address(rogue);
        vm.expectRevert(abi.encodeWithSelector(FlashArb.RouterNotAllowed.selector, address(rogue)));
        arb.execute(BAL, address(weth), LOAN, r, 0);
    }

    function test_rejectsRouteNotEndingInBorrowedAsset() public {
        FlashArb.SwapStep[] memory r = _route();
        r[1].tokenOut = address(usdc);
        vm.expectRevert(FlashArb.RouteMustEndInBorrowedAsset.selector);
        arb.execute(BAL, address(weth), LOAN, r, 0);
    }

    function test_rejectsEmptyRoute() public {
        FlashArb.SwapStep[] memory r = new FlashArb.SwapStep[](0);
        vm.expectRevert(FlashArb.EmptyRoute.selector);
        arb.execute(BAL, address(weth), LOAN, r, 0);
    }

    function test_constructorRejectsZeroVault() public {
        vm.expectRevert(FlashArb.ZeroAddress.selector);
        new FlashArb(address(0), address(manager));
    }

    // ------------------------------------------------------------ Uniswap V4 PoolManager (zero-fee flash accounting)

    function test_v4_profitableArbitrageKeepsTheWholeProfit() public {
        _setRates(2000e18, 0.00052e18);
        arb.execute(V4, address(weth), LOAN, _route(), 4 ether);
        assertEq(weth.balanceOf(address(arb)), 4 ether);
        assertEq(weth.balanceOf(address(manager)), LOAN); // repaid to the manager
        assertTrue(manager.delta(address(weth)) == 0); // no debt left
    }

    function test_v4_revertsWhenUnprofitable() public {
        _setRates(2000e18, 0.0004999e18);
        vm.expectRevert();
        arb.execute(V4, address(weth), LOAN, _route(), 0);
    }

    function test_v4_revertsWhenBelowMinProfit() public {
        _setRates(2000e18, 0.00052e18);
        vm.expectRevert(abi.encodeWithSelector(FlashArb.InsufficientProfit.selector, 104 ether, 105 ether));
        arb.execute(V4, address(weth), LOAN, _route(), 5 ether);
    }

    function test_v4_leftoverProfitCannotHideALoss() public {
        weth.mint(address(arb), 5 ether);
        _setRates(2000e18, 0.000495e18);
        vm.expectRevert();
        arb.execute(V4, address(weth), LOAN, _route(), 0);
        assertEq(weth.balanceOf(address(arb)), 5 ether);
    }

    function test_v4_nonManagerCannotCallCallback() public {
        vm.prank(attacker);
        vm.expectRevert(FlashArb.NotPoolManager.selector);
        arb.unlockCallback("");
    }

    function test_v4_unexpectedCallbackFromManagerReverts() public {
        // Even the real manager calling us with data we did not send must be refused.
        bytes memory data = abi.encode(address(weth), LOAN, abi.encode(_route(), uint256(0), uint256(0)));
        vm.expectRevert(FlashArb.UnexpectedFlashLoan.selector);
        manager.callbackOn(address(arb), data);
    }

    function test_v4_disabledWhenManagerNotConfigured() public {
        FlashArb noV4 = new FlashArb(address(vault), address(0));
        noV4.setRouterAllowed(address(v3Router), true);
        noV4.setRouterAllowed(address(v2Router), true);
        FlashArb.SwapStep[] memory r = _route();
        vm.expectRevert(FlashArb.LenderDisabled.selector);
        noV4.execute(V4, address(weth), LOAN, r, 0);
    }

    function test_v4_nonOwnerCannotExecute() public {
        FlashArb.SwapStep[] memory r = _route();
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        arb.execute(V4, address(weth), LOAN, r, 0);
    }

    /// Fuzz: whatever the rates and fee, a run never succeeds with less than minProfit of its own profit.
    function testFuzz_neverBelowMinProfit(uint256 r2, uint256 minProfit, uint256 feeBps) public {
        r2 = bound(r2, 0.0004e18, 0.0006e18);
        minProfit = bound(minProfit, 0, 10 ether);
        feeBps = bound(feeBps, 0, 100);
        vault.setFeeBps(feeBps);
        _setRates(2000e18, r2);
        try arb.execute(BAL, address(weth), LOAN, _route(), minProfit) {
            assertGe(weth.balanceOf(address(arb)), minProfit);
        } catch {}
    }
}
