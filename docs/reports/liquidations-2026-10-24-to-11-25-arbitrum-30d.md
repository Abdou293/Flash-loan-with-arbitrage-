# Aave V3 liquidations on Arbitrum One, 30 days (2026-10-24 to 2026-11-25, real data)

Produced by `npm run liquidations -- --days 30 --logs-rpc-url https://arb1.arbitrum.io/rpc --sample-hf 60` on the owner's
machine, read-only (2,024 RPC calls, 0 retries). Logs came from the public Arbitrum RPC, prices and borrower states from a free
Alchemy RPC. Everything from "Per day" to "Limitations" is the tool's output, pasted unedited; the section
"Reading it (analyst notes)" at the end is mine and is labelled as such.

- Aave V3 Pool: `0x794a61358D6845594F94dc1DB02A252b5b4814aD` (verified on-chain by `scripts/verify-addresses.sh`)
- Blocks: 517691982–527291982 (9600001 blocks), 2026-10-24T14:16:24.000Z to 2026-11-25T02:13:20.000Z (first and last event)
- Liquidation events found: **1031**
- Generated: 2026-11-25T02:25:22.590Z
- Log scan: 177 getLogs requests, 0 range errors, final chunk 50000 blocks

## Per day (UTC)

| Day | Liquidations | Debt repaid (USD) | Median size | Largest | Median bonus | Gross bonus total (USD) | Distinct liquidators |
|---|---:|---:|---:|---:|---:|---:|---:|
| 2026-10-24 | 12 | $16,502 | $866 | $5,418 | 4.50% | $805 | 4 |
| 2026-10-25 | 4 | $62 | $2 | $54 | 4.50% | $3 | 2 |
| 2026-10-26 | 3 | $117 | $40 | $74 | 4.50% | $5 | 3 |
| 2026-10-27 | 5 | $80 | $2 | $74 | 4.50% | $4 | 4 |
| 2026-10-28 | 1 | $4 | $4 | $4 | 4.50% | $0 | 1 |
| 2026-10-29 | 26 | $41,372 | $7 | $30,968 | 4.50% | $1,862 | 7 |
| 2026-10-30 | 41 | $50,384 | $1 | $23,828 | 4.50% | $3,356 | 8 |
| 2026-10-31 | 1 | $2 | $2 | $2 | 4.50% | $0 | 1 |
| 2026-11-02 | 2 | $2 | $1 | $1 | 4.50% | $0 | 2 |
| 2026-11-04 | 4 | $685 | $30 | $598 | 9.00% | $61 | 2 |
| 2026-11-05 | 4 | $5,786 | $1,239 | $2,703 | 4.50% | $270 | 3 |
| 2026-11-06 | 6 | $112 | $1 | $108 | 4.50% | $7 | 2 |
| 2026-11-07 | 1 | $2 | $2 | $2 | 4.50% | $0 | 1 |
| 2026-11-08 | 25 | $188,704 | $1,166 | $99,543 | 4.50% | $8,667 | 7 |
| 2026-11-09 | 18 | $12,301 | $6 | $3,695 | 4.50% | $562 | 6 |
| 2026-11-10 | 46 | $167,972 | $653 | $41,724 | 4.50% | $8,004 | 9 |
| 2026-11-11 | 3 | $21,194 | $1 | $21,192 | 4.50% | $1,907 | 3 |
| 2026-11-12 | 14 | $20,108 | $321 | $8,197 | 4.50% | $1,059 | 5 |
| 2026-11-13 | 56 | $190,803 | $1,317 | $49,713 | 6.30% | $11,139 | 6 |
| 2026-11-14 | 164 | $599,893 | $1,191 | $56,709 | 4.50% | $30,445 | 15 |
| 2026-11-15 | 43 | $335,058 | $1,081 | $224,096 | 4.50% | $16,427 | 13 |
| 2026-11-16 | 5 | $50 | $7 | $20 | 4.50% | $2 | 1 |
| 2026-11-17 | 12 | $4,223 | $1 | $4,144 | 4.50% | $190 | 4 |
| 2026-11-18 | 6 | $2,008 | $12 | $1,572 | 4.50% | $119 | 4 |
| 2026-11-19 | 15 | $6,858 | $0 | $2,776 | 4.50% | $432 | 3 |
| 2026-11-20 | 269 | $514,107 | $153 | $31,960 | 4.50% | $28,673 | 16 |
| 2026-11-21 | 233 | $692,352 | $70 | $166,693 | 4.50% | $40,998 | 20 |
| 2026-11-22 | 3 | $31 | $9 | $20 | 4.50% | $2 | 2 |
| 2026-11-23 | 3 | $2,794 | $1 | $2,792 | 4.50% | $126 | 2 |
| 2026-11-24 | 4 | $1,674 | $10 | $1,619 | 4.50% | $76 | 3 |
| 2026-11-25 | 2 | $3,606 | $1 | $3,605 | 4.50% | $162 | 2 |

