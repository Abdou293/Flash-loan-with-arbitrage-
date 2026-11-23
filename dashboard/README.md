# dashboard/

Static, dependency-free dashboard (HTML + CSS + vanilla JS). No wallet, no keys, no backend.
It reads `data/live.json` if present (local, git-ignored), otherwise the committed demo file `data/sample.json`.

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
