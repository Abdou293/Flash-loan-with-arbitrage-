# contracts/

`src/FlashArb.sol` borrows one token with a zero-interest flash loan from the Balancer V2 Vault (`execute`), runs a route of swaps
(Uniswap V3 `exactInputSingle` or Uniswap-V2-style routers such as SushiSwap), repays the loan (plus any fee the Vault charges, zero when checked),
and **reverts the whole transaction** if net profit < `minProfit`.

Safety features: owner-only `execute`/`withdraw`/`pause`/`setRouterAllowed`; the callback accepts only the
Balancer Vault and only the exact loan the contract just requested; router allow-list; pause switch; reentrancy guard;
profit measured against the balance before the loan. Not security-audited.

## Setup (inside WSL/Ubuntu or any Linux/macOS shell)

    cd contracts
    bash ../scripts/install-contract-deps.sh

## Tests

Logic tests with mocks (no network, no keys):

    forge test --no-match-contract Fork

Fork tests against real Arbitrum (needs a free RPC URL in your shell, never in a committed file):

    export ARBITRUM_RPC_URL="<your free Alchemy/Infura/public Arbitrum URL>"
    forge test --match-contract Fork -vv

Status: the earlier Aave+Balancer version passed 5/5 fork tests on a live Arbitrum One RPC; re-run them for this version. The addresses at the top of
`test/FlashArb.fork.t.sol` pass the on-chain identity check (`bash ../scripts/verify-addresses.sh`); still confirm them
against the Balancer and Uniswap docs.

Note: `evm_version` must be `cancun` (or newer). With an older value, fork tests fail inside protocol code with
`EvmError: NotActivated` and burn all the gas.
