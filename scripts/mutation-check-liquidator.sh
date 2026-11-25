#!/usr/bin/env bash
# Mutation check for contracts/src/FlashLiquidator.sol: breaks the contract on purpose in several ways and verifies that
# the test-suite FAILS each time. A mutation the tests do not catch means a safety property is not really tested.
# Only the deterministic unit tests are used (the fuzz test is excluded): fuzzing is random, so a mutation that only a lucky
# fuzz run catches is NOT really covered. The original file is always restored (also on Ctrl+C).
# Usage: bash scripts/mutation-check-liquidator.sh
set -u
cd "$(dirname "$0")/../contracts"
SRC=src/FlashLiquidator.sol
BACKUP="$(mktemp)"
cp "$SRC" "$BACKUP"
trap 'cp "$BACKUP" "$SRC"; rm -f "$BACKUP"' EXIT INT TERM
FLAGS="${FORGE_FLAGS:-}"
missed=0

run() { # name, old text, new text
  cp "$BACKUP" "$SRC"
  python3 - "$SRC" "$2" "$3" <<'PY'
import sys
p, old, new = sys.argv[1:4]
s = open(p).read()
assert old in s, "mutation target not found: " + old
open(p, "w").write(s.replace(old, new, 1))
PY
  failed=$(forge test $FLAGS --match-contract FlashLiquidatorTest --no-match-test testFuzz 2>&1 | grep -cE "^\[FAIL")
  if [ "$failed" -gt 0 ]; then echo "CAUGHT  ($failed failing test(s))  $1"; else echo "MISSED  $1"; missed=$((missed + 1)); fi
}

run "profit ignores the balance before the loan" "uint256 required = balanceBefore + owed + minProfit;" "uint256 required = owed + minProfit;"
run "allowance to Aave is not reset" "IERC20(liq.debtAsset).forceApprove(AAVE_POOL, 0);" ""
run "V4 callback accepts any data" "if (expected == bytes32(0) || keccak256(data) != expected) revert UnexpectedFlashLoan();" ""
run "Balancer callback accepts any loan" "if (expected == bytes32(0) || keccak256(abi.encode(tokens[0], amounts[0], userData)) != expected) {
            revert UnexpectedFlashLoan();
        }" ""
run "minProfit is ignored" "uint256 required = balanceBefore + owed + minProfit;" "uint256 required = balanceBefore + owed;"
run "Aave is told to give aTokens instead of underlying" "liq.collateralAsset, liq.debtAsset, liq.user, liq.debtToCover, false" "liq.collateralAsset, liq.debtAsset, liq.user, liq.debtToCover, true"
run "loan fee is not counted" "uint256 owed = liq.debtToCover + fee;" "uint256 owed = liq.debtToCover;"
run "route end is not checked" "if (steps[steps.length - 1].tokenOut != liq.debtAsset) revert RouteMustEndInDebtAsset();" ""
run "router allow-list is skipped" "if (!allowedRouters[steps[i].router]) revert RouterNotAllowed(steps[i].router);" ""

echo
if [ "$missed" -eq 0 ]; then echo "All mutations were caught."; else echo "$missed mutation(s) MISSED: add or strengthen tests."; fi
[ "$missed" -eq 0 ]
