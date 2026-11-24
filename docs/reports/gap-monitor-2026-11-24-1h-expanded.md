# Gap monitor report: expanded radar, one hour of Arbitrum One (2026-11-24)

`npm run monitor -- --minutes 60 --interval-ms 500` with `radar.config.json` (Uniswap V3 0.01/0.05/0.3/1% tiers,
PancakeSwap V3, SushiSwap; 10 tokens). Table transcribed from a screenshot of the tool's output; only rows with at least
one episode are listed in full. Zero-interest lenders: WETH (Balancer V2 / Uniswap V4), USDC (Uniswap V4).
Net = exact on-chain quote at that block (DEX fees and price impact included) - 10 bps safety reserve - estimated gas.

- Blocks: 527214753–527227051 (12,299 blocks), 6,855 polls every 500 ms, 0 errors
- Pools: 29 used of 91 found (pools under $50,000 TVL skipped as dead); pool pairs compared: 32

| Pool pair | Polls | Polls outside fee band | Episodes | Max excess (bps) | Longest episode (blocks) | Median episode (blocks) | Best est. net (USD) | Episodes with net > min profit |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| uniV3-100:WETH/USDC <> pcsV3-100:WETH/USDC | 6855 | 4388 | 50 | 10 | 649 | 94 | -0.34 | 0 |
| uniV3-3000:ARB/USDC <> uniV3-500x:ARB/USDC | 6855 | 82 | 1 | 7.6 | 161 | 161 | -3.09 | 0 |
| uniV3-100:WETH/USDC <> pcsV3-500:WETH/USDC | 6855 | 18 | 3 | 7.2 | 38 | 1 | -0.29 | 0 |
| uniV3-500:WETH/USDC <> uniV3-100:WETH/USDC | 6855 | 3 | 3 | 5.6 | 1 | 1 | -0.29 | 0 |
| pcsV3-100:WETH/USDC <> pcsV3-500:WETH/USDC | 6855 | 63 | 5 | 2.6 | 106 | 1 | -0.2 | 0 |
| uniV3-500:WETH/USDC <> pcsV3-500:WETH/USDC | 6855 | 51 | 5 | 2.4 | 86 | 1 | -0.19 | 0 |
| uniV3-3000:WETH/USDC <> uniV3-100:WETH/USDC | 6855 | 1 | 1 | 2.4 | 1 | 1 | -0.32 | 0 |
| uniV3-500:WETH/USDT <> pcsV3-100:WETH/USDT | 6855 | 2 | 1 | 1.8 | 7 | 7 | -0.42 | 0 |
| pcsV3-100:WETH/USDT <> pcsV3-500:WETH/USDT | 6855 | 96 | 2 | 1 | 153 | 153 | -0.45 | 0 |
| uniV3-3000:WETH/USDT <> pcsV3-100:WETH/USDT | 6855 | 1 | 1 | 0.9 | 1 | 1 | -0.47 | 0 |
| uniV3-3000:WETH/USDC <> pcsV3-100:WETH/USDC | 6855 | 2 | 2 | 0.6 | 1 | 1 | -0.21 | 0 |
| uniV3-500x:WBTC/WETH <> pcsV3-100:WBTC/WETH | 6855 | 1 | 1 | 0.4 | 1 | 1 | -0.12 | 0 |

The other 20 pool pairs never left their fee band (max excess between -1 and -70.3 bps), including USDC/USDT across
Uniswap and PancakeSwap, WBTC/WETH and WBTC/USDC across tiers, and LINK/WETH.

## Reading it

- **Much closer to break-even than before.** Across 32 pool pairs and 11 with episodes, the best estimated nets were
  between **-$0.12 and -$0.47** (one ARB/USDC outlier at -$3.09), versus -$2.09 / -$84.91 in the first radar hour.
- **The standout:** WETH/USDC between the Uniswap 0.01% and PancakeSwap 0.01% pools was outside its (2 bps) fee band
  64% of the time, in 50 episodes, median ~23 s and up to ~2.7 min, with excess up to 10 bps over the band.
- Still **no episode with a positive net** under these assumptions. The 10 bps safety reserve is of the same size as the
  remaining gap; see the follow-up run that reports the net before the reserve.
