import { AbiCoder } from "ethers";
import { describe, expect, it } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { lenderFor, loadConfig } from "../src/config/load.js";
import { poolTvlUsd, usdPricesFrom } from "../src/monitor/math.js";
import { sqrtPriceFromSlot0 } from "../src/monitor/reader.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("radar: PancakeSwap-safe slot0 decoding", () => {
  it("reads sqrtPriceX96 from the first word even when later fields do not fit Uniswap's types", () => {
    const sqrt = 4339505179874779489431521n; // arbitrary 160-bit value
    // PancakeSwap V3 slot0: (uint160,int24,uint16,uint16,uint16,uint32 feeProtocol,bool)
    const data = AbiCoder.defaultAbiCoder().encode(
      ["uint160", "int24", "uint16", "uint16", "uint16", "uint32", "bool"],
      [sqrt, -1234, 1, 2, 3, 4_000_000_000, true],
    );
    expect(sqrtPriceFromSlot0(data)).toBe(sqrt);
  });
});

describe("radar: pool sizing (dead-pool filter)", () => {
  it("derives USD prices through stablecoin and WETH pools", () => {
    const usd = usdPricesFrom([
      { a: "WETH", b: "USDC", price: 3000 },
      { a: "ARB", b: "WETH", price: 0.0002 }, // 0.0002 WETH per ARB
      { a: "WBTC", b: "WETH", price: 30 },
    ]);
    expect(usd.get("USDC")).toBe(1);
    expect(usd.get("WETH")).toBe(3000);
    expect(usd.get("ARB")).toBeCloseTo(0.6, 9);
    expect(usd.get("WBTC")).toBeCloseTo(90000, 6);
  });

  it("values a pool from its raw balances, and refuses when anything is unknown", () => {
    const tvl = poolTvlUsd(10n * 10n ** 18n, 18, 3000, 30_000n * 10n ** 6n, 6, 1);
    expect(tvl).toBeCloseTo(60_000, 6);
    expect(poolTvlUsd(undefined, 18, 3000, 1n, 6, 1)).toBeUndefined();
    expect(poolTvlUsd(1n, 18, undefined, 1n, 6, 1)).toBeUndefined();
  });
});

describe("config: radar extension and lenders", () => {
  const base = loadConfig(join(here, "..", "strategies.config.json"));
  const radar = loadConfig(join(here, "..", "radar.config.json"));

  it("radar.config.json adds tokens and venues on top of the base config", () => {
    expect(Object.keys(radar.tokens).length).toBeGreaterThan(Object.keys(base.tokens).length);
    expect(radar.tokens["WETH"]).toEqual(base.tokens["WETH"]);
    expect(radar.venues.length).toBeGreaterThan(base.venues.length);
    for (const v of base.venues) expect(radar.venues.map((x) => x.id)).toContain(v.id);
    expect(radar.venues.find((v) => v.dex === "pancakeswap")?.quoter).toMatch(/^0x/);
  });

  it("only zero-interest lenders are configured, and the first lender that holds a token is chosen", () => {
    expect(base.flashLoan.lenders.map((l) => l.provider).sort()).toEqual(["balancerV2", "uniswapV4"]);
    expect(lenderFor(base.flashLoan, "WETH")?.provider).toBe("balancerV2"); // listed first
    expect(lenderFor(base.flashLoan, "USDC")?.provider).toBe("uniswapV4"); // Balancer holds too little USDC
    expect(lenderFor(base.flashLoan, "ARB")).toBeUndefined();
    expect(base.flashLoan.borrowable.sort()).toEqual(["USDC", "WETH"]);
  });
});
