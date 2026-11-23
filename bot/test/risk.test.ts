import { describe, expect, it } from "vitest";
import { RiskEngine } from "../src/core/risk.js";
import type { Candidate } from "../src/core/types.js";
import { config } from "./helpers.js";

const cand = (netUsd: number, sizeUsd = 1000): Candidate =>
  ({ amountInUsd: sizeUsd, profit: { netUsd } }) as unknown as Candidate;

describe("risk engine", () => {
  const cfg = { ...config.risk, minNetProfitUsd: 5, maxGasPriceGwei: 1, maxTradeSizeUsd: 10_000, maxConsecutiveFailures: 3 };

  it("accepts a good opportunity", () => {
    expect(new RiskEngine(cfg).check(cand(10), 0.1).ok).toBe(true);
  });
  it("rejects below minimum profit", () => {
    expect(new RiskEngine(cfg).check(cand(4.99), 0.1).ok).toBe(false);
  });
  it("rejects when gas price is above the cap", () => {
    expect(new RiskEngine(cfg).check(cand(10), 1.5).ok).toBe(false);
  });
  it("rejects trades above the size cap", () => {
    expect(new RiskEngine(cfg).check(cand(10, 10_001), 0.1).ok).toBe(false);
  });
  it("auto-pauses after N consecutive failures; a success resets the counter", () => {
    const r = new RiskEngine(cfg);
    r.recordResult(false); r.recordResult(false); r.recordResult(true);
    r.recordResult(false); r.recordResult(false);
    expect(r.paused).toBe(false);
    r.recordResult(false);
    expect(r.paused).toBe(true);
    expect(r.check(cand(100), 0.1).ok).toBe(false);
    r.resume();
    expect(r.check(cand(100), 0.1).ok).toBe(true);
  });
});
