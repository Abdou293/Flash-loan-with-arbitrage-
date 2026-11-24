# Backtest report: Arbitrum One, ~24 hours of real data

Produced on 2026-11-24 with `npm run collect` + `npm run backtest` on the author's machine (Ubuntu on WSL2, free Alchemy RPC).
The table below is the tool's output, pasted unedited.

- Data source: `rpc-archive` (real on-chain quotes: Uniswap QuoterV2 / SushiSwap `getAmountsOut`, recorded per block)
- Snapshots replayed: 48 (blocks 526627702–526966102), one every 7,200 blocks (about 30 minutes), 26 price curves each
- Measured gas price during the window: about 0.020 gwei
- Collection time: 32 minutes on the free tier (about 40 s per snapshot)
- Config at the time: trade sizes $1k / $5k / $25k (the $100k size is above the $50k risk cap), Aave premium 5 bps,
  slippage reserve 10 bps, minimum net profit $1

| Strategy | Routes evaluated | Profitable before risk | Passed risk | Snapshots with an opportunity | Est. net profit (USD) | Best (USD) | Median (USD) | Closest to break-even (USD) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| crossDex | 768 | 0 | 0 | 0 | 0 | - | - | -63.97 |
| triangular | 1728 | 0 | 0 | 0 | 0 | - | - | -15.69 |
| feeTier | 480 | 0 | 0 | 0 | 0 | - | - | -2.51 |
| newPoolScanner | 0 | 0 | 0 | 0 | 0 | - | - | - |

## Reading it

- **No profitable opportunity** in 2,976 evaluated routes. Every round trip lost money once the flash-loan premium, DEX fees,
  price impact, slippage reserve and gas were counted.
- **feeTier came closest** (best route about $2.51 short of break-even), then triangular, then crossDex. The SushiSwap legs of
  crossDex routes suffer from thinner liquidity on Arbitrum, so price impact dominates.
- A 3-snapshot pilot run the same day showed the same ordering (-4.03 / -17.23 / -66.35).

## Limitations

- Snapshots are taken every ~30 minutes. Gaps that open and close within seconds (which is where real arbitrage lives, and
  where faster bots compete) are invisible to this sampling. "Zero" here means "none that persisted at sample time".
- Results are an upper bound: fills at the recorded quote, no competing bots, no latency.
- `newPoolScanner` cannot be backtested with this dataset format.
- One day of data, a fixed set of 13 pairs/venues, and fixed trade sizes.

## Re-run with a zero-fee lender (Balancer V2 Vault)

Same 48 snapshots, replayed with `--flash-fee-bps 0` (the Balancer V2 Vault charged no flash-loan fee on Arbitrum when
checked on-chain on 2026-11-24). Output pasted unedited:

- Flash-loan fee assumed: 0 bps (Balancer V2 Vault, zero fee)

| Strategy | Routes evaluated | Profitable before risk | Passed risk | Snapshots with an opportunity | Est. net profit (USD) | Best (USD) | Median (USD) | Closest to break-even (USD) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| crossDex | 768 | 0 | 0 | 0 | 0 | - | - | -63.47 |
| triangular | 1728 | 0 | 0 | 0 | 0 | - | - | -15.19 |
| feeTier | 480 | 0 | 0 | 0 | 0 | - | - | -2.01 |
| newPoolScanner | 0 | 0 | 0 | 0 | 0 | - | - | - |

Every "closest to break-even" value improved by exactly $0.50, which is the 5 bps Aave premium on a $1,000 trade: the
routes that came closest were all at the smallest trade size. Removing the loan fee did not make any route profitable.

Why: on the closest route (WETH -> USDC on the 0.05% pool, back on the 0.30% pool), the two pool fees alone cost about
0.35% of the trade. Arbitrage keeps the price gap between two pools inside that fee band, so a sample taken at a random
moment almost always finds a gap smaller than the fees. Profit exists only in the short moment right after a large swap
pushes a pool outside the band, and it goes to whoever acts first.
