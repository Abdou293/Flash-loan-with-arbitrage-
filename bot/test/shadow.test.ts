import { describe, expect, it } from "vitest";
import { buildShadow, parseHistory } from "../src/shadow.js";
import type { CycleResult } from "../src/liquidations/watchRun.js";

const cyc = (block: number, ts: string, over: Partial<CycleResult> = {}): CycleResult => ({
  block, timestamp: ts, watched: 10, readFailures: 0, dryRun: true,
  counts: { liquidatable: 0, at_risk: 1, watch: 0, healthy: 9, no_debt: 0 },
  rows: [{ user: "0x1", band: "at_risk", hf: 1.04, debtUsd: 1000, collateralUsd: 1100 }],
  ...over,
});

describe("buildShadow", () => {
  it("summarises real cycles without inventing numbers", () => {
    const attempt: CycleResult = cyc(2, "2026-11-25T10:01:00Z", {
      counts: { liquidatable: 1, at_risk: 0, watch: 0, healthy: 9, no_debt: 0 },
      rows: [{ user: "0x2", band: "liquidatable", hf: 0.97, debtUsd: 100_000, collateralUsd: 99_000,
        estimate: { closeFactor: 0.5, coverUsd: 50_000, grossBonusUsd: 2500, gasUsd: 0.1, netUsd: 2499.9, decision: "would_attempt" } }],
    });
    const rej: CycleResult = cyc(3, "2026-11-25T10:02:00Z", {
      counts: { liquidatable: 1, at_risk: 0, watch: 0, healthy: 9, no_debt: 0 },
      rows: [{ user: "0x3", band: "liquidatable", hf: 0.99, debtUsd: 20, collateralUsd: 19,
        estimate: { closeFactor: 0.5, coverUsd: 10, grossBonusUsd: 0.5, gasUsd: 0.1, netUsd: 0.4, decision: "rejected", reason: "net $0.40 < min $1" } }],
    });
    const s = buildShadow([rej, cyc(1, "2026-11-25T10:00:00Z"), attempt], new Date("2026-11-25T13:00:00Z"));
    expect(s.meta.cycles).toBe(3);
    expect(s.meta.hoursObserved).toBe(0.03); // two 1-minute gaps, rounded to 2 decimals
    expect(s.meta.spanHours).toBe(0.03);
    expect(s.meta.cyclesWithLiquidatable).toBe(2);
    expect(s.meta.cyclesWithWouldAttempt).toBe(1);
    expect(s.meta.estimatedGrossBonusUsdIfAllWon).toBe(2500);
    expect(Object.values(s.meta.rejectedReasons)).toEqual([1]);
    expect(s.series.map((p) => p.block)).toEqual([1, 2, 3]); // sorted by block
    expect(s.series[0]!.minHf).toBe(1.04);
    expect(s.latest!.block).toBe(3);
  });
  it("does not count time the monitor was off", () => {
    // 10:00, 10:01, then a 5-hour gap (monitor stopped), then 15:00, 15:01
    const s = buildShadow([cyc(1, "2026-11-25T10:00:00Z"), cyc(2, "2026-11-25T10:01:00Z"), cyc(3, "2026-11-25T15:00:00Z"), cyc(4, "2026-11-25T15:01:00Z")]);
    expect(s.meta.hoursObserved).toBe(0.03);
    expect(s.meta.spanHours).toBe(5.02);
  });
  it("handles no data and keeps the series bounded", () => {
    expect(buildShadow([]).meta.cycles).toBe(0);
    const many = Array.from({ length: 1000 }, (_, i) => cyc(i, new Date(1_700_000_000_000 + i * 60_000).toISOString()));
    const s = buildShadow(many, new Date(), 100);
    expect(s.series.length).toBeLessThanOrEqual(101);
    expect(s.series[s.series.length - 1]!.block).toBe(999);
  });
  it("ignores a half-written last line", () => {
    const text = JSON.stringify(cyc(1, "2026-11-25T10:00:00Z")) + '\n{"block": 2, "tim';
    expect(parseHistory(text)).toHaveLength(1);
  });
});
