import { describe, expect, it } from "vitest";
import { RiskEngine } from "../src/core/risk.js";
import { SampleMarket } from "../src/core/market/SampleMarket.js";
import { QuoteOnlySimulator, SampleSimulator, type Simulator } from "../src/core/simulator.js";
import { Store } from "../src/core/store.js";
import { Engine } from "../src/engine.js";
import { FakeMarket, config } from "./helpers.js";

const sample = (seed: number) => new SampleMarket({ seed, tokenUsd: config.tokenUsd, venues: config.venues, tokens: config.tokens });
const mkEngine = (market: any, simulator: Simulator, risk = new RiskEngine(config.risk), dryRun = true) =>
  new Engine({ config, market, simulator, store: new Store(null), risk, dryRun });

describe("engine (dry-run)", () => {
  it("refuses to run when dryRun is false", () => {
    expect(() => mkEngine(sample(1), new QuoteOnlySimulator(), undefined, false)).toThrow(/not implemented/);
  });

  it("enables only strategies switched on in the config", () => {
    const cfg = structuredClone(config);
    cfg.strategies["triangular"]!.enabled = false;
    cfg.strategies["newPoolScanner"]!.enabled = false;
    const e = new Engine({ config: cfg, market: sample(1), simulator: new QuoteOnlySimulator(), store: new Store(null), risk: new RiskEngine(cfg.risk), dryRun: true });
    expect(e.enabledStrategies).toEqual(["crossDex", "feeTier"]);
  });

  it("synthetic runs are reproducible from the seed", async () => {
    const run = async () => {
      const e = mkEngine(sample(7), new SampleSimulator(7));
      const all = [];
      for (let i = 0; i < 15; i++) all.push(...(await e.runCycle()).map((o) => [o.strategy, o.route, o.netProfitUsd, o.status]));
      return all;
    };
    expect(await run()).toEqual(await run());
  });

  it("records simulated opportunities and tags the data source", async () => {
    const m = new FakeMarket((v, a, b) => (v === "sushiV2-3000" && a === "WETH" && b === "USDC" ? 1.02 : 1));
    const found = await mkEngine(m, new QuoteOnlySimulator()).runCycle();
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((o) => o.dataSource === "synthetic")).toBe(true);
    expect(found.some((o) => o.status === "simulated_ok" && o.netProfitUsd > 0)).toBe(true);
  });

  it("never proposes a loan the zero-interest lender cannot supply (only WETH is borrowable)", async () => {
    const m = new FakeMarket((v, a) => (v === "sushiV2-3000" && a === "ARB" ? 1.05 : v === "sushiV2-3000" && a === "WETH" ? 1.02 : 1));
    const found = await mkEngine(m, new QuoteOnlySimulator()).runCycle();
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((o) => config.flashLoan.borrowable.includes(o.borrowToken))).toBe(true);
    expect(found.some((o) => o.borrowToken === "ARB")).toBe(false);
  });

  it("auto-pauses after consecutive simulation failures and then skips opportunities", async () => {
    const failing: Simulator = { simulate: async () => ({ ok: false, reason: "boom" }) };
    const risk = new RiskEngine({ ...config.risk, maxConsecutiveFailures: 2 });
    const m = new FakeMarket((v, a, b) => (v === "sushiV2-3000" && a === "WETH" && b === "USDC" ? 1.02 : 1));
    const found = await mkEngine(m, failing, risk).runCycle();
    expect(risk.paused).toBe(true);
    expect(found.filter((o) => o.status === "simulated_revert").length).toBe(2);
    expect(found.some((o) => o.status === "skipped_paused")).toBe(true);
  });
});
