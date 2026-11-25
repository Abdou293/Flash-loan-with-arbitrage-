import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "./config/dotenv.js";
import { loadConfig, loadEnv } from "./config/load.js";
import { RpcMarket } from "./core/market/RpcMarket.js";
import { SampleMarket } from "./core/market/SampleMarket.js";
import { RiskEngine } from "./core/risk.js";
import { QuoteOnlySimulator, SampleSimulator } from "./core/simulator.js";
import { Store } from "./core/store.js";
import type { MarketData, Opportunity, Step } from "./core/types.js";
import { Engine } from "./engine.js";
import { errorText, redact } from "./liquidations/rpc.js";

/**
 * Runs the bot in dry-run on SYNTHETIC data and writes the JSON file the dashboard displays.
 *   npm run export-dashboard                      -> ../dashboard/data/sample.json  (committed demo data)
 *   npm run export-dashboard -- --out live.json   -> ../dashboard/data/live.json    (git-ignored, local use)
 *
 * SHADOW MODE (real data): reads REAL Uniswap/Sushi quotes over your RPC (read-only eth_call) and runs the same
 * strategies, risk engine and profit maths. Nothing is ever sent. The file is rewritten after every cycle, so you can
 * leave it running and publish whenever you like:
 *   npm run export-dashboard -- --source rpc --interval-ms 60000      -> ../dashboard/data/arbitrage-shadow.json
 */
