# contracts/

`src/FlashArb.sol` borrows one token from Aave V3 (`flashLoanSimple`), runs a route of swaps
(Uniswap V3 `exactInputSingle` or Uniswap-V2-style routers such as SushiSwap), repays loan + premium,
and **reverts the whole transaction** if net profit < `minProfit`.

Safety features: owner-only `execute`/`withdraw`/`pause`/`setRouterAllowed`; callback accepts only the
Aave pool (and only when the contract itself started the loan); router allow-list; pause switch;
reentrancy guard. Not security-audited.

## Setup (inside WSL/Ubuntu or any Linux/macOS shell)

    cd contracts
    bash ../scripts/install-contract-deps.sh

## Tests

Logic tests with mocks (no network, no keys):

    forge test --no-match-contract Fork

Fork tests against real Arbitrum (needs a free RPC URL in your shell, never in a committed file):

    export ARBITRUM_RPC_URL="<your free Alchemy/Infura/public Arbitrum URL>"
    forge test --match-contract Fork -vv

**Verify the addresses** at the top of `test/FlashArb.fork.t.sol` against the Aave address book and
Uniswap docs before trusting fork results.
