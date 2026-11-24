// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";
import {FlashArb} from "../src/FlashArb.sol";

/// Deploys FlashArb to a TESTNET only.
///
/// Environment variables (set them in your shell; never commit them):
///   PRIVATE_KEY   private key of a dedicated BURNER wallet funded with testnet ETH only
///   BALANCER_VAULT Balancer V2 Vault on the target network (zero-interest flash loans). Verify it on-chain
///                 (scripts/verify-addresses.sh) and confirm the Vault actually holds the token you will borrow.
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
        address balancerVault = vm.envAddress("BALANCER_VAULT");
        address router = vm.envOr("ROUTER", address(0));

        vm.startBroadcast(pk);
        arb = new FlashArb(balancerVault);
        if (router != address(0)) arb.setRouterAllowed(router, true);
        vm.stopBroadcast();
    }
}
