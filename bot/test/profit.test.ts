import { describe, expect, it } from "vitest";
import { computeProfit, quoteRoute } from "../src/core/profit.js";
import { fromHuman } from "../src/core/units.js";
import { FakeMarket, config } from "./helpers.js";

const weth = config.tokens["WETH"]!;
const usdc = config.tokens["USDC"]!;

describe("profit calculator", () => {
  it("subtracts flash-loan fee, slippage reserve and gas from the gross profit (fee-charging lender)", async () => {
    const amountIn = fromHuman(100_000, usdc); // $100k
    const amountOut = fromHuman(100_500, usdc); // +$500 gross
    const p = await computeProfit({
      borrowToken: usdc, amountIn, amountOut, steps: 2, gasPriceGwei: 0.1,
      market: new FakeMarket(), cfg: { ...config.global, flashLoanFeeBps: 5 }, weth,
    });
    expect(p.grossUsd).toBeCloseTo(500, 1);
    expect(p.flashLoanFeeUsd).toBeCloseTo(50, 1); // 5 bps of 100k
    expect(p.slippageReserveUsd).toBeCloseTo(100.5, 1); // 10 bps of 100.5k
    // gas: (350000 + 2*150000) units * 0.1 gwei = 0.065 ETH-ish * 1e-9... = 0.000065 ETH * $3000
    expect(p.gasCostUsd).toBeCloseTo(650000 * 0.1e-9 * 3000, 4);
    expect(p.netUsd).toBeCloseTo(500 - 50 - 100.5 - p.gasCostUsd, 1);
  });

  it("charges no loan fee with the default zero-interest lender", async () => {
    const p = await computeProfit({
      borrowToken: usdc, amountIn: fromHuman(100_000, usdc), amountOut: fromHuman(100_500, usdc), steps: 2,
      gasPriceGwei: 0.1, market: new FakeMarket(), cfg: config.global, weth,
    });
    expect(config.global.flashLoanFeeBps).toBe(0);
    expect(p.flashLoanFee).toBe(0n);
  });

  it("is negative when the route loses money", async () => {
    const p = await computeProfit({
      borrowToken: usdc, amountIn: fromHuman(1000, usdc), amountOut: fromHuman(990, usdc), steps: 2,
      gasPriceGwei: 0.02, market: new FakeMarket(), cfg: config.global, weth,
    });
    expect(p.net < 0n).toBe(true);
  });

  it("quoteRoute returns 0 when any step cannot be quoted", async () => {
    const venue = config.venues[0]!;
    const m = new FakeMarket(() => 0);
    const out = await quoteRoute([{ venue, tokenIn: weth, tokenOut: usdc }], fromHuman(1, weth), m);
    expect(out).toBe(0n);
  });
});
