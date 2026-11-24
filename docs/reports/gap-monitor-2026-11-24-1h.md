# Gap monitor report: one hour of Arbitrum One (2026-11-24)

Produced with `npm run monitor -- --minutes 60 --interval-ms 500` on the author's machine (free Alchemy RPC).
One `eth_call` (Multicall3) per poll; block numbers are Arbitrum L2 blocks (about 0.25 s each). The table is the tool's
output, pasted unedited. Lender: Balancer V2 (zero-interest), so only WETH is borrowable; "(hyp.)" marks a quote that
would need a token the lender cannot supply.

- Blocks: 527184943–527197622 (12680 blocks), 6893 polls every 500 ms, 0 errors
- Trade sizes quoted when a gap opened: $100, $250, $500, $1000, $5000

| Pool pair | Polls | Polls outside fee band | Episodes | Max excess (bps) | Longest episode (blocks) | Median episode (blocks) | Best est. net (USD) | Episodes with net > min profit |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| uniV3-3000:ARB/USDC <> sushiV2-3000:ARB/USDC | 6893 | 6635 | 1 | 70.5 | 12193 | 12193 | -84.91 (hyp.) | 0 |
| uniV3-500:WETH/USDC <> sushiV2-3000:WETH/USDC | 6893 | 421 | 5 | 12.9 | 364 | 119 | -2.09 | 0 |
| uniV3-500:WETH/USDT <> sushiV2-3000:WETH/USDT | 6893 | 304 | 5 | 10.1 | 334 | 52 | -0.77 | 0 |
| uniV3-500:WETH/USDT <> uniV3-3000:WETH/USDT | 6893 | 0 | 0 | -5.6 | 0 | 0 | - | 0 |
| uniV3-500:WETH/USDC <> uniV3-3000:WETH/USDC | 6893 | 0 | 0 | -8.4 | 0 | 0 | - | 0 |
| uniV3-10000:ARB/USDC <> sushiV2-3000:ARB/USDC | 6893 | 0 | 0 | -29.2 | 0 | 0 | - | 0 |
| uniV3-3000:ARB/WETH <> sushiV2-3000:ARB/WETH | 6893 | 0 | 0 | -36.6 | 0 | 0 | - | 0 |
| uniV3-3000:WETH/USDC <> sushiV2-3000:WETH/USDC | 6893 | 0 | 0 | -37.8 | 0 | 0 | - | 0 |
| uniV3-3000:ARB/USDC <> uniV3-10000:ARB/USDC | 6893 | 0 | 0 | -39.4 | 0 | 0 | - | 0 |
| uniV3-3000:WETH/USDT <> sushiV2-3000:WETH/USDT | 6893 | 0 | 0 | -40.8 | 0 | 0 | - | 0 |
| uniV3-500:WETH/USDC <> uniV3-10000:WETH/USDC | 6893 | 0 | 0 | -64.4 | 0 | 0 | - | 0 |
| uniV3-10000:WETH/USDC <> sushiV2-3000:WETH/USDC | 6893 | 0 | 0 | -100.9 | 0 | 0 | - | 0 |
| uniV3-3000:WETH/USDC <> uniV3-10000:WETH/USDC | 6893 | 0 | 0 | -106.7 | 0 | 0 | - | 0 |

## Reading it

- **Deep pools never left the fee band** (Uniswap tier vs Uniswap tier, all hour, at 2-block resolution).
- **Gaps that did leave the band were in thin pools.** The SushiSwap ARB/USDC pool sat 70 bps outside the band for ~50
  minutes, yet the best quote lost $84.91: the pool is close to empty, so its "price" is stale and any trade moves it.
  The SushiSwap WETH/USDC and WETH/USDT gaps (up to ~13 bps, lasting up to ~90 s) also quoted negative after price impact.
- In short: where there is liquidity there is no gap, and where there is a gap there is not enough liquidity to profit.
- Limits: polls every 500 ms (about one block in two); quotes are taken when an episode opens, not at its peak;
  13 pool pairs on 3 venues only.
