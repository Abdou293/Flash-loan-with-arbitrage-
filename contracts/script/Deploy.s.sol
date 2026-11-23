// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script} from "forge-std/Test.sol";
import {FlashArb} from "../src/FlashArb.sol";

/// Deploys FlashArb to a TESTNET only.
///
/// Environment variables (set them in your shell; never commit them):
///   PRIVATE_KEY   private key of a dedicated BURNER wallet funded with testnet ETH only
///   AAVE_POOL     Aave V3 Pool address for the target testnet, taken from the Aave address book
///                 (https://github.com/bgd-labs/aave-address-book). Do not guess it.
///   ROUTER        optional: a DEX router to allow-list right away (verify it from the DEX's official docs)
///
/// Example (Arbitrum Sepolia, chain id 421614):
///   forge script script/Deploy.s.sol --rpc-url $ARBITRUM_SEPOLIA_RPC_URL --broadcast
contract Deploy is Script {
    uint256 constant ARBITRUM_ONE = 42161;

    function run() external returns (FlashArb arb) {
        // Hard stop: this script must never deploy to Arbitrum One (mainnet).
        require(block.chainid != ARBITRUM_ONE, "mainnet deployment is blocked in this script");

        uint256 pk = vm.envUint("PRIVATE_KEY");
        address pool = vm.envAddress("AAVE_POOL");
        address router = vm.envOr("ROUTER", address(0));

        vm.startBroadcast(pk);
        arb = new FlashArb(pool);
        if (router != address(0)) arb.setRouterAllowed(router, true);
        vm.stopBroadcast();
    }
}
