import { describe, expect, it } from "vitest";
import { durationBlocks, EpisodeTracker } from "../src/monitor/episodes.js";
import { gapVersusFees, orientPrice, v2PriceToken1PerToken0, v3PriceToken1PerToken0 } from "../src/monitor/math.js";

describe("gap monitor price math", () => {
  it("decodes a Uniswap V3 sqrtPriceX96 with different decimals", () => {
    // token0 = WETH (18), token1 = USDC (6), price 3000 USDC per WETH
    // raw price (token1 base units per token0 base units) = 3000e6 / 1e18 = 3e-9 ; sqrtPriceX96 = sqrt(raw) * 2^96
    const sqrt = BigInt(Math.round(Math.sqrt(3e-9) * 2 ** 96));
    expect(v3PriceToken1PerToken0(sqrt, 18, 6)).toBeCloseTo(3000, 6);
  });

  it("decodes V2 reserves with different decimals", () => {
    expect(v2PriceToken1PerToken0(10n * 10n ** 18n, 30_000n * 10n ** 6n, 18, 6)).toBeCloseTo(3000, 9);
    expect(v2PriceToken1PerToken0(0n, 1n, 18, 6)).toBe(0);
  });

  it("orients prices to the configured A/B pair", () => {
    expect(orientPrice(3000, true)).toBe(3000); // A is token0: B per A as is
    expect(orientPrice(1 / 3000, false)).toBeCloseTo(3000, 9); // A is token1: invert
  });

  it("the fee band of two pools is ~ the sum of their fees", () => {
    const g = gapVersusFees(3000, 3000, 0.0005, 0.003);
    expect(g.bandBps).toBeCloseTo(35.1, 1); // 1/((1-0.0005)(1-0.003)) - 1 = 35.1 bps
    expect(g.gapBps).toBe(0);
    expect(g.excessBps).toBeLessThan(0);
  });

  it("a gap smaller than the band is not an opportunity; a larger one is, by the right amount", () => {
    expect(gapVersusFees(3009, 3000, 0.0005, 0.003).excessBps).toBeLessThan(0); // 30 bps gap < 35.1 band
    const g = gapVersusFees(3000, 3015, 0.0005, 0.003); // 50 bps gap
    expect(g.excessBps).toBeGreaterThan(14);
    expect(g.excessBps).toBeLessThan(15);
    expect(g.sellAIn).toBe(1); // A is more expensive in pool 1: sell A there
  });
});

describe("episode tracking", () => {
  it("opens, extends, records the peak, and closes an episode", () => {
    const t = new EpisodeTracker();
    expect(t.observe("p", 100, -5)).toBeUndefined();
    expect(t.observe("p", 101, 2)).toBeDefined(); // opens
    expect(t.observe("p", 102, 7)).toBeUndefined(); // extends, new peak
    t.observe("p", 104, 1);
    t.observe("p", 105, -1); // closes
    const [e] = t.closed;
    expect(e).toMatchObject({ startBlock: 101, endBlock: 104, observations: 3, peakExcessBps: 7, peakBlock: 102 });
    expect(durationBlocks(e!)).toBe(4);
  });

  it("keeps pool pairs independent and flags episodes still open at the end", () => {
    const t = new EpisodeTracker();
    t.observe("a", 1, 3);
    t.observe("b", 1, 4);
    t.observe("a", 2, -1);
    const all = t.finish();
    expect(all).toHaveLength(2);
    expect(all.find((e) => e.key === "a")!.openAtEnd).toBe(false);
    expect(all.find((e) => e.key === "b")!.openAtEnd).toBe(true);
  });
});
