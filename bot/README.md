# bot/

TypeScript (ethers v6) plug-in arbitrage bot. **Dry-run only**: this version has no code path that sends a transaction
(`DRY_RUN=false` is refused), and it never reads `PRIVATE_KEY`.

## Architecture

    strategies/*  ->  propose candidate routes          (crossDex, triangular, feeTier, newPoolScanner)
    core/profit   ->  best trade size + net profit      (out - in - flash fee - slippage reserve - gas)
    core/risk     ->  min profit, max gas, size cap, auto-pause after N consecutive failures
    core/simulator->  pre-send simulation (static call on a deployed contract; synthetic in sample mode)
    core/store    ->  JSONL log of every opportunity + per-strategy stats
    core/market   ->  SampleMarket (synthetic, seeded)  |  RpcMarket (read-only eth_call, cached, throttled)

Add a strategy: implement `Strategy` (`src/strategies/Strategy.ts`), register it in `registry.ts`, add a block in
`strategies.config.json` with `"enabled": true/false`.

## Run

    npm install
    npm test            # 23 unit tests
    npm run typecheck
    npm run dry-run -- --cycles 200 --seed 42            # synthetic data, no network
    npm run dry-run -- --source rpc --cycles 20          # needs ARBITRUM_RPC_URL in .env (read-only)

Output (git-ignored): `data/opportunities.<source>.local.jsonl`, `data/stats.<source>.local.json`.

## Read this before interpreting any number

- **Sample mode is synthetic.** Prices and spreads are random numbers I chose. Profits in sample mode only prove the code
  runs; they say nothing about real markets, and the "new pool" strategy in particular looks great there only because
  the synthetic world gives new pools large random mispricings.
- RPC mode and the static-call simulator have **not been run against a live network** in development (the sandbox had no
  access). Treat them as untested until you run them yourself.
- Gas is an estimate (`baseGasUnits`/`perStepGasUnits` in the config). Token/router addresses in the config are unverified.
- Free RPC tiers limit request rates: RPC mode caches per cycle, throttles calls (`minCallIntervalMs`) and polls every
  `POLL_INTERVAL_MS`. Scanning many routes will be slow on a free plan.

## Backtesting

    npm run gen-sample-dataset -- --snapshots 300 --seed 42    # SYNTHETIC dataset (pipeline test only)
    npm run collect -- --from-block <N> --to-block <M> --step 2000 --interval-ms 300   # REAL history (see below)
    npm run backtest -- --dataset data/dataset.rpc.local.jsonl --label real-report     # replay + Markdown/JSON report

How it works: `collect` records, per block, a *rate curve* (tokens out per token in at several USD sizes) for every
venue and direction. `backtest` replays those snapshots through the same engine the bot uses (same strategies,
profit calculator and risk engine). The report is written to `data/<label>.local.md` and `.local.json`.

**Real history needs your machine:** an archive-capable RPC (a free Alchemy account works for limited history) or a
local `anvil --fork-url <your RPC> --fork-block-number <N>` fork. Start with a tiny range (3 snapshots) to check your
rate limits, then widen it. `collect` and `RpcMarket` were not run against a live network during development.

**What the backtest can and cannot tell you:** it assumes every opportunity is filled at the recorded price, so it is an
upper bound; it cannot see competing bots or latency; `newPoolScanner` is not backtestable with this data format.
The generated report repeats these limitations automatically and flags synthetic data in a banner.

## Gap monitor ("radar")

    npm run monitor -- --minutes 60 --interval-ms 500 [--min-tvl-usd 50000] [--sizes 100,250,500,1000,5000]

Uses `radar.config.json` (which extends `strategies.config.json` with more tokens and venues: Uniswap V3 0.01% tier,
PancakeSwap V3 tiers, more SushiSwap pairs). Pools that do not exist are skipped; pools holding less than `--min-tvl-usd`
are skipped as "dead" (their price is stale and any trade moves it). Gaps are re-quoted when they widen.

Reads every configured pool in **one** `eth_call` per poll (Multicall3), compares each pair of pools that trade the same
two tokens, and records every moment their price gap is **outside the band the two pool fees allow** (the only moments
an arbitrage can exist). For gaps involving a borrowable token (WETH) it quotes the real round trip at that block and
computes the net result with the bot's profit calculator (zero-interest loan). Read-only; it never sends a transaction.

Output (git-ignored): `data/gaps.<time>.local.md` and `.json`, with per pool pair: polls outside the band, episodes,
maximum excess over the band (bps), longest/median episode in blocks, and the best estimated net profit.

Limits: polling every 500 ms sees roughly one Arbitrum block in two; gaps that live less than that can be missed.
Mid prices ignore depth, so "outside the band" is necessary but not sufficient for profit (the quote settles it).
