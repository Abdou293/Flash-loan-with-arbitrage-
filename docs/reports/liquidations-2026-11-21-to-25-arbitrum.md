# Aave V3 liquidations on Arbitrum One, 2026-11-21 to 2026-11-25 (real data)

Produced by `npm run liquidations` on the owner's machine, read-only. Logs were read from the public Arbitrum RPC
(`--logs-rpc-url https://arb1.arbitrum.io/rpc`: 22 `eth_getLogs` requests of up to 50,000 blocks), prices and borrower
states from a free Alchemy RPC (120 RPC calls in total). The report was generated twice from the same cached data: the
first time by the original generator, the second time after the report gained the "speed by prize size" table and a
value-weighted verdict. Tables below are pasted unedited from those two outputs; nothing else was changed.

- Aave V3 Pool: `0x794a61358D6845594F94dc1DB02A252b5b4814aD` (verified on-chain by `scripts/verify-addresses.sh`)
- Blocks: 526328740–527288740 (960,001 blocks, about 3.0 days); first and last event 2026-11-21T20:36:30Z, 2026-11-25T01:33:09Z
- Liquidation events found: **14** (all priced with the Aave oracle at their own block)

## Per day (UTC)

| Day | Liquidations | Debt repaid (USD) | Median size | Largest | Median bonus | Gross bonus total (USD) | Distinct liquidators |
|---|---:|---:|---:|---:|---:|---:|---:|
| 2026-11-21 | 3 | $1 | $0 | $0 | 4.50% | $0 | 1 |
| 2026-11-22 | 3 | $31 | $9 | $20 | 4.50% | $2 | 2 |
| 2026-11-23 | 3 | $2,794 | $1 | $2,792 | 4.50% | $126 | 2 |
| 2026-11-24 | 4 | $1,674 | $10 | $1,619 | 4.50% | $76 | 3 |
| 2026-11-25 | 1 | $3,605 | $3,605 | $3,605 | 4.50% | $162 | 1 |

Size: median $3, 90th percentile $2,792. Bonus measured at oracle prices: median 4.50%, 10th–90th percentile 4.50%–6.30%
(gross of Aave's protocol fee on the bonus).

## How big is the prize? (gross bonus per liquidation, before swap costs, gas and loan fees)

| Gross bonus | Liquidations | Share |
|---|---:|---:|
| < $1 | 9 | 64% |
| $1 - $5 | 2 | 14% |
| $5 - $20 | 0 | 0% |
| $20 - $100 | 1 | 7% |
| $100 or more | 2 | 14% |

Whole market, all liquidators together: gross bonus of **$366** over about 3.0 day(s) (about $122 per day) before swap costs,
gas and loan fees; the 3 largest liquidations made up 99% of it.

## Assets

| Debt asset | Liquidations | Debt repaid (USD) |
|---|---:|---:|
| USDC | 9 | $4,480 |
| GHO | 2 | $1 |
| USD₮0 | 2 | $3,625 |
| DAI | 1 | $0 |

| Collateral asset | Liquidations | Collateral value (USD) |
|---|---:|---:|
| USDC | 6 | $27 |
| WETH | 5 | $8,377 |
| WBTC | 2 | $67 |
| USD₮0 | 1 | $0 |

## Who liquidates

6 distinct liquidator address(es); the top 3 took 79% of all liquidations.

| Liquidator | Liquidations | Share | Debt repaid (USD) |
|---|---:|---:|---:|
| `0x5ac9bc14376bf2727c6211960cf3cec1e2f295bd` | 6 | 43% | $25 |
| `0x47cd29c2b1054f2b68ee9edd3a7f69877e7ea22c` | 3 | 21% | $1 |
| `0x68b570cd9c2e976a85246e41a42adba8fa349c32` | 2 | 14% | $3,648 |
| `0xf399972cff76e258175e4fc9e2f5cc24bebd0cc1` | 1 | 7% | $20 |
| `0xd12810b19b596347a3afac206d3ca65d08594b3f` | 1 | 7% | $2,792 |

## How fast are liquidations taken? (all 14 measured)

| Measure | Value |
|---|---:|
| Samples used (clean) | 14 |
| Liquidations not sampled: same borrower already liquidated within 20000 blocks (partial liquidations) | 0 |
| Failed to read (RPC error / archive state unavailable) | 0 |
| Same block (0 blocks) | 79% |
| Within 2 blocks (about 0.5 s) | 79% |
| Within 10 blocks (about 2.5 s) | 79% |
| Median delay (blocks) | 0 |
| 90th percentile delay (blocks) | 20000 |
| Still liquidatable at the 20000-block lookback limit (delay is a lower bound) | 3 |

### Speed by prize size (clean samples)

| Gross bonus | Samples | Within 2 blocks | Median delay (blocks) | At lookback limit |
|---|---:|---:|---:|---:|
| < $1 | 9 | 67% | 0 | 3 |
| $1 - $5 | 2 | 100% | 0 | 0 |
| $5 - $20 | 0 | - | - | 0 |
| $20 - $100 | 1 | 100% | 0 | 0 |
| $100 or more | 2 | 100% | 0 | 0 |

## Verdict: CROWDED

79% of the sampled liquidations (14 clean samples) happened within 2 block(s) of the position becoming liquidatable (median 0
block(s), 79% in the very same block). 6 distinct liquidator address(es) in the period, the top 3 took 79% of all
liquidations. Weighted by gross bonus, 100% of the sampled prize was taken within 2 blocks. 3 sampled liquidation(s) waited
more than 10 blocks; their median gross bonus was $0.01 against $0.46 for the instant ones, and together they carry 0% of the
sampled gross bonus (the slow ones are the small ones: positions too small to pay for gas and swaps may simply be left
alone). Professional bots take essentially every liquidation worth taking immediately, usually in the same block as the
price update that triggers it. A bot running on a free RPC and a laptop cannot realistically be first. Treat a liquidation
bot as a **portfolio project, not a profit source**.

Rule used: "crowded" when at least 70% of clean samples are within 2 blocks and there are at least 10 samples. These
thresholds are my rule of thumb, not a law.

## Limitations

- Three calm days and 14 liquidations: a small sample. Liquidations cluster in market crashes, which this window did not
  contain; competition is expected to be even stronger then.
- The delay is measured with the borrower's state at block granularity; it cannot see transactions that were sent but lost
  the race.
- "Gross bonus" ignores the cost of swapping the collateral back, gas and any flash-loan fee, so it overstates what a bot
  would keep.
- This is a measurement of the past; it says nothing about positions that will become liquidatable tomorrow.