async function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const arg = (n: string, d: string) => {
    const i = process.argv.indexOf(`--${n}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
  };
  const source = arg("source", "sample"); // sample | rpc
  const real = source === "rpc";
  const cycles = Number(arg("cycles", real ? "100000" : "300"));
  const seed = Number(arg("seed", "42"));
  const intervalMs = Number(arg("interval-ms", "60000"));
  const outFile = join(root, "..", "dashboard", "data", arg("out", real ? "arbitrage-shadow.json" : "sample.json"));

  const config = loadConfig(join(root, arg("config", "strategies.config.json")));
  let market: MarketData;
  if (real) {
    const env = loadEnv();
    if (!env.rpcUrl) throw new Error("Set ARBITRUM_RPC_URL in .env for --source rpc");
    const lookup = (a: any, b: any): Step | undefined => {
      const v = config.venues.find((x) => x.pairs.includes(`${a.symbol}/${b.symbol}`) || x.pairs.includes(`${b.symbol}/${a.symbol}`));
      return v ? { venue: v, tokenIn: a, tokenOut: b } : undefined;
    };
    market = new RpcMarket({ rpcUrl: env.rpcUrl }, config.tokens, lookup);
  } else {
    market = new SampleMarket({ seed, tokenUsd: config.tokenUsd, venues: config.venues, tokens: config.tokens });
  }
  const store = new Store(null);
  const risk = new RiskEngine(config.risk);
  const engine = new Engine({
    config,
    market,
    simulator: real ? new QuoteOnlySimulator() : new SampleSimulator(seed),
    store,
    risk,
    dryRun: true,
  });

  const names = Object.keys(config.strategies);
  const cum: Record<string, number> = Object.fromEntries(names.map((n) => [n, 0]));
  const series: { cycle: number; cumNetUsd: Record<string, number | null> }[] = [];
  const all: Opportunity[] = [];
  let startedAt = new Date().toISOString();
  const r2 = (x: number) => Math.round(x * 100) / 100;

  // Shadow mode keeps going across restarts: earlier cycles are read back from the output file (use --fresh to start over).
  let cycleBase = 0;
  if (real && !process.argv.includes("--fresh") && existsSync(outFile)) {
    try {
      const prev = JSON.parse(readFileSync(outFile, "utf8"));
      if (String(prev?.meta?.dataSource ?? "").startsWith("rpc")) {
        for (const s of prev.strategies ?? []) {
          store.stats[s.name] = {
            routesEvaluated: s.routesEvaluated ?? 0,
            profitable: s.profitableBeforeRisk ?? 0,
            rejectedRisk: s.rejectedByRisk ?? 0,
            simulatedOk: s.simulatedOk ?? 0,
            simulatedRevert: s.simulatedRevert ?? 0,
            estimatedNetProfitUsd: s.estimatedNetProfitUsd ?? 0,
            bestNetProfitUsd: typeof s.bestNetProfitUsd === "number" ? s.bestNetProfitUsd : Number.NEGATIVE_INFINITY,
          };
        }
        series.push(...(prev.series ?? []));
        all.push(...[...(prev.recentOpportunities ?? [])].reverse());
        cycleBase = Number(prev.status?.cyclesRun ?? series[series.length - 1]?.cycle ?? 0);
        startedAt = prev.meta.startedAt ?? startedAt;
        console.log(`Resuming from ${outFile}: ${cycleBase} earlier cycles kept (pass --fresh to start over).`);
      }
    } catch {
      console.log("(could not read the previous file: starting fresh)");
    }
  }
  let errorsInARow = 0;

  const build = (cyclesRun: number) => {
    const ok = all.filter((o) => o.status === "simulated_ok");
    const reverted = all.filter((o) => o.status === "simulated_revert");
    const meta = real
      ? {
          dataSource: "rpc (real on-chain quotes, shadow mode)",
          startedAt,
          generatedAt: new Date().toISOString(),
          cycles: cyclesRun,
          seriesLabel: "Best net profit seen so far, per strategy (USD)",
          seriesHint:
            "Real quotes, after DEX fees, slippage reserve and estimated gas. Zero-interest lenders, so no loan fee. A value below $0 means no route has been profitable yet.",
          caveats: [
            "Shadow mode: real Uniswap/Sushi quotes read over RPC (read-only eth_call). No transaction is ever sent and no contract is deployed.",
            "Quote-only: the pre-send static-call simulation needs the deployed contract (testnet phase), so 'simulated' here means the quote said the route is profitable, nothing more.",
            "Gas is an estimate. Quotes are taken at different moments, so a route that looks profitable may not have been executable at one single block.",
            "Only the pools listed in strategies.config.json are checked. This says nothing about the rest of the market.",
            "A strategy that priced no route is shown as 'no data', not $0. newPoolScanner needs new-pool discovery, which is not implemented over RPC.",
          ],
          note: "Real on-chain quotes in shadow mode. Not a profit claim.",
        }
      : {
          dataSource: "synthetic",
          generatedAt: new Date().toISOString(),
          cycles: cyclesRun,
          seed,
          caveats: [
            "newPoolScanner dominates this chart ONLY because the synthetic generator gives brand-new pools large random mispricings (\u00b15%). Real new pools are mostly scams or illiquid, and this strategy is the riskiest of the four.",
            "The 'simulated failed' rows are random synthetic reverts, included to exercise the auto-pause logic.",
            "These numbers must not be read as a ranking of strategies. A real ranking needs a backtest on recorded on-chain data.",
          ],
          note: "Random prices generated to exercise the software. Not market history; not evidence of profitability.",
        };
    return {
      meta,
      status: { mode: real ? "shadow (dry-run)" : "dry-run", dryRun: true, paused: risk.paused, cyclesRun, liveExecutionAvailable: false },
      strategies: names.map((name) => {
        const st = store.stats[name];
        return {
          name,
          enabled: Boolean(config.strategies[name]?.enabled),
          routesEvaluated: st?.routesEvaluated ?? 0,
          profitableBeforeRisk: st?.profitable ?? 0,
          rejectedByRisk: st?.rejectedRisk ?? 0,
          simulatedOk: st?.simulatedOk ?? 0,
          simulatedRevert: st?.simulatedRevert ?? 0,
          estimatedNetProfitUsd: r2(st?.estimatedNetProfitUsd ?? 0),
          bestNetProfitUsd: st && Number.isFinite(st.bestNetProfitUsd) ? st.bestNetProfitUsd : null,
        };
      }),
      trades: { simulated: ok.length + reverted.length, simulatedSucceeded: ok.length, simulatedFailed: reverted.length, executed: 0 },
      gas: {
        estimatedGasOfSimulatedTradesUsd: r2(ok.reduce((a, o) => a + o.gasCostUsd, 0)),
        gasActuallySpentUsd: 0,
      },
      series: series.slice(-600), // keep the file small on long runs
      recentOpportunities: all.slice(-40).reverse(),
    };
  };
  const write = (cyclesRun: number) => {
    mkdirSync(dirname(outFile), { recursive: true });
    const tmp = outFile + ".tmp";
    writeFileSync(tmp, JSON.stringify(build(cyclesRun), null, 1));
    renameSync(tmp, outFile);
  };

  if (real) console.log(`SHADOW MODE: real quotes, read-only, nothing is sent. One cycle every ${intervalMs / 1000} s; writing ${outFile} after every cycle (Ctrl+C to stop).`);
  for (let i = 1; i <= cycles; i++) {
    const c = cycleBase + i; // cycle number, continuing from an earlier run when resuming
    let found: Opportunity[];
    try {
      found = await engine.runCycle();
      errorsInARow = 0;
    } catch (e) {
      // A free RPC times out now and then: one failed cycle must not end a day-long collection.
      if (!real) throw e;
      errorsInARow++;
      console.log(`cycle ${c}: skipped, RPC error: ${redact(errorText(e)).slice(0, 160)} (${errorsInARow} in a row; stops at 20)`);
      if (errorsInARow >= 20) throw e;
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }
    all.push(...found);
    for (const o of found) if (o.status === "simulated_ok") cum[o.strategy] = (cum[o.strategy] ?? 0) + o.netProfitUsd;
    if (real) {
      // null = this strategy priced no route (e.g. newPoolScanner has no new-pool discovery over RPC): shown as "no data", never as $0
      const best = (n: string) => {
        const v = store.stats[n]?.bestNetProfitUsd;
        return (store.stats[n]?.routesEvaluated ?? 0) > 0 && v !== undefined && Number.isFinite(v) ? r2(v) : null;
      };
      series.push({ cycle: c, cumNetUsd: Object.fromEntries(names.map((n) => [n, best(n)])) });
      write(c);
      const evaluated = names.reduce((a, n) => a + (store.stats[n]?.routesEvaluated ?? 0), 0);
      console.log(`cycle ${c}: ${found.length} candidate(s), ${evaluated} routes priced so far. Best net so far: ` + names.map((n) => (best(n) === null ? `${n} no data` : `${n} $${best(n)}`)).join(", "));
      if (evaluated === 0) console.log("  WARNING: no route could be priced yet. Check ARBITRUM_RPC_URL and that the pools in strategies.config.json exist. A '$0' above does NOT mean break-even here.");
      if (i < cycles) await new Promise((r) => setTimeout(r, intervalMs));
    } else if (c % 5 === 0 || i === cycles) {
      series.push({ cycle: c, cumNetUsd: Object.fromEntries(names.map((n) => [n, r2(cum[n] ?? 0)])) });
    }
  }
  if (!real) write(cycles);
  console.log(`wrote ${outFile} (${Math.min(40, all.length)} recent opportunities, ${series.length} chart points)`);
}
main();
