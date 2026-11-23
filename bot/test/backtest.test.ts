import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSnapshot, DEFAULT_CURVE_SIZES_USD } from "../src/backtest/snapshot.js";
import { renderMarkdown, summarize } from "../src/backtest/report.js";
import { runBacktest } from "../src/backtest/run.js";
import { appendSnapshot, interpolateRate, readDataset, writeHeader, type Dataset } from "../src/core/dataset.js";
import { ReplayMarket } from "../src/core/market/ReplayMarket.js";
import { fromHuman, toHuman } from "../src/core/units.js";
import { FakeMarket, config } from "./helpers.js";

const header = (source: "synthetic" | "rpc-archive" = "synthetic") => ({
  type: "header" as const, source, createdAt: "2026-01-01T00:00:00Z", curveSizesUsd: DEFAULT_CURVE_SIZES_USD, note: "test",
});

async function dataset(n: number, mult: ConstructorParameters<typeof FakeMarket>[0], source: "synthetic" | "rpc-archive" = "synthetic"): Promise<Dataset> {
  const m = new FakeMarket(mult);
  const snapshots = [];
  for (let i = 0; i < n; i++) snapshots.push(await buildSnapshot(m, config, DEFAULT_CURVE_SIZES_USD, i + 1, i));
  return { header: header(source), snapshots };
}

describe("rate-curve interpolation", () => {
  const curve: [number, number][] = [[100, 1.0], [1000, 0.99], [10000, 0.9]];
  it("hits recorded points exactly", () => {
    expect(interpolateRate(curve, 1000)).toBeCloseTo(0.99);
    expect(interpolateRate(curve, 10000)).toBeCloseTo(0.9);
  });
  it("interpolates between points (log scale) and never beats the better neighbour", () => {
    const r = interpolateRate(curve, 316)!; // ~ geometric middle of 100 and 1000
    expect(r).toBeLessThan(1.0);
    expect(r).toBeGreaterThan(0.99);
    expect(r).toBeCloseTo(0.995, 2);
  });
  it("uses best rate for tiny trades and refuses far beyond the recorded range", () => {
    expect(interpolateRate(curve, 10)).toBe(1.0);
    expect(interpolateRate(curve, 12000)).toBe(0.9); // within 1.5x of the last point
    expect(interpolateRate(curve, 20000)).toBeNull(); // beyond 1.5x: no extrapolation
  });
});

describe("dataset file + replay market", () => {
  it("round-trips through JSONL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ds-"));
    const path = join(dir, "d.jsonl");
    const ds = await dataset(2, () => 1);
    writeHeader(path, ds.header);
    ds.snapshots.forEach((s) => appendSnapshot(path, s));
    expect(readDataset(path)).toEqual(ds);
    rmSync(dir, { recursive: true });
  });

  it("replayed quotes match the live quotes they were recorded from (at recorded and in-between sizes)", async () => {
    const live = new FakeMarket();
    const ds = await dataset(1, () => 1);
    const replay = new ReplayMarket(ds);
    await replay.advance();
    const weth = config.tokens["WETH"]!;
    const usdc = config.tokens["USDC"]!;
    const venue = config.venues.find((v) => v.id === "uniV3-500")!;
    for (const usd of [1000, 7000]) {
      const amountIn = fromHuman(usd / 3000, weth);
      const a = toHuman(await live.quote({ venue, tokenIn: weth, tokenOut: usdc }, amountIn), usdc);
      const b = toHuman(await replay.quote({ venue, tokenIn: weth, tokenOut: usdc }, amountIn), usdc);
      expect(b).toBeCloseTo(a, 3);
    }
  });

  it("throws when the dataset is exhausted", async () => {
    const replay = new ReplayMarket(await dataset(1, () => 1));
    await replay.advance();
    await expect(replay.advance()).rejects.toThrow(/exhausted/);
  });
});

describe("backtest run + report", () => {
  it("finds nothing on a market with no spreads", async () => {
    const r = await runBacktest(await dataset(5, () => 1), config);
    expect(r.snapshots).toBe(5);
    expect(r.opportunities.filter((o) => o.status === "simulated_ok")).toEqual([]);
  });

  it("finds crossDex opportunities when one venue is 2% off, and attributes them to the right strategy", async () => {
    const skew = (v: string, a: string, b: string) => (v === "sushiV2-3000" && a === "WETH" && b === "USDC" ? 1.02 : 1);
    const r = await runBacktest(await dataset(5, skew), config);
    const s = summarize(r).find((x) => x.strategy === "crossDex")!;
    expect(s.snapshotsWithOpportunity).toBe(5);
    expect(s.estimatedNetProfitUsd).toBeGreaterThan(0);
    // estimated profit counts one best opportunity per snapshot, so it cannot exceed best * snapshots
    expect(s.estimatedNetProfitUsd).toBeLessThanOrEqual(s.bestNetProfitUsd! * 5 + 0.01);
  });

  it("is deterministic", async () => {
    const skew = (v: string) => (v === "sushiV2-3000" ? 1.01 : 1);
    const ds = await dataset(4, skew);
    const strip = (x: any) => x.opportunities.map((o: any) => [o.strategy, o.route, o.netProfitUsd, o.status]);
    expect(strip(await runBacktest(ds, config))).toEqual(strip(await runBacktest(ds, config)));
  });

  it("report always states the limitations and flags synthetic data", async () => {
    const md = renderMarkdown(await runBacktest(await dataset(3, () => 1), config));
    expect(md).toMatch(/SYNTHETIC DATA/);
    expect(md).toMatch(/Upper bound, not a forecast/);
    expect(md).toMatch(/newPoolScanner/);
    const real = renderMarkdown(await runBacktest(await dataset(3, () => 1, "rpc-archive"), config));
    expect(real).not.toMatch(/SYNTHETIC DATA/);
    expect(real).toMatch(/Upper bound/);
  });
});
