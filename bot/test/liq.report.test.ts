import { describe, expect, it } from "vitest";
import {
  bonusBuckets, CROWDED_SHARE, liquidatorConcentration, MIN_SAMPLES, percentile, perDay, renderReport, speedStats, topAssets, verdict,
  type EnrichedEvent,
} from "../src/liquidations/report.js";

const DAY = 86_400;
const T0 = Date.UTC(2026, 10, 20) / 1000; // 2026-11-20 00:00 UTC

let n = 0;
function ev(o: Partial<EnrichedEvent> & { dayOffset?: number }): EnrichedEvent {
  n++;
  return {
    block: 1000 + n, logIndex: n, txHash: "0x" + n.toString(16), txIndex: 0,
    collateralAsset: "0xweth", debtAsset: "0xusdc", user: "0xuser" + n, liquidator: "0xbot1",
    debtToCover: 1n, collateralAmount: 1n, receiveAToken: false,
    timestamp: T0 + (o.dayOffset ?? 0) * DAY + 100, debtSymbol: "USDC", collSymbol: "WETH",
    debtUsd: 1000, collUsd: 1050, bonusPct: 5, grossBonusUsd: 50, ...o,
  } as EnrichedEvent;
}
const withDelay = (blocks: number, o: Partial<EnrichedEvent> = {}) => ev({ delay: { blocks, censored: false, calls: 10 }, ...o });

describe("report aggregation", () => {
  it("percentile uses nearest rank", () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentile([], 50)).toBeUndefined();
  });

  it("groups by UTC day with sizes, bonus and distinct liquidators", () => {
    const rows = perDay([
      ev({ debtUsd: 100, bonusPct: 4, grossBonusUsd: 4, liquidator: "a" }),
      ev({ debtUsd: 300, bonusPct: 6, grossBonusUsd: 18, liquidator: "b" }),
      ev({ dayOffset: 1, debtUsd: 5000, bonusPct: 5, grossBonusUsd: 250, liquidator: "a" }),
    ]);
    expect(rows.map((r) => [r.day, r.count, r.debtUsd, r.liquidators])).toEqual([
      ["2026-11-20", 2, 400, 2],
      ["2026-11-21", 1, 5000, 1],
    ]);
    expect(rows[0]!.medianDebtUsd).toBe(100);
    expect(rows[0]!.grossBonusUsd).toBe(22);
  });

  it("an event just before midnight UTC belongs to the day before", () => {
    const rows = perDay([ev({ timestamp: T0 + DAY - 1 }), ev({ timestamp: T0 + DAY })]);
    expect(rows.map((r) => r.day)).toEqual(["2026-11-20", "2026-11-21"]);
  });

  it("ranks assets and liquidators, and measures concentration", () => {
    const evs = [ev({ debtSymbol: "USDC" }), ev({ debtSymbol: "USDC" }), ev({ debtSymbol: "DAI" })];
    expect(topAssets(evs, "debt")[0]).toMatchObject({ symbol: "USDC", count: 2 });
    const c = liquidatorConcentration([ev({ liquidator: "a" }), ev({ liquidator: "a" }), ev({ liquidator: "a" }), ev({ liquidator: "b" }), ev({ liquidator: "c" }), ev({ liquidator: "d" })]);
    expect(c.distinct).toBe(4);
    expect(c.top[0]).toMatchObject({ address: "a", count: 3 });
    expect(c.top3Share).toBeCloseTo(5 / 6, 9);
  });

  it("buckets the gross bonus", () => {
    const b = bonusBuckets([ev({ grossBonusUsd: 0.5 }), ev({ grossBonusUsd: 3 }), ev({ grossBonusUsd: 3 }), ev({ grossBonusUsd: 250 })]);
    expect(b.map((x) => x.count)).toEqual([1, 2, 0, 0, 1]);
  });
});

