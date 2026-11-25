# dashboard/

Static, dependency-free dashboard (HTML + CSS + vanilla JS). No wallet, no keys, no backend.
The published site reads **only real shadow-mode data**: `data/arbitrage-shadow.json` (module 1) and `data/shadow.json` (module 2). On localhost it also falls back to `data/live.json` and the synthetic demo file `data/sample.json`, which is labelled as synthetic.

## Run locally

    cd dashboard
    npx serve .            # or: python3 -m http.server 8080

(Opening `index.html` by double-click will not work: browsers block `fetch` on `file://`.)

## Refresh the data

    cd bot
    npm run export-dashboard                       # regenerates dashboard/data/sample.json (SYNTHETIC demo data)
    npm run export-dashboard -- --out live.json    # local-only file, git-ignored

## Deploy on Vercel (free)

Import the GitHub repo, set **Root Directory** to `dashboard`, framework preset **Other**, no build command. Done.

## What the numbers mean

The committed `sample.json` is **synthetic**: random prices produced to exercise the software. The banner at the top of the
page says so whenever `meta.dataSource` is `synthetic`. "Executed trades" is always 0 because this version has no
code path that sends transactions; "gas actually spent" is therefore $0, and the gas figure for simulated trades is an estimate.

## Module 2: liquidation monitor (real data, shadow mode)

The section at the top of the page reads `data/shadow.json`, produced from real Aave V3 reads on Arbitrum:

    cd bot
    npm run liq-watch -- --discover-blocks 20000 --interval-s 60     # leave running for hours (read-only, dry-run)
    npm run export-shadow                                            # writes dashboard/data/shadow.json

Without that file the section says no data has been published yet. Nothing in it is simulated: every row comes from
`getUserAccountData` at a real block. The profit figure is an estimate and the page says so. This tool has no wallet.

## Module 1: arbitrage in shadow mode (real quotes)

    cd bot
    npm run export-dashboard -- --source rpc --interval-ms 60000     # leave running; rewrites dashboard/data/arbitrage-shadow.json every cycle

It reads real DEX quotes over your RPC (read-only) and runs the same strategies, profit maths and risk limits. The chart
shows the best net profit seen so far per strategy: a value below $0 means no route has been profitable yet. Nothing is sent.
