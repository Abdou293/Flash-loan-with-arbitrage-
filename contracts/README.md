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

## FlashLiquidator (`src/FlashLiquidator.sol`): Aave V3 liquidation executor

A separate contract (FlashArb is untouched). In one transaction: borrow the borrower's **debt asset** with a zero-interest flash
loan (Balancer V2 or Uniswap V4, chosen per call) -> repay that debt on Aave with `liquidationCall` -> receive the collateral plus
the liquidation bonus -> sell the collateral back into the debt asset (Uniswap V3 / V2-style routers, owner allow-list) -> repay the
loan -> **revert unless the trade itself made at least `minProfit`**.

- Same protections as FlashArb: owner-only `execute`/`withdraw`/`pause`/`setRouterAllowed`; callbacks accept only their lender and
  only the exact loan the contract just requested; profit measured against the balance **before** the loan.
- Specific to liquidations: the allowance to the Aave pool is reset to zero after the call (Aave may use less than approved because of
  the close factor; unused debt tokens stay in the contract and count toward the final balance); when the collateral already is the
  debt asset no swap is needed (empty route); a collateral that does not arrive reverts with `NothingLiquidated`.
- Status: 32 mock tests (including a fuzz test) pass; a mutation check (`bash scripts/mutation-check-liquidator.sh`) breaks the contract in
  9 ways and the deterministic tests (fuzz excluded, because fuzzing is random) catch all 9. Running it on a second machine
  once exposed a mutation that only a lucky fuzz run had caught; a fixed test now covers it. Fork tests against a real Aave position are the next step and have **not** been written or run yet.
- Educational only, not audited. The measurements in `docs/reports/` show that professional bots take every liquidation worth taking in the
  block of the price update, so this contract is a portfolio piece, not a profit source.
