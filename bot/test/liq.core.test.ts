import { describe, expect, it } from "vitest";
import { decodeLiquidationLog, eventId, LIQUIDATION_CALL_TOPIC } from "../src/liquidations/aave.js";
import { liquidatableForBlocks } from "../src/liquidations/delay.js";
import { accountAt, blockTimestamp, computeEconomics, fetchPrices, fetchTokenMeta, isLiquidatableAt, multicall, resolveAave } from "../src/liquidations/enrich.js";
import { markRepeats, parseEvent, pickSample, serializeEvent } from "../src/liquidations/sample.js";
import type { EnrichedEvent } from "../src/liquidations/report.js";
import { BOT1, FakeChain, liqLog, ONE, ORACLE, POOL, PROVIDER, USDC, WETH } from "./liq.fakechain.js";

const USER = "0x00000000000000000000000000000000000000a1";

describe("LiquidationCall decoding", () => {
  it("decodes a log into a typed event", () => {
    const log = liqLog({ block: 12345, idx: 7, user: USER, liquidator: BOT1, debtToCover: 1_500_000_000n, collateralAmount: 5n * 10n ** 17n });
    expect(log.topics[0]).toBe(LIQUIDATION_CALL_TOPIC);
    const e = decodeLiquidationLog(log);
    expect(e).toMatchObject({ block: 12345, logIndex: 7, user: USER, liquidator: BOT1, collateralAsset: WETH, debtAsset: USDC, debtToCover: 1_500_000_000n, collateralAmount: 5n * 10n ** 17n });
    expect(eventId(e)).toBe(`${log.transactionHash}:7`);
  });
  it("rejects a log of another event", () => {
    const log = liqLog({ block: 1, user: USER, liquidator: BOT1, debtToCover: 1n, collateralAmount: 1n });
    expect(() => decodeLiquidationLog({ ...log, topics: ["0x" + "11".repeat(32), ...log.topics.slice(1)] })).toThrow();
  });
});

describe("economics (USD and bonus at oracle prices)", () => {
  it("computes size, bonus and gross bonus", () => {
    // repay 1,000 USDC (6 dec) at $1 and receive 0.35 WETH (18 dec) at $3,000 = $1,050: a 5% bonus
    const x = computeEconomics({ debtToCover: 1_000n * 10n ** 6n, collateralAmount: 35n * 10n ** 16n }, 10n ** 8n, 3_000n * 10n ** 8n, 6, 18, 10n ** 8n);
    expect(x.debtUsd).toBeCloseTo(1000, 6);
    expect(x.collUsd).toBeCloseTo(1050, 6);
    expect(x.bonusPct).toBeCloseTo(5, 6);
    expect(x.grossBonusUsd).toBeCloseTo(50, 6);
  });
  it("handles a zero-debt event without dividing by zero", () => {
    expect(computeEconomics({ debtToCover: 0n, collateralAmount: 0n }, 1n, 1n, 6, 18, 10n ** 8n).bonusPct).toBe(0);
  });
});

