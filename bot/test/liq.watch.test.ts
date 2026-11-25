import { Interface } from "ethers";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.js";
import { mcIface, MULTICALL3 } from "../src/monitor/reader.js";
import { BORROW_SIG, borrowerFromLog, classify, estimate, findAssets, type AccountHealth } from "../src/liquidations/watch.js";
import { formatCycle, runCycle } from "../src/liquidations/watchRun.js";
import { ONE, FakeChain, POOL, USDC, WETH } from "./liq.fakechain.js";
import { id } from "ethers";

const cfg = loadConfig(new URL("../strategies.config.json", import.meta.url).pathname);
const acct = (hf: number, debt = 10_000): AccountHealth => ({ user: "0xabc", totalCollateralUsd: debt * 1.2, totalDebtUsd: debt, hf });
const as = { bonusPct: 5, gasPriceGwei: 0.02, ethUsd: 3000 };

describe("classify", () => {
  it("bands", () => {
    expect(classify(acct(Infinity, 0))).toBe("no_debt");
    expect(classify(acct(0.99))).toBe("liquidatable");
    expect(classify(acct(1.0))).toBe("at_risk");
    expect(classify(acct(1.019))).toBe("at_risk");
    expect(classify(acct(1.05))).toBe("watch");
    expect(classify(acct(1.5))).toBe("healthy");
  });
});

describe("estimate (same risk limits as the arbitrage bot)", () => {
  it("50% close factor between 0.95 and 1, 100% below 0.95", () => {
    expect(estimate(acct(0.97), cfg, as).closeFactor).toBe(0.5);
    expect(estimate(acct(0.9), cfg, as).closeFactor).toBe(1);
  });
  it("would attempt a big liquidatable account", () => {
    const e = estimate(acct(0.97, 100_000), cfg, as);
    expect(e.coverUsd).toBe(50_000); // 50% of 100k, also exactly the maxTradeSizeUsd cap
    expect(e.grossBonusUsd).toBeCloseTo(2_500);
    expect(e.decision).toBe("would_attempt");
  });
  it("caps the cover at maxTradeSizeUsd", () => {
    expect(estimate(acct(0.9, 1_000_000), cfg, as).coverUsd).toBe(cfg.risk.maxTradeSizeUsd);
  });
  it("rejects dust below the minimum net profit", () => {
    const e = estimate(acct(0.97, 20), cfg, as);
    expect(e.decision).toBe("rejected");
    expect(e.reason).toMatch(/net/);
  });
  it("rejects when gas is above the risk limit", () => {
    const e = estimate(acct(0.97, 100_000), cfg, { ...as, gasPriceGwei: cfg.risk.maxGasPriceGwei + 1 });
    expect(e.decision).toBe("rejected");
    expect(e.reason).toMatch(/gas/);
  });
  it("never attempts a healthy account", () => {
    expect(estimate(acct(1.2, 100_000), cfg, as).decision).toBe("rejected");
  });
});

describe("borrowerFromLog", () => {
  it("takes onBehalfOf (2nd indexed topic)", () => {
    const pad = (a: string) => "0x" + "0".repeat(24) + a.slice(2);
    const user = "0x00000000000000000000000000000000000b0b01";
    expect(borrowerFromLog({ topics: [id(BORROW_SIG), pad(WETH), pad(user), "0x0"] })).toBe(user);
    expect(borrowerFromLog({ topics: [id(BORROW_SIG)] })).toBeUndefined();
  });
});

describe("runCycle on a fake chain", () => {
  const users = ["0x0000000000000000000000000000000000000001", "0x0000000000000000000000000000000000000002", "0x0000000000000000000000000000000000000003", "0x0000000000000000000000000000000000000004"];
  const hfs: Record<string, bigint> = {
    [users[0]!]: (ONE * 97n) / 100n, // liquidatable
    [users[1]!]: (ONE * 101n) / 100n, // at risk
    [users[2]!]: ONE * 2n, // healthy
  };
  const chain = new FakeChain({
    latest: 1000,
    logs: [],
    hf: (u) => (hfs[u] ? { debtBase: 100_000n * 10n ** 8n, healthFactor: hfs[u]! } : { debtBase: 0n, healthFactor: 2n ** 256n - 1n }),
  });
  const ctx = { pool: POOL, baseUnit: 10n ** 8n, cfg, thresholds: { atRisk: 1.02, watch: 1.1 }, assumptions: as };

  it("counts bands, sorts by health factor, estimates only liquidatable accounts, stays dry-run", async () => {
    const r = await runCycle(chain, ctx, users);
    expect(r.dryRun).toBe(true);
    expect(r.counts).toMatchObject({ liquidatable: 1, at_risk: 1, healthy: 1, no_debt: 1, watch: 0 });
    expect(r.rows.map((x) => x.band)).toEqual(["liquidatable", "at_risk"]);
    expect(r.rows[0]!.estimate?.decision).toBe("would_attempt");
    expect(r.rows[1]!.estimate).toBeUndefined();
    expect(formatCycle(r)).toMatch(/DRY-RUN would attempt/);
  });

  it("counts failed reads instead of hiding or crashing", async () => {
    const broken = new FakeChain({ latest: 1000, logs: [], hf: () => { throw new Error("boom"); } });
    const r = await runCycle(broken, ctx, users);
    expect(r.readFailures).toBe(4);
    expect(r.rows).toEqual([]);
  });
});

describe("findAssets", () => {
  const dp = "0x00000000000000000000000000000000000000dd";
  const iface = new Interface([
    "function getUserReserveData(address asset, address user) view returns (uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint40,bool)",
  ]);
  const stub = (balances: Record<string, { coll: bigint; debt: bigint; useAsColl: boolean }>) => ({
    async request(_m: string, params: unknown[]) {
      const [inner] = mcIface.decodeFunctionData("aggregate3", (params[0] as any).data);
      const results = (inner as any[]).map((c) => {
        const [asset] = iface.decodeFunctionData("getUserReserveData", c[2]);
        const b = balances[(asset as string).toLowerCase()] ?? { coll: 0n, debt: 0n, useAsColl: false };
        return { success: true, returnData: iface.encodeFunctionResult("getUserReserveData", [b.coll, 0n, b.debt, 0n, 0n, 0n, 0n, 0, b.useAsColl]) };
      });
      expect((params[0] as any).to.toLowerCase()).toBe(MULTICALL3.toLowerCase());
      return mcIface.encodeFunctionResult("aggregate3", [results]);
    },
  });

  it("picks the biggest debt and collateral and the lender for the debt asset", async () => {
    const rpc = stub({
      [WETH.toLowerCase()]: { coll: 10n * 10n ** 18n, debt: 0n, useAsColl: true },
      [USDC.toLowerCase()]: { coll: 0n, debt: 20_000n * 10n ** 6n, useAsColl: false },
    });
    const a = await findAssets(rpc, dp, cfg, "0x00000000000000000000000000000000000b0b01");
    expect(a.debtSymbol).toBe("USDC");
    expect(a.collateralSymbol).toBe("WETH");
    expect(a.lender).toBe("uniswapV4"); // only V4 lends USDC in strategies.config.json
  });

  it("ignores collateral that is switched off", async () => {
    const rpc = stub({ [WETH.toLowerCase()]: { coll: 10n * 10n ** 18n, debt: 0n, useAsColl: false } });
    expect((await findAssets(rpc, dp, cfg, "0x00000000000000000000000000000000000b0b01")).collateralSymbol).toBeUndefined();
  });
});
