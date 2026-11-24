# Gap monitor report: expanded radar with "net before safety reserve" (2026-11-24)

Same setup as the expanded run (29 alive pools of 91, 32 pool pairs, zero-interest lenders), with two extra columns:
the trade size of the best quote, and the best net **before** the 10 bps slippage safety reserve (the quote itself is an
exact on-chain quote at that block, fees and price impact included). Output pasted unedited (rows with episodes only).

- Blocks: 527228609–527240071 (11,463 blocks), 5,608 polls every 500 ms, 1 error
- Trade sizes quoted: $100, $250, $500, $1000, $5000

| Pool pair | Polls | Polls outside fee band | Episodes | Max excess (bps) | Longest episode (blocks) | Median episode (blocks) | Best est. net (USD) | at size | Best net before safety reserve (USD) | Episodes > 0 before reserve | Episodes with net > min profit |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| uniV3-100:WETH/USDC <> pcsV3-100:WETH/USDC | 5608 | 2225 | 42 | 9.5 | 445 | 66 | -0.34 | $100 | -0.24 | 0 | 0 |
| pcsV3-100:WETH/USDC <> pcsV3-500:WETH/USDC | 5608 | 62 | 2 | 3.5 | 112 | 112 | -0.18 | $100 | -0.08 | 0 | 0 |
| uniV3-500:WETH/USDC <> pcsV3-100:WETH/USDC | 5608 | 296 | 5 | 2.9 | 262 | 103 | -0.18 | $100 | -0.08 | 0 | 0 |
| uniV3-500:WETH/USDC <> uniV3-100:WETH/USDC | 5608 | 261 | 3 | 2.8 | 265 | 150 | -0.32 | $100 | -0.22 | 0 | 0 |
| uniV3-500:WETH/USDT <> pcsV3-100:WETH/USDT | 5608 | 252 | 3 | 2.6 | 262 | 142 | -0.41 | $100 | -0.31 | 0 | 0 |
| uniV3-100:WETH/USDC <> pcsV3-500:WETH/USDC | 5608 | 47 | 2 | 2.4 | 57 | 57 | -0.33 | $100 | -0.23 | 0 | 0 |
| pcsV3-100:WETH/USDT <> pcsV3-500:WETH/USDT | 5608 | 105 | 2 | 1.3 | 159 | 159 | -0.44 | $100 | -0.34 | 0 | 0 |
| uniV3-500x:WBTC/WETH <> pcsV3-100:WBTC/WETH | 5608 | 7 | 1 | 0.2 | 13 | 13 | -0.12 | $100 | -0.02 | 0 | 0 |

The other 24 pool pairs never left their fee band (max excess from -1.7 to -102.4 bps).

## Reading it

- **Still no positive episode, even without the safety reserve.** Best: -$0.02 (WBTC/WETH), then -$0.08.
- **The best size was always the smallest ($100).** Larger trades lose more to price impact. With gaps of at most ~9.5 bps
  over the fee band, the gross edge on $100 is a few cents, about the same as gas (~$0.04 estimated). That is why these
  gaps can stay open for tens of seconds: nobody takes them because they are not worth taking.
- Conclusion after three hours of block-level monitoring on 91 pools across Uniswap V3, PancakeSwap V3 and SushiSwap,
  with zero-interest loans: two-pool arbitrage on these mainstream Arbitrum pairs did not produce a single profitable
  opportunity for a bot running on free infrastructure. The best case was within a few cents of break-even.
