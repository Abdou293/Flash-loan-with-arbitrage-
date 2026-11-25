import type { CycleResult } from "./liquidations/watchRun.js";

/**
 * Turns the cycles recorded by `npm run liq-watch` (watch-history.<chain>.jsonl, REAL on-chain reads in shadow /
 * dry-run mode) into the JSON file the dashboard shows. Pure function: no network, no files.
 */
export interface ShadowPoint {
  t: string;
  block: number;
  liquidatable: number;
  atRisk: number;
  watch: number;
  /** lowest health factor among accounts that have debt (null when none was readable) */
  minHf: number | null;
}

export interface ShadowSummary {
  dataSource: "real on-chain reads, shadow mode (dry-run)";
  generatedAt: string;
  cycles: number;
  firstCycle: string | null;
  lastCycle: string | null;
  hoursObserved: number;
  accountsWatched: number;
  cyclesWithLiquidatable: number;
  /** cycles in which the dry-run decision was "would attempt" for at least one account */
  cyclesWithWouldAttempt: number;
  /** sum, over cycles, of the best "would attempt" estimate. An ESTIMATE: flat bonus, no swap cost, no competition. */
  estimatedGrossBonusUsdIfAllWon: number;
  rejectedReasons: Record<string, number>;
  caveats: string[];
}

export interface ShadowExport {
  meta: ShadowSummary;
  series: ShadowPoint[];
  latest: CycleResult | null;
}

export function parseHistory(text: string): CycleResult[] {
  const out: CycleResult[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as CycleResult;
      if (r && typeof r.block === "number" && r.counts) out.push(r);
    } catch {
      /* half-written last line */
    }
  }
  return out;
}

export function buildShadow(cycles: CycleResult[], now: Date = new Date(), maxPoints = 400): ShadowExport {
  const sorted = [...cycles].sort((a, b) => a.block - b.block);
  const reasons: Record<string, number> = {};
  let withLiq = 0, withAttempt = 0, estimated = 0;
  const points: ShadowPoint[] = sorted.map((c) => {
    const hfs = c.rows.map((r) => r.hf).filter((h) => Number.isFinite(h));
    if (c.counts.liquidatable > 0) withLiq++;
    const attempts = c.rows.filter((r) => r.estimate?.decision === "would_attempt");
    if (attempts.length) {
      withAttempt++;
      estimated += Math.max(...attempts.map((r) => r.estimate!.grossBonusUsd));
    }
    for (const r of c.rows) {
      if (r.estimate?.decision === "rejected" && r.estimate.reason) {
        const key = r.estimate.reason.replace(/[\d.,]+/g, "#");
        reasons[key] = (reasons[key] ?? 0) + 1;
      }
    }
    return {
      t: c.timestamp,
      block: c.block,
      liquidatable: c.counts.liquidatable,
      atRisk: c.counts.at_risk,
      watch: c.counts.watch,
      minHf: hfs.length ? Math.min(...hfs) : null,
    };
  });
  // keep the file small: an evenly spaced sample when there are many cycles
  const step = Math.max(1, Math.ceil(points.length / maxPoints));
  const series = points.filter((_, i) => i % step === 0 || i === points.length - 1);
  const first = sorted[0]?.timestamp ?? null;
  const last = sorted[sorted.length - 1]?.timestamp ?? null;
  const hours = first && last ? (Date.parse(last) - Date.parse(first)) / 3_600_000 : 0;
  return {
    meta: {
      dataSource: "real on-chain reads, shadow mode (dry-run)",
      generatedAt: now.toISOString(),
      cycles: sorted.length,
      firstCycle: first,
      lastCycle: last,
      hoursObserved: Math.round(hours * 100) / 100,
      accountsWatched: sorted[sorted.length - 1]?.watched ?? 0,
      cyclesWithLiquidatable: withLiq,
      cyclesWithWouldAttempt: withAttempt,
      estimatedGrossBonusUsdIfAllWon: Math.round(estimated * 100) / 100,
      rejectedReasons: reasons,
      caveats: [
        "Shadow mode: the monitor reads the real Aave V3 state on Arbitrum but never sends a transaction.",
        "The dollar figure is an ESTIMATE (flat 5% bonus, no swap cost, no competition). It is what would be earned if every 'would attempt' were won, which our measurements say it would not be: profitable liquidations are normally taken in the same block by specialised bots.",
        "Only the accounts the monitor knows about (recent borrowers) are watched, not every Aave account.",
      ],
    },
    series,
    latest: sorted[sorted.length - 1] ?? null,
  };
}
