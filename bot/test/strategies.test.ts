import { describe, expect, it } from "vitest";
import { bestSizeCandidate } from "../src/core/profit.js";
import type { NewPool } from "../src/core/types.js";
import { ALL_STRATEGIES } from "../src/strategies/registry.js";
import { FakeMarket, config } from "./helpers.js";

const ctx = (name: string, market = new FakeMarket()) => ({
  market, tokens: config.tokens, venues: config.venues, params: config.strategies[name],
});
const weth = config.tokens["WETH"]!;
const evalRoute = async (route: any, market: FakeMarket) =>
  bestSizeCandidate({ strategy: "t", route, market, cfg: config.global, maxTradeSizeUsd: 50_000, weth });

describe("strategies propose valid round-trip routes", () => {
  for (const name of ["crossDex", "triangular", "feeTier"]) {
    it(`${name}: every route starts and ends in the same token`, async () => {
      const routes = await ALL_STRATEGIES[name]!.routes(ctx(name));
      expect(routes.length).toBeGreaterThan(0);
      for (const r of routes) expect(r[0]!.tokenIn.symbol).toBe(r[r.length - 1]!.tokenOut.symbol);
    });
  }

  it("crossDex only pairs different DEXs; feeTier only pairs different V3 fee tiers", async () => {
    for (const r of await ALL_STRATEGIES["crossDex"]!.routes(ctx("crossDex"))) expect(r[0]!.venue.dex).not.toBe(r[1]!.venue.dex);
    for (const r of await ALL_STRATEGIES["feeTier"]!.routes(ctx("feeTier"))) {
      expect(r[0]!.venue.kind).toBe("uniV3");
      expect(r[0]!.venue.fee).not.toBe(r[1]!.venue.fee);
    }
  });

  it("no spread => every route is unprofitable (fees make round trips lose money)", async () => {
    const m = new FakeMarket();
    for (const r of await ALL_STRATEGIES["crossDex"]!.routes(ctx("crossDex", m))) {
      const c = await evalRoute(r, m);
      expect(c!.profit.net < 0n).toBe(true);
    }
  });

  it("a 2% price gap on sushi is detected as profitable by crossDex", async () => {
    const m = new FakeMarket((v, a, b) => (v === "sushiV2-3000" && a === "WETH" && b === "USDC" ? 1.02 : 1));
    const routes = await ALL_STRATEGIES["crossDex"]!.routes(ctx("crossDex", m));
    const results = await Promise.all(routes.map((r) => evalRoute(r, m)));
    expect(results.some((c) => c && c.profit.netUsd > 1)).toBe(true);
  });
});

describe("newPoolScanner safety filters", () => {
  const usdc = config.tokens["USDC"]!;
  const mk = (over: Partial<NewPool>): NewPool => ({
    base: weth,
    newToken: { symbol: "NEWT", address: "0x1", decimals: 18 },
    venues: [config.venues[1]!, config.venues[3]!],
    ageMinutes: 60, liquidityUsd: 100_000, sellable: true, taxBps: 0, ...over,
  });
  const run = (pools: NewPool[]) => ALL_STRATEGIES["newPoolScanner"]!.routes(ctx("newPoolScanner", new FakeMarket(() => 1, pools)));

  it("accepts a healthy pool", async () => expect((await run([mk({})])).length).toBe(2));
  it("skips honeypots (not sellable)", async () => expect(await run([mk({ sellable: false })])).toEqual([]));
  it("skips low liquidity, too-new pools and high-tax tokens", async () => {
    expect(await run([mk({ liquidityUsd: 1000 })])).toEqual([]);
    expect(await run([mk({ ageMinutes: 1 })])).toEqual([]);
    expect(await run([mk({ taxBps: 500 })])).toEqual([]);
  });
  it("skips base tokens that are not whitelisted", async () => {
    const arb = config.tokens["ARB"]!;
    expect(await run([mk({ base: arb })])).toEqual([]);
    expect((await run([mk({ base: usdc })])).length).toBe(2); // USDC is whitelisted in the config
  });
});
