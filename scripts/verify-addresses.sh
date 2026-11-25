#!/usr/bin/env bash
# Cross-checks the contract addresses used by this project ON-CHAIN (read-only eth_calls via your RPC).
# It does not replace the official sources (Balancer and Uniswap docs, Arbiscan), but a wrong or
# fake address will fail these identity checks. Needs Foundry's `cast` and ARBITRUM_RPC_URL in .env.
set -u
cd "$(dirname "$0")/.."
if [ -f .env ]; then set -a; . ./.env; set +a; fi
: "${ARBITRUM_RPC_URL:?Set ARBITRUM_RPC_URL in .env first}"
RPC="$ARBITRUM_RPC_URL"

WETH=0x82aF49447D8a07e3bd95BD0d56f35241523fBab1
USDC=0xaf88d065e77c8cC2239327C5EDb3A432268e5831
UNI_V3_ROUTER=0xE592427A0AEce92De3Edee1F18E0157C05861564
UNI_V3_FACTORY=0x1F98431c8aD98523631AE4a59f267346ea31F984   # canonical Uniswap V3 factory
SUSHI_V2_ROUTER=0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506
BALANCER_V2_VAULT=0xBA12222222228d8Ba445958a75a0704d566BF2C8  # zero-fee flash loans
UNI_V4_POOL_MANAGER=0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32  # second zero-interest lender
PCS_V3_ROUTER=0x1b81D678ffb9C0263b24A97847620C99d213eB14       # PancakeSwap V3 SwapRouter (radar venue)
PCS_V3_QUOTER=0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997       # PancakeSwap V3 QuoterV2
AAVE_POOL=0x794a61358D6845594F94dc1DB02A252b5b4814aD  # Aave V3 Pool: only READ by the liquidation measurement tools
MULTICALL3=0xcA11bde05977b3631167028862bE2a173976CA11  # batches many reads into one RPC call (gap monitor)
UNI_V3_QUOTER_V2=0x61fFE014bA17989E743c5F6cB21bF9697530B21e  # used by the bot for price quotes

# Preflight: fail fast with a readable reason (API key is redacted from any message).
redact() { sed -E 's#(/v2/)[^[:space:]"]+#\1***#g'; }
if ! command -v cast >/dev/null 2>&1; then
  echo "ERROR: 'cast' (Foundry) not found in PATH. Run: source ~/.bashrc" >&2; exit 2
fi
probe="$(cast chain-id --rpc-url "$RPC" 2>&1)"
if ! printf '%s' "$probe" | grep -qE '^[0-9]+$'; then
  echo "ERROR: cannot reach the RPC. cast said:" >&2
  printf '%s\n' "$probe" | redact | head -6 >&2
  echo "Hints: Arbitrum enabled in your Alchemy app? URL is the full HTTPS URL from .env? Wait a minute and retry." >&2
  exit 2
fi

pass=0; fail=0
lc() { printf '%s' "$1" | tr 'A-Z' 'a-z' | tr -d '"'; }
call() { cast call "$1" "$2" --rpc-url "$RPC" 2>/dev/null | head -1 | awk '{print $1}'; }
check() { # description expected actual
  if [ -n "$3" ] && [ "$(lc "$2")" = "$(lc "$3")" ]; then echo "PASS  $1"; pass=$((pass+1));
  else echo "FAIL  $1  (expected: $2, got: ${3:-<no answer>})"; fail=$((fail+1)); fi
}

check "RPC is Arbitrum One (chain id 42161)" 42161 "$(cast chain-id --rpc-url "$RPC" 2>/dev/null)"

# Every token listed in the bot's config files: on-chain symbol and decimals must match the config.
while IFS='|' read -r SYM ADDR DEC ONCHAIN; do
  [ -z "$SYM" ] && continue
  check "token $SYM symbol"   "$ONCHAIN" "$(call "$ADDR" 'symbol()(string)')"
  check "token $SYM decimals" "$DEC"     "$(call "$ADDR" 'decimals()(uint8)')"
done < <(node -e '
  const fs = require("fs");
  const read = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {});
  const tokens = { ...read("bot/strategies.config.json").tokens, ...read("bot/radar.config.json").tokens };
  for (const [sym, t] of Object.entries(tokens)) console.log([sym, t.address, t.decimals, t.onchainSymbol || sym].join("|"));
')

check "Uniswap V3 router -> factory is the canonical V3 factory" "$UNI_V3_FACTORY" "$(call $UNI_V3_ROUTER 'factory()(address)')"
check "Uniswap V3 router -> WETH9 is our WETH"                   "$WETH"           "$(call $UNI_V3_ROUTER 'WETH9()(address)')"
check "Uniswap QuoterV2 -> factory is the canonical V3 factory" "$UNI_V3_FACTORY" "$(call $UNI_V3_QUOTER_V2 'factory()(address)')"
check "Uniswap QuoterV2 -> WETH9 is our WETH"                   "$WETH"           "$(call $UNI_V3_QUOTER_V2 'WETH9()(address)')"
check "SushiSwap V2 router -> WETH is our WETH"                  "$WETH"           "$(call $SUSHI_V2_ROUTER 'WETH()(address)')"

