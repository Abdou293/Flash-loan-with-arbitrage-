#!/usr/bin/env bash
# Cross-checks the contract addresses used by this project ON-CHAIN (read-only eth_calls via your RPC).
# It does not replace the official sources (Aave address book, Uniswap docs, Arbiscan), but a wrong or
# fake address will fail these identity checks. Needs Foundry's `cast` and ARBITRUM_RPC_URL in .env.
set -u
cd "$(dirname "$0")/.."
if [ -f .env ]; then set -a; . ./.env; set +a; fi
: "${ARBITRUM_RPC_URL:?Set ARBITRUM_RPC_URL in .env first}"
RPC="$ARBITRUM_RPC_URL"

WETH=0x82aF49447D8a07e3bd95BD0d56f35241523fBab1
USDC=0xaf88d065e77c8cC2239327C5EDb3A432268e5831
USDT=0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9
ARB=0x912CE59144191C1204E64559FE8253a0e49E6548
AAVE_POOL=0x794a61358D6845594F94dc1DB02A252b5b4814aD
UNI_V3_ROUTER=0xE592427A0AEce92De3Edee1F18E0157C05861564
UNI_V3_FACTORY=0x1F98431c8aD98523631AE4a59f267346ea31F984   # canonical Uniswap V3 factory
SUSHI_V2_ROUTER=0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506

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

check "WETH symbol"   WETH "$(call $WETH 'symbol()(string)')"
check "WETH decimals" 18   "$(call $WETH 'decimals()(uint8)')"
check "USDC symbol"   USDC "$(call $USDC 'symbol()(string)')"
check "USDC decimals" 6    "$(call $USDC 'decimals()(uint8)')"
# Tether upgraded Arbitrum USDT to "USDT0", whose symbol is "USD₮0": accept both.
usdt_sym="$(call $USDT 'symbol()(string)')"
[ "$(lc "$usdt_sym")" = "usd₮0" ] && usdt_sym=USDT
check "USDT symbol (USDT or USD₮0)" USDT "$usdt_sym"
check "USDT decimals" 6    "$(call $USDT 'decimals()(uint8)')"
check "ARB symbol"    ARB  "$(call $ARB 'symbol()(string)')"

check "Uniswap V3 router -> factory is the canonical V3 factory" "$UNI_V3_FACTORY" "$(call $UNI_V3_ROUTER 'factory()(address)')"
check "Uniswap V3 router -> WETH9 is our WETH"                   "$WETH"           "$(call $UNI_V3_ROUTER 'WETH9()(address)')"
check "SushiSwap V2 router -> WETH is our WETH"                  "$WETH"           "$(call $SUSHI_V2_ROUTER 'WETH()(address)')"

PROVIDER="$(call $AAVE_POOL 'ADDRESSES_PROVIDER()(address)')"
check "Aave pool exposes an ADDRESSES_PROVIDER" yes "$([ -n "$PROVIDER" ] && echo yes)"
if [ -n "$PROVIDER" ]; then
  check "Aave provider.getPool() points back to the pool" "$AAVE_POOL" "$(call "$PROVIDER" 'getPool()(address)')"
  echo "INFO  Aave PoolAddressesProvider = $PROVIDER"
  echo "INFO  Compare it with AaveV3Arbitrum.POOL_ADDRESSES_PROVIDER in https://github.com/bgd-labs/aave-address-book"
fi
echo "INFO  Aave flash-loan premium (bps) = $(call $AAVE_POOL 'FLASHLOAN_PREMIUM_TOTAL()(uint128)')"
echo "INFO  Sushi factory = $(call $SUSHI_V2_ROUTER 'factory()(address)')  (compare with Sushi's official docs)"

echo; echo "Result: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
