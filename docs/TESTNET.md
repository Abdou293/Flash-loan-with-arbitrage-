# Testnet end-to-end test (Arbitrum Sepolia)

**Not yet run by the author.** These steps need a machine with Foundry and internet access. Use a **burner wallet** that has
never held real funds. Never use your main wallet. Never deploy to mainnet.

## 1. Prepare
1. Create a new burner wallet (e.g. `cast wallet new`). Store its private key only in your shell/`.env`, never in git.
2. Get free Arbitrum Sepolia ETH from a public faucet.
3. Get a free Arbitrum Sepolia RPC URL (Alchemy/Infura free plan) and put it in `.env` as `ARBITRUM_SEPOLIA_RPC_URL`.
4. Find the **Aave V3 Pool address for Arbitrum Sepolia** in the official Aave address book
   (<https://github.com/bgd-labs/aave-address-book>). Do not guess it. Confirm Aave actually has the asset you want to borrow on that testnet.

## 2. Deploy

    cd contracts
    export PRIVATE_KEY=<burner key>        # shell only
    export AAVE_POOL=<address from the Aave address book>
    export ROUTER=<official Uniswap V3 SwapRouter for Arbitrum Sepolia>   # optional, verify in Uniswap docs
    forge script script/Deploy.s.sol --rpc-url $ARBITRUM_SEPOLIA_RPC_URL --broadcast

The script refuses to run on Arbitrum One (chain id 42161).

## 3. What to expect (honest)
Testnet pools have little liquidity and no real arbitrage spreads. A correct run therefore usually demonstrates the
**safety behaviour**, not profit: simulate an execution with `cast call` and confirm it reverts with `InsufficientProfit`.

    cast call $FLASH_ARB "execute(address,uint256,(uint8,address,address,uint24)[],uint256)" \
      <asset> <amount> "[(0,<router>,<tokenOut>,3000),(0,<router>,<asset>,500)]" 1 \
      --from <burner address> --rpc-url $ARBITRUM_SEPOLIA_RPC_URL

Also check on a block explorer that calling `executeOperation` directly from another address reverts (`NotPool`).

## 4. Point the bot's simulator at the deployment
Put the **public** values in `.env` (not secrets): `FLASH_ARB_ADDRESS`, `OWNER_ADDRESS`. Then
`npm run dry-run -- --source rpc` uses a real static-call simulation instead of quote-only mode.