describe("speed statistics and verdict", () => {
  it("counts same-block, instant and slow liquidations; excludes repeats, errors; reports censoring", () => {
    const evs = [
      ...Array.from({ length: 6 }, () => withDelay(0)),
      withDelay(1), withDelay(2), withDelay(30), withDelay(400),
      withDelay(5, { repeatUser: true }),
      ev({ delay: { blocks: 0, censored: false, calls: 0, error: "missing trie node" } }),
      ev({ delay: { blocks: 20000, censored: true, calls: 30 } }),
      ev({}), // never sampled
    ];
    const s = speedStats(evs);
    expect(s).toMatchObject({ sampled: 13, clean: 11, errors: 1, repeatExcluded: 1, censored: 1 });
    expect(s.sameBlockShare).toBeCloseTo(6 / 11, 9);
    expect(s.instantShare).toBeCloseTo(8 / 11, 9);
    expect(s.medianBlocks).toBe(0); // 6 of the 11 clean samples are same-block
  });

  it("verdict CROWDED when most liquidations are instant: states it is a portfolio project, not a profit source", () => {
    const evs = [...Array.from({ length: 16 }, () => withDelay(0)), ...Array.from({ length: 4 }, () => withDelay(100))];
    const s = speedStats(evs);
    expect(s.instantShare!).toBeGreaterThanOrEqual(CROWDED_SHARE);
    const v = verdict(s, 0.9, 3);
    expect(v.label).toBe("crowded");
    expect(v.text).toMatch(/portfolio project, not a profit source/);
    expect(v.text).toMatch(/80%/);
  });

  it("verdict SLOW only when few are instant AND the median wait is long, and then asks for confirmation", () => {
    const evs = Array.from({ length: 12 }, (_, i) => withDelay(40 + i));
    const v = verdict(speedStats(evs), 0.5, 6);
    expect(v.label).toBe("slow");
    expect(v.text).toMatch(/only a lead/);
  });

  it("verdict MIXED in between, and UNKNOWN with too few samples", () => {
    const mixed = [...Array.from({ length: 5 }, () => withDelay(0)), ...Array.from({ length: 7 }, () => withDelay(8))];
    expect(verdict(speedStats(mixed), 0.6, 5).label).toBe("mixed");
    const few = Array.from({ length: MIN_SAMPLES - 1 }, () => withDelay(0));
    expect(verdict(speedStats(few), 1, 1).label).toBe("unknown");
  });
});

describe("rendered report", () => {
  const evs = [
    ...Array.from({ length: 12 }, () => withDelay(0)),
    ev({ dayOffset: 1, debtUsd: 20_000, grossBonusUsd: 1000 }),
  ];
  const md = renderReport({
    events: evs, fromBlock: 100, toBlock: 900, generatedAt: "2026-11-25T00:00:00Z", lookback: 20000,
    eventsWithoutPrice: 0, poolAddress: "0xpool", chunkInfo: "10 getLogs requests", repeatEvents: 2,
  });

  it("contains every section, the verdict and the limitations", () => {
    for (const h of ["## Per day (UTC)", "## How big is the prize?", "## Assets", "## Who liquidates", "## How fast are liquidations taken? (sample)", "## Verdict: CROWDED", "## Limitations"]) {
      expect(md).toContain(h);
    }
    expect(md).toContain("2026-11-20");
    expect(md).toContain("2026-11-21");
    expect(md).toMatch(/Liquidation events found: \*\*13\*\*/);
    expect(md).toMatch(/not sampled: same borrower already liquidated within 20000 blocks \(partial liquidations\) \| 2 \|/);
  });

  it("is valid markdown: every table is preceded by a blank line and nothing says 'undefined' or 'NaN'", () => {
    expect(md).not.toMatch(/undefined|NaN/);
    const lines = md.split("\n");
    lines.forEach((l, i) => {
      if (l.startsWith("|---") && lines[i - 2] !== undefined) expect(lines[i - 2]!.startsWith("|") || lines[i - 2] === "").toBe(true);
    });
    expect(md).toMatch(/\n\n\| Day \|/);
  });

  it("an empty range still renders without crashing", () => {
    const empty = renderReport({ events: [], fromBlock: 1, toBlock: 2, generatedAt: "x", lookback: 10, eventsWithoutPrice: 0, poolAddress: "0xp" });
    expect(empty).toContain("Liquidation events found: **0**");
    expect(empty).toContain("Verdict: UNKNOWN");
    expect(empty).not.toMatch(/undefined|NaN/);
  });
});
