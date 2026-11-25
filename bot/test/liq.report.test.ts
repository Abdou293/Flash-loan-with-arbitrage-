import { describe, expect, it } from "vitest";
import {
  focusStats, inRandomSample, prizeSummary, sizeVsSpeed, speedByBonus,
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

  it("warns loudly when only part of the range was scanned, and stays quiet when all of it was", () => {
    const base = { events: [ev({})], fromBlock: 1, toBlock: 1000, generatedAt: "x", lookback: 10, eventsWithoutPrice: 0, poolAddress: "0xp" };
    const partial = renderReport({ ...base, coveredBlocks: 250 });
    expect(partial).toMatch(/PARTIAL SCAN: 250 of 1,000 blocks scanned \(25%\)/);
    expect(partial).toMatch(/run the same command again to continue/);
    expect(renderReport({ ...base, coveredBlocks: 1000 })).not.toMatch(/PARTIAL SCAN/);
    expect(renderReport(base)).not.toMatch(/PARTIAL SCAN/);
  });
});

describe("speed versus prize size (the nuance a plain 'x% instant' hides)", () => {
  const dust = (blocks: number, censored = false) => ev({ grossBonusUsd: 0.3, delay: { blocks, censored, calls: 20 } });
  const big = (usd: number, blocks: number) => ev({ grossBonusUsd: usd, delay: { blocks, censored: false, calls: 20 } });

  // shaped like the first real measurement: most liquidations are instant, a few tiny ones waited for hours
  const realistic = [
    big(162, 0), big(126, 0), big(40, 0),
    ...Array.from({ length: 8 }, () => dust(0)),
    ...Array.from({ length: 3 }, () => dust(20000, true)),
  ];

  it("measures how the slow ones differ from the instant ones", () => {
    const z = sizeVsSpeed(realistic);
    expect(z).toMatchObject({ clean: 14, instant: 11, slow: 3 });
    expect(z.medianBonusSlowUsd).toBeCloseTo(0.3, 9);
    expect(z.medianBonusInstantUsd).toBeCloseTo(0.3, 9);
    expect(z.valueInstantShare!).toBeGreaterThan(0.99); // the money was taken instantly
    expect(z.slowValueShare!).toBeLessThan(0.01); // the slow ones carry almost none of it
  });

  it("verdict stays CROWDED when the slow ones are small, and says so with numbers", () => {
    const evs = [...realistic.slice(0, 3).map((e) => ({ ...e, grossBonusUsd: 100 })), ...realistic.slice(3)];
    const z = sizeVsSpeed(evs);
    const v = verdict(speedStats(evs), 0.8, 6, z);
    expect(v.label).toBe("crowded");
    expect(v.text).toMatch(/3 sampled liquidation\(s\) waited more than 10 blocks/);
    expect(v.text).toMatch(/together they carry 0% of the sampled gross bonus/);
    expect(v.text).toMatch(/the slow ones are the small ones/);
    expect(v.text).toMatch(/Weighted by gross bonus, (9\d|100)% of the sampled prize/);
  });

  it("verdict becomes MIXED when most are instant but the VALUABLE ones are not", () => {
    const evs = [...Array.from({ length: 10 }, () => dust(0)), big(900, 400), big(800, 300), big(700, 250), big(600, 500)];
    const v = verdict(speedStats(evs), 0.5, 5, sizeVsSpeed(evs));
    expect(v.label).toBe("mixed");
    expect(v.text).toMatch(/valuable ones were NOT all taken instantly/);
    expect(v.text).toMatch(/only a lead/);
  });

  it("splits speed by prize bucket", () => {
    const rows = speedByBonus(realistic);
    const by = Object.fromEntries(rows.map((r) => [r.label, r]));
    expect(by["< $1"]).toMatchObject({ samples: 11, censored: 3 });
    expect(by["< $1"]!.instantShare).toBeCloseTo(8 / 11, 9);
    expect(by["$100 or more"]).toMatchObject({ samples: 2 });
    expect(by["$20 - $100"]).toMatchObject({ samples: 1 });
  });

  it("sizes the whole prize pool and its concentration", () => {
    const p = prizeSummary(realistic, 960_000);
    expect(p.totalGrossBonusUsd).toBeCloseTo(162 + 126 + 40 + 11 * 0.3, 6);
    expect(p.days).toBeCloseTo(3, 9);
    expect(p.perDayUsd).toBeCloseTo(p.totalGrossBonusUsd / 3, 9);
    expect(p.top3Share!).toBeCloseTo(328 / 331.3, 4);
  });

  it("the rendered report carries the new sections and never prints undefined/NaN", () => {
    const md = renderReport({ events: realistic, fromBlock: 1, toBlock: 960_000, generatedAt: "x", lookback: 20000, eventsWithoutPrice: 0, poolAddress: "0xp" });
    expect(md).toContain("### Speed by prize size (clean samples)");
    expect(md).toMatch(/Whole market, all liquidators together: gross bonus of \*\*\$3\d\d\*\*/);
    expect(md).toMatch(/the 3 largest liquidations made up 9\d% of it/);
    expect(md).not.toMatch(/undefined|NaN/);
  });
});

