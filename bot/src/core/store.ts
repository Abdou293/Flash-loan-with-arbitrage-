import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Opportunity } from "./types.js";

export interface StrategyStats {
  routesEvaluated: number;
  profitable: number;
  rejectedRisk: number;
  simulatedOk: number;
  simulatedRevert: number;
  /** Sum of ESTIMATED net profit (USD) of opportunities that passed risk and simulation. Not realised profit. */
  estimatedNetProfitUsd: number;
  bestNetProfitUsd: number;
}

export class Store {
  readonly stats: Record<string, StrategyStats> = {};
  readonly recent: Opportunity[] = [];

  constructor(private readonly jsonlPath: string | null) {
    if (jsonlPath) {
      mkdirSync(dirname(jsonlPath), { recursive: true });
      writeFileSync(jsonlPath, "");
    }
  }

  private s(name: string): StrategyStats {
    return (this.stats[name] ??= {
      routesEvaluated: 0,
      profitable: 0,
      rejectedRisk: 0,
      simulatedOk: 0,
      simulatedRevert: 0,
      estimatedNetProfitUsd: 0,
      bestNetProfitUsd: Number.NEGATIVE_INFINITY,
    });
  }

  record(o: Opportunity): void {
    const st = this.s(o.strategy);
    st.routesEvaluated++;
    if (o.netProfitUsd > 0) st.profitable++;
    if (o.netProfitUsd > st.bestNetProfitUsd) st.bestNetProfitUsd = o.netProfitUsd;
    if (o.status === "rejected_risk" || o.status === "skipped_paused") st.rejectedRisk++;
    if (o.status === "simulated_ok") {
      st.simulatedOk++;
      st.estimatedNetProfitUsd += o.netProfitUsd;
    }
    if (o.status === "simulated_revert") st.simulatedRevert++;
    // Only profitable-looking candidates are written individually; unprofitable ones are counted only.
    if (o.status !== "unprofitable") {
      this.recent.push(o);
      if (this.jsonlPath) appendFileSync(this.jsonlPath, JSON.stringify(o) + "\n");
    }
  }

  writeSummary(path: string, meta: Record<string, unknown>): void {
    mkdirSync(dirname(path), { recursive: true });
    const clean = Object.fromEntries(
      Object.entries(this.stats).map(([k, v]) => [
        k,
        { ...v, bestNetProfitUsd: Number.isFinite(v.bestNetProfitUsd) ? v.bestNetProfitUsd : null },
      ]),
    );
    writeFileSync(path, JSON.stringify({ ...meta, strategies: clean }, null, 2));
  }
}
