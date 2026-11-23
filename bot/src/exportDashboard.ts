import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config/load.js";
import { SampleMarket } from "./core/market/SampleMarket.js";
import { RiskEngine } from "./core/risk.js";
import { SampleSimulator } from "./core/simulator.js";
import { Store } from "./core/store.js";
import type { Opportunity } from "./core/types.js";
import { Engine } from "./engine.js";

/**
 * Runs the bot in dry-run on SYNTHETIC data and writes the JSON file the dashboard displays.
 *   npm run export-dashboard                      -> ../dashboard/data/sample.json  (committed demo data)
 *   npm run export-dashboard -- --out live.json   -> ../dashboard/data/live.json    (git-ignored, local use)
 */
async function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const arg = (n: string, d: string) => {
    const i = process.argv.indexOf(`--${n}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
  };
  const cycles = Number(arg("cycles", "300"));
  const seed = Number(arg("seed", "42"));
  const outFile = join(root, "..", "dashboard", "data", arg("out", "sample.json"));

  const config = loadConfig(join(root, "strategies.config.json"));
  const market = new SampleMarket({ seed, tokenUsd: config.tokenUsd, venues: config.venues, tokens: config.tokens });
  const store = new Store(null);
  const risk = new RiskEngine(config.risk);
  const engine = new Engine({ config, market, simulator: new SampleSimulator(seed), store, risk, dryRun: true });

  const names = Object.keys(config.strategies);
  const cum: Record<string, number> = Object.fromEntries(names.map((n) => [n, 0]));
  const series: { cycle: number; cumNetUsd: Record<string, number> }[] = [];
  const all: Opportunity[] = [];
  for (let c = 1; c <= cycles; c++) {
    const found = await engine.runCycle();
    all.push(...found);
    for (const o of found) if (o.status === "simulated_ok") cum[o.strategy] = (cum[o.strategy] ?? 0) + o.netProfitUsd;
    if (c % 5 === 0 || c === cycles) series.push({ cycle: c, cumNetUsd: Object.fromEntries(names.map((n) => [n, Math.round((cum[n] ?? 0) * 100) / 100])) });
  }

  const ok = all.filter((o) => o.status === "simulated_ok");
  const reverted = all.filter((o) => o.status === "simulated_revert");
  const data = {
    meta: {
      dataSource: "synthetic",
      generatedAt: new Date().toISOString(),
      cycles,
      seed,
      caveats: [
        "newPoolScanner dominates this chart ONLY because the synthetic generator gives brand-new pools large random mispricings (±5%). Real new pools are mostly scams or illiquid, and this strategy is the riskiest of the four.",
        "The 'simulated failed' rows are random synthetic reverts, included to exercise the auto-pause logic.",
        "These numbers must not be read as a ranking of strategies. A real ranking needs a backtest on recorded on-chain data.",
      ],
      note: "Random prices generated to exercise the software. Not market history; not evidence of profitability.",
    },
    status: {
      mode: "dry-run",
      dryRun: true,
      paused: risk.paused,
      cyclesRun: cycles,
      liveExecutionAvailable: false,
    },
    strategies: names.map((name) => {
      const s = store.stats[name];
      return {
        name,
        enabled: Boolean(config.strategies[name]?.enabled),
        routesEvaluated: s?.routesEvaluated ?? 0,
        profitableBeforeRisk: s?.profitable ?? 0,
        rejectedByRisk: s?.rejectedRisk ?? 0,
        simulatedOk: s?.simulatedOk ?? 0,
        simulatedRevert: s?.simulatedRevert ?? 0,
        estimatedNetProfitUsd: Math.round((s?.estimatedNetProfitUsd ?? 0) * 100) / 100,
        bestNetProfitUsd: s && Number.isFinite(s.bestNetProfitUsd) ? s.bestNetProfitUsd : null,
      };
    }),
    trades: {
      simulated: ok.length + reverted.length,
      simulatedSucceeded: ok.length,
      simulatedFailed: reverted.length,
      executed: 0,
    },
    gas: {
      estimatedGasOfSimulatedTradesUsd: Math.round(ok.reduce((a, o) => a + o.gasCostUsd, 0) * 100) / 100,
      gasActuallySpentUsd: 0,
    },
    series,
    recentOpportunities: all.slice(-40).reverse(),
  };
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(data, null, 1));
  console.log(`wrote ${outFile} (${data.recentOpportunities.length} recent opportunities, ${series.length} chart points)`);
}
main();