COLLECTOR="$(call $BALANCER_V2_VAULT 'getProtocolFeesCollector()(address)')"
check "Balancer V2 vault answers (fees collector exists)" yes "$([ -n "$COLLECTOR" ] && echo yes)"
check "Balancer V2 vault is not paused" false "$(call $BALANCER_V2_VAULT 'getPausedState()(bool,uint256,uint256)')"
[ -n "$COLLECTOR" ] && echo "INFO  Balancer flash-loan fee (1e18 = 100%) = $(call "$COLLECTOR" 'getFlashLoanFeePercentage()(uint256)')"
PCS_FACTORY="$(call $PCS_V3_ROUTER 'factory()(address)')"
check "PancakeSwap V3 router -> WETH9 is our WETH" "$WETH" "$(call $PCS_V3_ROUTER 'WETH9()(address)')"
check "PancakeSwap V3 quoter -> same factory as the router" "$PCS_FACTORY" "$(call $PCS_V3_QUOTER 'factory()(address)')"
echo "INFO  PancakeSwap V3 factory = $PCS_FACTORY  (compare with PancakeSwap's official docs)"

check "Uniswap V4 PoolManager has code" yes "$([ "$(cast code $UNI_V4_POOL_MANAGER --rpc-url "$RPC" 2>/dev/null | wc -c)" -gt 10 ] && echo yes)"
check "Uniswap V4 PoolManager answers protocolFeeController()" yes "$([ -n "$(call $UNI_V4_POOL_MANAGER 'protocolFeeController()(address)')" ] && echo yes)"

# Liquidity each zero-interest lender can lend right now (edit flashLoan.lenders[].borrowable in bot/strategies.config.json)
for L in "Balancer-V2-Vault:$BALANCER_V2_VAULT" "Uniswap-V4-PoolManager:$UNI_V4_POOL_MANAGER"; do
  NAME="${L%%:*}"; ADDR="${L##*:}"
  W="$(cast call $WETH 'balanceOf(address)(uint256)' $ADDR --rpc-url "$RPC" 2>/dev/null | awk '{printf "%.2f", $1/1e18}')"
  U="$(cast call $USDC 'balanceOf(address)(uint256)' $ADDR --rpc-url "$RPC" 2>/dev/null | awk '{printf "%.0f", $1/1e6}')"
  echo "INFO  $NAME can lend up to ${W:-?} WETH and ${U:-?} USDC right now"
done

# Aave V3 (read-only use: liquidation measurement). Provider and oracle are discovered from the pool, never hard-coded.
AAVE_PROVIDER="$(call $AAVE_POOL 'ADDRESSES_PROVIDER()(address)')"
check "Aave pool exposes an ADDRESSES_PROVIDER" yes "$([ -n "$AAVE_PROVIDER" ] && echo yes)"
if [ -n "$AAVE_PROVIDER" ]; then
  check "Aave provider.getPool() points back to the pool" "$AAVE_POOL" "$(call "$AAVE_PROVIDER" 'getPool()(address)')"
  AAVE_ORACLE="$(call "$AAVE_PROVIDER" 'getPriceOracle()(address)')"
  check "Aave provider exposes a price oracle" yes "$([ -n "$AAVE_ORACLE" ] && echo yes)"
  if [ -n "$AAVE_ORACLE" ]; then
    check "Aave oracle price unit is 1e8 (USD, 8 decimals)" 100000000 "$(call "$AAVE_ORACLE" 'BASE_CURRENCY_UNIT()(uint256)')"
    WETH_PRICE="$(cast call "$AAVE_ORACLE" 'getAssetPrice(address)(uint256)' "$WETH" --rpc-url "$RPC" 2>/dev/null | head -1 | awk '{print $1}')"
    check "Aave oracle prices WETH between 100 and 100000 USD" yes "$(awk -v p="${WETH_PRICE:-0}" 'BEGIN{print (p>=100*1e8 && p<=100000*1e8) ? "yes" : "no"}')"
    echo "INFO  Aave oracle WETH price = $(awk -v p="${WETH_PRICE:-0}" 'BEGIN{printf "%.2f", p/1e8}') USD"
  fi
  echo "INFO  Aave PoolAddressesProvider = $AAVE_PROVIDER"
  echo "INFO  Compare it with AaveV3Arbitrum.POOL_ADDRESSES_PROVIDER in https://github.com/bgd-labs/aave-address-book"
fi
# getUserAccountData returns 6 values; for an address with no position the last one (health factor) is max uint256
HF_NONE="$(cast call $AAVE_POOL 'getUserAccountData(address)(uint256,uint256,uint256,uint256,uint256,uint256)' 0x000000000000000000000000000000000000dEaD --rpc-url "$RPC" 2>/dev/null | tail -1 | awk '{print $1}')"
check "Aave getUserAccountData(...) answers with a health factor (no position = max uint256)" 115792089237316195423570985008687907853269984665640564039457584007913129639935 "$HF_NONE"

check "Multicall3 is deployed and reports chain 42161" 42161 "$(call $MULTICALL3 'getChainId()(uint256)')"
echo "INFO  Sushi factory = $(call $SUSHI_V2_ROUTER 'factory()(address)')  (compare with Sushi's official docs)"

echo; echo "Result: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