describe("--focus-debt: every liquidation of chosen debt assets, kept apart from the random sample", () => {
  const lusd = (blocks: number, bonus: number, o: Partial<EnrichedEvent> = {}) =>
    ev({ debtSymbol: "LUSD", grossBonusUsd: bonus, delay: { blocks, censored: blocks >= 20000, calls: 20 }, inSample: false, ...o });
  const sampled = Array.from({ length: 12 }, () => ev({ grossBonusUsd: 50, delay: { blocks: 0, censored: false, calls: 5 }, inSample: true }));
  const focus = [lusd(0, 10), lusd(20000, 59), lusd(300, 4), lusd(1, 2, { repeatUser: true })];
  const evs = [...sampled, ...focus];

  it("focus measurements do not change the general speed statistics or the verdict inputs", () => {
    expect(speedStats(evs)).toEqual(speedStats(sampled));
    expect(sizeVsSpeed(evs)).toEqual(sizeVsSpeed(sampled));
    expect(evs.filter(inRandomSample)).toHaveLength(12);
  });

  it("events from older caches (no inSample flag) still count as sampled", () => {
    expect(inRandomSample(ev({ delay: { blocks: 0, censored: false, calls: 1 } }))).toBe(true);
    expect(inRandomSample(ev({}))).toBe(false);
  });

  it("reports every focus liquidation: speed, money left waiting, repeats", () => {
    const [row] = focusStats(evs, ["lusd"]); // case-insensitive
    expect(row).toMatchObject({ symbol: "lusd", liquidations: 4, repeats: 1, measured: 3, errors: 0, censored: 1, medianBlocks: 300 });
    expect(row!.instantShare).toBeCloseTo(1 / 3, 9);
    expect(row!.slowGrossBonusUsd).toBeCloseTo(63, 9); // 59 + 4 waited more than 10 blocks
    expect(row!.grossBonusUsd).toBeCloseTo(75, 9);
  });

  it("renders a separate section that says it is not used in the verdict", () => {
    const md = renderReport({ events: evs, fromBlock: 1, toBlock: 100, generatedAt: "x", lookback: 20000, eventsWithoutPrice: 0, poolAddress: "0xp", focusDebt: ["LUSD", "EURS"] });
    expect(md).toContain("## Focus: every liquidation whose debt is LUSD, EURS (all measured, not a sample)");
    expect(md).toMatch(/NOT used in the general statistics or the verdict/);
    expect(md).toMatch(/\| LUSD \| 4 \| 3 \| 33% \| 300 \| 1 \| \$63\.00 \| \$75\.00 \| 1 \| 1 \/ 0 \|/);
    expect(md).toMatch(/\| EURS \| 0 \| 0 \| - \| - \| 0 \| \$0\.00 \| \$0\.00 \| 0 \| 0 \/ 0 \|/);
    expect(md).not.toMatch(/undefined|NaN/);
    // focus section comes before the verdict
    expect(md.indexOf("## Focus:")).toBeLessThan(md.indexOf("## Verdict:"));
  });
});