describe("on-chain reads through the fake chain", () => {
  const chain = new FakeChain({ latest: 5000, logs: [], time: (b) => 1_700_000_000 + b });

  it("resolves provider and oracle from the pool, with no hard-coded oracle", async () => {
    const a = await resolveAave(chain, POOL);
    expect(a.pool).toBe(POOL);
    expect(a.provider.toLowerCase()).toBe(PROVIDER); // ethers returns checksummed addresses
    expect(a.oracle.toLowerCase()).toBe(ORACLE);
    expect(a.baseUnit).toBe(10n ** 8n);
  });
  it("refuses a pool whose provider does not point back to it", async () => {
    await expect(resolveAave(chain, "0x00000000000000000000000000000000000000ff")).rejects.toThrow();
  });
  it("reads token symbols/decimals and prices at a block, batched in one call each", async () => {
    const before = chain.counts["eth_call"] ?? 0;
    const meta = await fetchTokenMeta(chain, [WETH, USDC]);
    expect(meta[WETH]).toEqual({ symbol: "WETH", decimals: 18 });
    expect(meta[USDC]).toEqual({ symbol: "USDC", decimals: 6 });
    const prices = await fetchPrices(chain, ORACLE, [WETH, USDC, WETH], 4000);
    expect(prices.get(WETH)).toBe(3_000n * 10n ** 8n);
    expect(chain.counts["eth_call"]! - before).toBe(2);
  });
  it("a price that cannot be read is simply absent, not an error", async () => {
    const c = new FakeChain({ latest: 100, logs: [], oracleFrom: 50 });
    expect((await fetchPrices(c, ORACLE, [WETH], 10)).size).toBe(0);
    expect((await fetchPrices(c, ORACLE, [WETH], 60)).size).toBe(1);
  });
  it("reads a borrower's health factor at a given block", async () => {
    const c = new FakeChain({ latest: 100, logs: [], hf: (_u, b) => ({ debtBase: 10n ** 9n, healthFactor: b >= 60 ? ONE - 1n : ONE + 5n }) });
    expect(await isLiquidatableAt(c, POOL, USER, 59)).toBe(false);
    expect(await isLiquidatableAt(c, POOL, USER, 60)).toBe(true);
    expect((await accountAt(c, POOL, USER, 60)).debtBase).toBe(10n ** 9n);
  });
  it("a borrower with no debt is never liquidatable", async () => {
    const c = new FakeChain({ latest: 100, logs: [], hf: () => ({ debtBase: 0n, healthFactor: 0n }) });
    expect(await isLiquidatableAt(c, POOL, USER, 50)).toBe(false);
  });
  it("reads block timestamps and batches arbitrary calls", async () => {
    expect(await blockTimestamp(chain, 1234)).toBe(1_700_001_234);
    expect((await multicall(chain, [])).length).toBe(0);
  });
});

describe("how long was a position liquidatable? (binary search over past blocks)", () => {
  const from = (firstLiquidatable: number) => async (b: number) => b >= firstLiquidatable;

  it("0 when it only became liquidatable inside the liquidation block (same-block liquidation)", async () => {
    const r = await liquidatableForBlocks(from(1000), 1000, 20000);
    expect(r).toMatchObject({ blocks: 0, censored: false });
    expect(r.calls).toBe(1);
  });
  it("1 when it was liquidatable at the end of the previous block", async () => {
    expect((await liquidatableForBlocks(from(999), 1000, 20000)).blocks).toBe(1);
  });
  it("finds the exact start for any delay, with about 2*log2 queries", async () => {
    for (const delay of [2, 3, 7, 50, 333, 4000, 19999]) {
      const r = await liquidatableForBlocks(from(1_000_000 - delay), 1_000_000, 20000);
      expect(r.blocks).toBe(delay);
      expect(r.censored).toBe(false);
      expect(r.calls).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(20000)) + 3);
    }
  });
  it("reports a lower bound when it was already liquidatable at the lookback limit", async () => {
    const r = await liquidatableForBlocks(async () => true, 1_000_000, 500);
    expect(r).toMatchObject({ blocks: 500, censored: true });
  });
  it("propagates RPC failures so the caller can mark the sample as failed", async () => {
    await expect(liquidatableForBlocks(async () => { throw new Error("missing trie node"); }, 100, 50)).rejects.toThrow(/trie/);
  });
});

describe("sampling helpers", () => {
  const ev = (block: number, user: string, idx = 0): EnrichedEvent =>
    ({ block, user, logIndex: idx, txHash: "0x" + block, txIndex: 0, collateralAsset: WETH, debtAsset: USDC, liquidator: BOT1, debtToCover: 5n, collateralAmount: 6n, receiveAToken: false, timestamp: 0, debtSymbol: "USDC", collSymbol: "WETH" }) as EnrichedEvent;

  it("flags a borrower liquidated again within the lookback", () => {
    const evs = [ev(100, "a"), ev(5000, "b"), ev(900, "a"), ev(50_000, "a")];
    const n = markRepeats(evs, 1000);
    expect(n).toBe(1);
    expect(evs.map((e) => [e.block, e.repeatUser])).toEqual([[100, false], [900, true], [5000, false], [50_000, false]]);
  });
  it("picks an even, deterministic sample", () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const s = pickSample(items, 10);
    expect(s).toEqual([5, 15, 25, 35, 45, 55, 65, 75, 85, 95]);
    expect(pickSample(items, 200)).toHaveLength(100);
    expect(pickSample(items, 0)).toEqual([]);
  });
  it("round-trips events through JSON with bigint fields", () => {
    const e = ev(10, "a");
    const back = parseEvent(JSON.parse(serializeEvent(e)));
    expect(back.debtToCover).toBe(5n);
    expect(back.collateralAmount).toBe(6n);
  });
});
