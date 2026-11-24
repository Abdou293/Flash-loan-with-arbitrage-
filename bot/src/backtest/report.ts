import type { BacktestResult } from "./run.js";

export interface StrategySummary {
  strategy: string;
  routesEvaluated: number;
  profitableBeforeRisk: number;
  passedRisk: number;
  snapshotsWithOpportunity: number;
  /** Sum over snapshots of the single best passing opportunity (one fill per snapshot per strategy). */
  estimatedNetProfitUsd: number;
  bestNetProfitUsd: number | null;
  medianNetProfitUsd: number | null;
  /** Best net result of ANY evaluated route, profitable or not: how close the strategy came to break-even. */
  closestToBreakEvenUsd: number | null;
}

export function summarize(r: BacktestResult): StrategySummary[] {
  return r.enabledStrategies.map((strategy) => {
    const st = r.stats[strategy];
    const passing = r.opportunities.filter((o) => o.strategy === strategy && o.status === "simulated_ok");
    const bestPerCycle = new Map<number, number>();
    for (const o of passing) bestPerCycle.set(o.cycle, Math.max(bestPerCycle.get(o.cycle) ?? -Infinity, o.netProfitUsd));
    const nets = [...bestPerCycle.values()].sort((a, b) => a - b);
    return {
      strategy,
      routesEvaluated: st?.routesEvaluated ?? 0,
      profitableBeforeRisk: st?.profitable ?? 0,
      passedRisk: passing.length,
      snapshotsWithOpportunity: bestPerCycle.size,
      estimatedNetProfitUsd: round(nets.reduce((a, b) => a + b, 0)),
      bestNetProfitUsd: nets.length ? round(nets[nets.length - 1]!) : null,
      medianNetProfitUsd: nets.length ? round(nets[Math.floor(nets.length / 2)]!) : null,
      closestToBreakEvenUsd: st && Number.isFinite(st.bestNetProfitUsd) ? round(st.bestNetProfitUsd) : null,
    };
  });
}

const round = (x: number) => Math.round(x * 100) / 100;

export function renderMarkdown(r: BacktestResult): string {
  const rows = summarize(r).sort((a, b) => b.estimatedNetProfitUsd - a.estimatedNetProfitUsd);
  const synthetic = r.dataset.source === "synthetic";
  const lines: string[] = [];
  lines.push(`# Backtest report`, "");
  if (synthetic)
    lines.push(
      "> **SYNTHETIC DATA.** The prices in this run are random numbers generated for testing the software.",
      "> They are NOT market history. Nothing in this report is evidence of real-world profitability.",
      "",
    );
  lines.push(
    `- Data source: \`${r.dataset.source}\` (created ${r.dataset.createdAt})`,
    `- Snapshots replayed: ${r.snapshots}` + (r.dataset.fromBlock ? ` (blocks ${r.dataset.fromBlock}–${r.dataset.toBlock})` : ""),
    `- Note: ${r.dataset.note}`,
    "",
    "| Strategy | Routes evaluated | Profitable before risk | Passed risk | Snapshots with an opportunity | Est. net profit (USD) | Best (USD) | Median (USD) | Closest to break-even (USD) |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  );
  for (const s of rows)
    lines.push(
      `| ${s.strategy} | ${s.routesEvaluated} | ${s.profitableBeforeRisk} | ${s.passedRisk} | ${s.snapshotsWithOpportunity} | ${s.estimatedNetProfitUsd} | ${s.bestNetProfitUsd ?? "-"} | ${s.medianNetProfitUsd ?? "-"} | ${s.closestToBreakEvenUsd ?? "-"} |`,
    );
  lines.push(
    "",
    "## How to read this (limitations)",
    "",
    "- **Upper bound, not a forecast.** Every opportunity is assumed to be filled at the recorded quote. The backtest does not model competing bots, latency, or price moves before inclusion.",
    "- **Est. net profit** counts only the single best passing opportunity per snapshot per strategy, after flash-loan fee, slippage reserve and estimated gas.",
    "- **Snapshots are samples.** Opportunities that live for seconds between samples are invisible; ones that persist across several samples are counted once per sample.",
    "- **newPoolScanner** cannot be backtested with this dataset format (no historical pool-creation data), so it shows 0 routes here.",
    "- **Closest to break-even** is the best net result among ALL evaluated routes (usually negative): how far the strategy was from a profitable trade.",
    "- Gas is an estimate from the config, not measured.",
    "- The ranking above orders strategies by this estimate only; it is not a recommendation to enable any of them.",
    "",
  );
  return lines.join("\n");
}
