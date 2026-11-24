// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FlashArb} from "../src/FlashArb.sol";
import {IUniswapV3Router} from "../src/interfaces/IUniswapV3Router.sol";

/// Arbitrum mainnet FORK tests against the real Aave pool and real Uniswap V3 pools.
/// Skipped automatically when ARBITRUM_RPC_URL is not set.
///
/// ADDRESS NOTE: the addresses below were written from memory. Their on-chain identity was checked
/// with `scripts/verify-addresses.sh` (token symbols/decimals, router -> canonical factory/WETH, Aave
/// pool <-> provider). That is NOT the same as checking the official sources, so still confirm each one:
///   - Balancer V2 Vault:        https://docs.balancer.fi (deployment addresses) and Arbiscan
///   - Uniswap V3 SwapRouter:    https://docs.uniswap.org/contracts/v3/reference/deployments/arbitrum-deployments
///   - WETH / native USDC:       https://arbiscan.io  (check the verified token pages)
/// A wrong address makes tests fail loudly; it cannot silently pass.
contract FlashArbForkTest is Test {
    address constant UNI_V3_ROUTER = 0xE592427A0AEce92De3Edee1F18E0157C05861564; // VERIFY
    address constant WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1; // VERIFY
    address constant USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831; // VERIFY (native USDC)
    // Balancer V2 Vault (same address on every chain). On 2026-11-24 it reported a 0 flash-loan fee, not paused,
    // ~110 WETH and only ~4.2k USDC of liquidity on Arbitrum, so we only borrow WETH from it.
    address constant BALANCER_VAULT = 0xBA12222222228d8Ba445958a75a0704d566BF2C8; // VERIFY
    // Uniswap V4 PoolManager on Arbitrum One (written from memory: scripts/verify-addresses.sh checks it on-chain).
    address constant POOL_MANAGER = 0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32; // VERIFY

    FlashArb arb;

    function setUp() public {
        string memory rpc = vm.envOr("ARBITRUM_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        arb = new FlashArb(BALANCER_VAULT, POOL_MANAGER);
        arb.setRouterAllowed(UNI_V3_ROUTER, true);
    }

    function _route() internal pure returns (FlashArb.SwapStep[] memory s) {
        s = new FlashArb.SwapStep[](2);
        // sell WETH in the 0.05% pool, buy it back in the 0.30% pool
        s[0] = FlashArb.SwapStep(FlashArb.DexType.UNISWAP_V3, UNI_V3_ROUTER, USDC, 500);
        s[1] = FlashArb.SwapStep(FlashArb.DexType.UNISWAP_V3, UNI_V3_ROUTER, WETH, 3000);
    }

    /// On an untouched market the round trip only pays DEX fees, so even with a zero-interest loan the whole tx
    /// must revert with InsufficientProfit. We check the error type only (the numbers depend on the forked block).
    function test_fork_revertsWhenUnprofitable() public {
        FlashArb.SwapStep[] memory r = _route();
        try arb.execute(FlashArb.Lender.BALANCER_V2, WETH, 10 ether, r, 0) {
            fail();
        } catch (bytes memory reason) {
            assertTrue(reason.length >= 4);
            assertTrue(bytes4(reason) == FlashArb.InsufficientProfit.selector);
        }
        assertEq(IERC20(WETH).balanceOf(address(arb)), 0);
    }

    /// We CREATE an artificial spread (push the 0.05% pool's WETH price up with a huge buy), then
    /// run the arbitrage. This proves the plumbing works end-to-end with the real Balancer Vault + Uniswap.
    /// It does NOT show that such spreads exist in the wild.
    function _createArtificialSpread() internal {
        deal(USDC, address(this), 20_000_000e6); // StdCheats.deal for ERC20
        IERC20(USDC).approve(UNI_V3_ROUTER, type(uint256).max);
        IUniswapV3Router(UNI_V3_ROUTER).exactInputSingle(
            IUniswapV3Router.ExactInputSingleParams({
                tokenIn: USDC,
                tokenOut: WETH,
                fee: 500,
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: 20_000_000e6,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
    }

    function test_fork_profitsWhenSpreadExists() public {
        _createArtificialSpread();
        uint256 vaultBefore = IERC20(WETH).balanceOf(BALANCER_VAULT);
        arb.execute(FlashArb.Lender.BALANCER_V2, WETH, 10 ether, _route(), 0.01 ether);
        assertGe(IERC20(WETH).balanceOf(address(arb)), 0.01 ether);
        assertGe(IERC20(WETH).balanceOf(BALANCER_VAULT), vaultBefore); // loan repaid in full
        emit log_named_uint("profit with a zero-interest Balancer loan (wei)", IERC20(WETH).balanceOf(address(arb)));
    }


    /// Same checks with the Uniswap V4 PoolManager as the zero-interest lender.
    function test_fork_v4_revertsWhenUnprofitable() public {
        FlashArb.SwapStep[] memory r = _route();
        try arb.execute(FlashArb.Lender.UNISWAP_V4, WETH, 1 ether, r, 0) {
            fail();
        } catch (bytes memory reason) {
            assertTrue(reason.length >= 4);
            assertTrue(bytes4(reason) == FlashArb.InsufficientProfit.selector);
        }
        assertEq(IERC20(WETH).balanceOf(address(arb)), 0);
    }

    function test_fork_v4_profitsWhenSpreadExists() public {
        _createArtificialSpread();
        uint256 managerBefore = IERC20(WETH).balanceOf(POOL_MANAGER);
        arb.execute(FlashArb.Lender.UNISWAP_V4, WETH, 1 ether, _route(), 0.001 ether);
        assertGe(IERC20(WETH).balanceOf(address(arb)), 0.001 ether);
        assertGe(IERC20(WETH).balanceOf(POOL_MANAGER), managerBefore); // loan repaid in full
        emit log_named_uint("profit with a zero-interest Uniswap V4 loan (wei)", IERC20(WETH).balanceOf(address(arb)));
    }
}
