// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {FlashArb} from "../src/FlashArb.sol";
import {MockToken, MockAavePool, MockRouter} from "./mocks/Mocks.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// Logic tests with mocks (no network needed). Real-pool tests are in FlashArb.fork.t.sol.
contract FlashArbTest is Test {
    FlashArb arb;
    MockAavePool pool;
    MockRouter v3Router; // "Uniswap V3"
    MockRouter v2Router; // "SushiSwap"
    MockToken weth;
    MockToken usdc;

    address attacker = address(0xBAD);
    uint256 constant LOAN = 100 ether;

    function setUp() public {
        pool = new MockAavePool();
        arb = new FlashArb(address(pool));
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

    // ------------------------------------------------------------ success

    function test_profitableArbitrageSucceeds() public {
        _setRates(2000e18, 0.00052e18); // 100 WETH -> 200,000 USDC -> 104 WETH
        arb.execute(address(weth), LOAN, _route(), 1 ether);

        uint256 premium = (LOAN * 5) / 10_000; // 0.05 WETH
        // mock pool pulled back LOAN + premium; remaining balance is the profit
        assertEq(weth.balanceOf(address(arb)), 104 ether - LOAN - premium); // 104 - 100 - 0.05 = 3.95
        assertEq(weth.balanceOf(address(arb)), 3.95 ether);
    }

    function test_ownerCanWithdrawProfit() public {
        _setRates(2000e18, 0.00052e18);
        arb.execute(address(weth), LOAN, _route(), 1 ether);
        arb.withdraw(address(weth), address(this), 3.95 ether);
        assertEq(weth.balanceOf(address(this)), 3.95 ether);
        assertEq(weth.balanceOf(address(arb)), 0);
    }

    // ------------------------------------------------------------ reverts when unprofitable

    function test_revertsWhenLoss() public {
        _setRates(2000e18, 0.0004999e18); // ends with < 100 WETH
        vm.expectRevert();
        arb.execute(address(weth), LOAN, _route(), 0);
    }

    function test_revertsWhenProfitBelowPremium() public {
        _setRates(2000e18, 0.0005e18); // exactly 100 WETH back: gross profit 0, premium 0.05 unpaid
        vm.expectRevert();
        arb.execute(address(weth), LOAN, _route(), 0);
    }

    function test_revertsWhenProfitBelowMinProfit() public {
        _setRates(2000e18, 0.00052e18); // net profit 3.95 WETH
        uint256 balance = 104 ether;
        uint256 required = LOAN + 0.05 ether + 4 ether;
        vm.expectRevert(abi.encodeWithSelector(FlashArb.InsufficientProfit.selector, balance, required));
        arb.execute(address(weth), LOAN, _route(), 4 ether); // wants 4, only 3.95
    }

    function test_revertLeavesNoStateChange() public {
        _setRates(2000e18, 0.0004e18);
        try arb.execute(address(weth), LOAN, _route(), 0) {
            fail();
        } catch {}
        assertEq(weth.balanceOf(address(arb)), 0);
        assertEq(usdc.balanceOf(address(arb)), 0);
    }

    // ------------------------------------------------------------ access control

    function test_nonOwnerCannotExecute() public {
        _setRates(2000e18, 0.00052e18);
        FlashArb.SwapStep[] memory r = _route();
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        arb.execute(address(weth), LOAN, r, 0);
    }

    function test_nonPoolCannotCallCallback() public {
        vm.prank(attacker);
        vm.expectRevert(FlashArb.NotPool.selector);
        arb.executeOperation(address(weth), LOAN, 0, address(arb), "");
    }

    function test_poolCallbackWithForeignInitiatorReverts() public {
        // Someone else started a flash loan targeting our contract: initiator != arb.
        bytes memory params = abi.encode(_route(), uint256(0));
        vm.expectRevert(FlashArb.BadInitiator.selector);
        pool.callbackWithInitiator(address(arb), address(weth), LOAN, attacker, params);
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
        arb.execute(address(weth), LOAN, r, 0);
        arb.unpause();
        arb.execute(address(weth), LOAN, r, 0);
    }

    function test_rejectsUnallowedRouter() public {
        MockRouter rogue = new MockRouter();
        FlashArb.SwapStep[] memory r = _route();
        r[0].router = address(rogue);
        vm.expectRevert(abi.encodeWithSelector(FlashArb.RouterNotAllowed.selector, address(rogue)));
        arb.execute(address(weth), LOAN, r, 0);
    }

    function test_rejectsRouteNotEndingInBorrowedAsset() public {
        FlashArb.SwapStep[] memory r = _route();
        r[1].tokenOut = address(usdc);
        vm.expectRevert(FlashArb.RouteMustEndInBorrowedAsset.selector);
        arb.execute(address(weth), LOAN, r, 0);
    }

    function test_rejectsEmptyRoute() public {
        FlashArb.SwapStep[] memory r = new FlashArb.SwapStep[](0);
        vm.expectRevert(FlashArb.EmptyRoute.selector);
        arb.execute(address(weth), LOAN, r, 0);
    }

    function test_constructorRejectsZeroPool() public {
        vm.expectRevert(FlashArb.ZeroAddress.selector);
        new FlashArb(address(0));
    }

    /// Fuzz: whatever the rates, a run never succeeds with less than minProfit left over.
    function testFuzz_neverBelowMinProfit(uint256 r2, uint256 minProfit) public {
        r2 = bound(r2, 0.0004e18, 0.0006e18);
        minProfit = bound(minProfit, 0, 10 ether);
        _setRates(2000e18, r2);
        try arb.execute(address(weth), LOAN, _route(), minProfit) {
            assertGe(weth.balanceOf(address(arb)), minProfit);
        } catch {}
    }
}
