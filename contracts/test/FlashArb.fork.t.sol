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
///   - Aave V3 Pool (Arbitrum):  https://github.com/bgd-labs/aave-address-book  (AaveV3Arbitrum.POOL)
///   - Uniswap V3 SwapRouter:    https://docs.uniswap.org/contracts/v3/reference/deployments/arbitrum-deployments
///   - WETH / native USDC:       https://arbiscan.io  (check the verified token pages)
/// A wrong address makes tests fail loudly; it cannot silently pass.
contract FlashArbForkTest is Test {
    address constant AAVE_POOL = 0x794a61358D6845594F94dc1DB02A252b5b4814aD; // VERIFY
    address constant UNI_V3_ROUTER = 0xE592427A0AEce92De3Edee1F18E0157C05861564; // VERIFY
    address constant WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1; // VERIFY
    address constant USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831; // VERIFY (native USDC)

    FlashArb arb;

    function setUp() public {
        string memory rpc = vm.envOr("ARBITRUM_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        arb = new FlashArb(AAVE_POOL);
        arb.setRouterAllowed(UNI_V3_ROUTER, true);
    }

    function _route() internal pure returns (FlashArb.SwapStep[] memory s) {
        s = new FlashArb.SwapStep[](2);
        // sell WETH in the 0.05% pool, buy it back in the 0.30% pool
        s[0] = FlashArb.SwapStep(FlashArb.DexType.UNISWAP_V3, UNI_V3_ROUTER, USDC, 500);
        s[1] = FlashArb.SwapStep(FlashArb.DexType.UNISWAP_V3, UNI_V3_ROUTER, WETH, 3000);
    }

    /// On an untouched market the round trip only pays fees, so the whole tx must revert.
    function test_fork_revertsWhenUnprofitable() public {
        FlashArb.SwapStep[] memory r = _route();
        vm.expectRevert(FlashArb.InsufficientProfit.selector);
        arb.execute(WETH, 10 ether, r, 0);
    }

    /// We CREATE an artificial spread (push the 0.05% pool's WETH price up with a huge buy), then
    /// run the arbitrage. This proves the plumbing works end-to-end with real Aave + Uniswap.
    /// It does NOT show that such spreads exist in the wild.
    function test_fork_profitsWhenSpreadExists() public {
        // manipulator buys WETH with 20M USDC in the 0.05% pool
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

        uint256 before_ = IERC20(WETH).balanceOf(address(arb));
        arb.execute(WETH, 10 ether, _route(), 0.01 ether);
        uint256 profit = IERC20(WETH).balanceOf(address(arb)) - before_;
        assertGe(profit, 0.01 ether);
    }
}