Size: median $264, 90th percentile $5,792. Bonus measured at oracle prices: median 4.50%, 10th–90th percentile 4.50%–6.30% (gross of Aave's protocol fee on the bonus, so what a liquidator keeps is a bit lower).

## How big is the prize? (gross bonus per liquidation, before swap costs, gas and loan fees)

| Gross bonus | Liquidations | Share |
|---|---:|---:|
| < $1 | 401 | 39% |
| $1 - $5 | 70 | 7% |
| $5 - $20 | 69 | 7% |
| $20 - $100 | 257 | 25% |
| $100 or more | 234 | 23% |

Whole market, all liquidators together: gross bonus of **$155,363** over about 30.0 day(s) (about $5,179 per day) before swap costs, gas and loan fees; the 3 largest liquidations made up 16% of it.

## Assets

| Debt asset | Liquidations | Debt repaid (USD) |
|---|---:|---:|
| USDC | 741 | $2,399,944 |
| USD₮0 | 127 | $390,411 |
| DAI | 74 | $45,296 |
| LUSD | 43 | $5,356 |
| EURS | 22 | $338 |
| WETH | 11 | $30,564 |

| Collateral asset | Liquidations | Collateral value (USD) |
|---|---:|---:|
| WETH | 573 | $1,630,187 |
| WBTC | 249 | $1,046,899 |
| USDC | 81 | $12,671 |
| wstETH | 43 | $237,143 |
| DAI | 27 | $235 |
| USD₮0 | 21 | $5,141 |

## Who liquidates

54 distinct liquidator address(es); the top 3 took 73% of all liquidations.

| Liquidator | Liquidations | Share | Debt repaid (USD) |
|---|---:|---:|---:|
| `0xd12810b19b596347a3afac206d3ca65d08594b3f` | 403 | 39% | $1,662,816 |
| `0x5ac9bc14376bf2727c6211960cf3cec1e2f295bd` | 309 | 30% | $343,846 |
| `0x9fbd5e5fa2a0f8076cb19ec813d3abc6ebee3f8d` | 41 | 4% | $280,713 |
| `0x9355ec6d797b6c8b73de9b52fffdb3bfa6d05fdb` | 27 | 3% | $1,321 |
| `0x0dc76a8cdc8194e2ed4810e729cea63d4b864104` | 23 | 2% | $8,052 |

## How fast are liquidations taken? (sample)

For 73 sampled liquidations the borrower's health factor was read at past blocks (state at the end of each block) to find the first block from which the position
stayed liquidatable (health factor < 1) until it was liquidated. "0 blocks" means it became liquidatable inside the liquidation block itself
(typically an oracle price update followed by the bot in the same block). On Arbitrum one block is about 0.25 s.

| Measure | Value |
|---|---:|
| Samples used (clean) | 73 |
| Liquidations not sampled: same borrower already liquidated within 20000 blocks (partial liquidations) | 52 |
| Failed to read (RPC error / archive state unavailable) | 0 |
| Same block (0 blocks) | 74% |
| Within 2 blocks (about 0.5 s) | 81% |
| Within 10 blocks (about 2.5 s) | 82% |
| Median delay (blocks) | 0 |
| 90th percentile delay (blocks) | 19293 |
| Still liquidatable at the 20000-block lookback limit (delay is a lower bound) | 7 |

### Speed by prize size (clean samples)

| Gross bonus | Samples | Within 2 blocks | Median delay (blocks) | At lookback limit |
|---|---:|---:|---:|---:|
| < $1 | 25 | 48% | 5 | 6 |
| $1 - $5 | 7 | 100% | 0 | 0 |
| $5 - $20 | 5 | 100% | 0 | 0 |
| $20 - $100 | 19 | 95% | 0 | 1 |
| $100 or more | 17 | 100% | 0 | 0 |

## Verdict: CROWDED

81% of the sampled liquidations (73 clean samples) happened within 2 block(s) of the position becoming liquidatable (median 0 block(s), 74% in the very same block). 54 distinct liquidator address(es) in the period, the top 3 took 73% of all liquidations. Weighted by gross bonus, 100% of the sampled prize was taken within 2 blocks. 13 sampled liquidation(s) waited more than 10 blocks; their median gross bonus was $0.02 against $56.00 for the instant ones, and together they carry 0% of the sampled gross bonus (the slow ones are the small ones: positions too small to pay for gas and swaps may simply be left alone). Professional bots take essentially every liquidation worth taking immediately, usually in the same block as the price update that triggers it. A bot running on a free RPC and a laptop cannot realistically be first. Treat a liquidation bot as a **portfolio project, not a profit source**.

Rule used: "crowded" when at least 70% of clean samples are within 2 blocks and there are at least 10 samples. These thresholds are my rule of thumb, not a law.

## Limitations

- The delay is measured on a **sample** of liquidations, and with the borrower's state at block granularity; it cannot see transactions that were sent but lost the race.
- A liquidation that happens in the very same block as the price update shows as 0 blocks: it proves the liquidator reacted immediately, not who it was.
- Prices come from the oracle currently registered in the Aave address provider, queried at each event's block; events from before that oracle existed have no price.
- "Gross bonus" ignores the cost of swapping the collateral back, gas and any flash-loan fee, so it overstates what a bot would keep.
- This is a measurement of the past; it says nothing about positions that will become liquidatable tomorrow.

## Reading it (analyst notes, not tool output)

- **The prize comes in bursts.** Seven days (Nov 8, 10, 13, 14, 15, 20, 21) produced $144,353 of the month's $155,363 gross
  bonus (92.9%, summed from the per-day table above). The first 3-day report (about $122/day) happened to cover calm days only,
  which is why a longer window mattered.
- **Speed does not depend on luck, it depends on size.** Every sampled liquidation with a gross bonus of $1 or more was taken
  within 2 blocks, except one in the $20–$100 bucket that was still liquidatable at the 20,000-block lookback limit. That single
  case is worth inspecting individually (asset pair, liquidity of the collateral) but one case is not an opening.
- **Concentrated competition.** One address took 39% of the liquidations and repaid $1.66M of debt; the top 3 took 73%.
- **Conclusion.** Liquidations on Aave V3 Arbitrum are a real market (about $155k of gross bonus in 30 days) but every
  liquidation worth taking is taken in the same block as the price update. A free-RPC laptop bot would not be first; a
  liquidation module in this project is a portfolio piece, not a profit source.

## Addendum: focus on the hard-to-source debt assets (LUSD, EURS)

Run on the same 30-day range with `--focus-debt LUSD,EURS` (18 extra liquidations measured besides the random sample). These
measurements are kept out of the verdict above. Table pasted unedited from the tool's output:

| Debt asset | Liquidations | Measured | Within 2 blocks | Median delay (blocks) | At lookback limit | Waited > 10 blocks: gross bonus | Gross bonus, all | Distinct liquidators | Not measured (repeat / failed) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| LUSD | 43 | 15 | 53% | 2 | 6 | $194.26 | $272.31 | 6 | 28 / 0 |
| EURS | 22 | 6 | 17% | 1086 | 3 | $11.58 | $15.21 | 7 | 16 / 0 |

### Reading it (analyst notes, not tool output)

- **The hypothesis is supported in direction.** Liquidations with these debt assets wait much longer than the rest: 53% (LUSD)
  and 17% (EURS) were taken within 2 blocks, against 81% overall and 100% of those with a gross bonus of $1 or more. EURS had a
  median wait of 1,086 blocks (about 5 minutes). Most of the money of these two assets sat in the slow liquidations: $194.26
  of $272.31 (71%) for LUSD and $11.58 of $15.21 (76%) for EURS.
- **But the whole niche is tiny.** All 65 liquidations of both assets paid $287.52 of gross bonus in 30 days (about $9.6 a
  day); the part that waited more than 10 blocks was $205.84 (about $6.9 a day), before gas, swap costs and any financing.
- **Most events were not measured.** 28 of 43 LUSD and 16 of 22 EURS liquidations are repeats (the same borrower liquidated again
  within 20,000 blocks, i.e. a series of partial liquidations), which the delay measurement skips because the position
  stays liquidatable between them by definition. So the table describes the first liquidation of each series (15 and 6 cases).
- **Getting the debt asset is the real obstacle.** The zero-interest lenders used by this project were not checked for LUSD or
  EURS and are unlikely to hold them in size; a liquidator would have to buy the asset first, with slippage, which the gross
  bonus figures above do not include.
- **Conclusion.** The slow liquidations are real and are concentrated in hard-to-source debt assets, but they are worth about
  $7 a day gross in total. This does not change the verdict: a liquidation bot here is a portfolio project, not a profit source.
