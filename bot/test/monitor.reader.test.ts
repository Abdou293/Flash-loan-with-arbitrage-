import { describe, expect, it } from "vitest";
import { ARBSYS, arbSysIface, erc20Iface, GapReader, MULTICALL3, mcIface, poolIface, routerIface, v2FactoryIface, v3FactoryIface, type CallFn } from "../src/monitor/reader.js";
import { config } from "./helpers.js";

/**
 * A fake chain behind Multicall3: every inner call is decoded and answered from a small in-memory model,
 * so the real ABI encoding/decoding of the reader is exercised without any network.
 */
function fakeChain(opts: { block: number; wethUsdcV3: number; wethUsdcV2: number; l2Block?: number }) {
  const weth = config.tokens["WETH"]!.address.toLowerCase();
  const usdc = config.tokens["USDC"]!.address.toLowerCase();
  const V3F = "0x00000000000000000000000000000000000000f3";
  const V2F = "0x00000000000000000000000000000000000000f2";
  const poolFor = (key: string) => "0x" + Buffer.from(key).toString("hex").padEnd(40, "0").slice(0, 40);
  const sqrtFor = (usdcPerWeth: number) => BigInt(Math.round(Math.sqrt((usdcPerWeth * 1e6) / 1e18) * 2 ** 96));
  let calls = 0;

  const answer = (target: string, data: string): string => {
    const t = target.toLowerCase();
    const sel = data.slice(0, 10);
    if (t === MULTICALL3.toLowerCase()) return mcIface.encodeFunctionResult("getBlockNumber", [opts.block]);
    if (t === ARBSYS.toLowerCase()) {
      if (opts.l2Block === undefined) throw new Error("not arbitrum");
      return arbSysIface.encodeFunctionResult("arbBlockNumber", [opts.l2Block]);
    }
    if (sel === routerIface.getFunction("factory")!.selector) {
      const v2 = config.venues.find((v) => v.kind === "uniV2")!.router.toLowerCase();
      return routerIface.encodeFunctionResult("factory", [t === v2 ? V2F : V3F]);
    }
    if (t === V3F) {
      const [a, b, fee] = v3FactoryIface.decodeFunctionData("getPool", data);
      const pairOk = [a, b].map((x: string) => x.toLowerCase()).sort().join() === [weth, usdc].sort().join();
      return v3FactoryIface.encodeFunctionResult("getPool", [pairOk && fee === 500n ? poolFor("v3-500") : "0x" + "0".repeat(40)]);
    }
    if (t === V2F) {
      const [a, b] = v2FactoryIface.decodeFunctionData("getPair", data);
      const pairOk = [a, b].map((x: string) => x.toLowerCase()).sort().join() === [weth, usdc].sort().join();
      return v2FactoryIface.encodeFunctionResult("getPair", [pairOk ? poolFor("v2") : "0x" + "0".repeat(40)]);
    }
    if (sel === erc20Iface.getFunction("balanceOf")!.selector) {
      // every pool holds 100 WETH and 300k USDC
      return erc20Iface.encodeFunctionResult("balanceOf", [t === weth ? 100n * 10n ** 18n : 300_000n * 10n ** 6n]);
    }
    if (sel === poolIface.getFunction("token0")!.selector) return poolIface.encodeFunctionResult("token0", [config.tokens["WETH"]!.address]);
    if (sel === poolIface.getFunction("slot0")!.selector) return poolIface.encodeFunctionResult("slot0", [sqrtFor(opts.wethUsdcV3), 0, 0, 0, 0, 0, true]);
    if (sel === poolIface.getFunction("getReserves")!.selector) {
      return poolIface.encodeFunctionResult("getReserves", [10n * 10n ** 18n, BigInt(Math.round(opts.wethUsdcV2 * 10 * 1e6)), 0]);
    }
    throw new Error("unexpected call " + sel);
  };

  const call: CallFn = async ({ to, data }) => {
    calls++;
    expect(to.toLowerCase()).toBe(MULTICALL3.toLowerCase()); // everything goes through ONE multicall
    const [inner] = mcIface.decodeFunctionData("aggregate3", data);
    const results = (inner as any[]).map((c) => {
      try {
        return { success: true, returnData: answer(c[0], c[2]) };
      } catch {
        return { success: false, returnData: "0x" };
      }
    });
    return mcIface.encodeFunctionResult("aggregate3", [results]);
  };
  return { call, count: () => calls };
}

describe("GapReader (Multicall3)", () => {
  it("discovers pools through the routers' factories and skips pools that do not exist", async () => {
    const chain = fakeChain({ block: 123, wethUsdcV3: 3000, wethUsdcV2: 3010 });
    const reader = new GapReader(config, chain.call);
    const pools = await reader.init();
    expect(pools.map((p) => p.id).sort()).toEqual(["sushiV2-3000:WETH/USDC", "uniV3-500:WETH/USDC"]);
    expect(pools.every((p) => p.aIsToken0)).toBe(true);
    expect(pools[0]!.balanceA).toBe(100n * 10n ** 18n); // pool depth read for the dead-pool filter
    expect(pools[0]!.balanceB).toBe(300_000n * 10n ** 6n);
  });

  it("reads every pool and the block number in ONE call per poll, with correct prices", async () => {
    const chain = fakeChain({ block: 777, wethUsdcV3: 3000, wethUsdcV2: 3010 });
    const reader = new GapReader(config, chain.call);
    await reader.init();
    const before = chain.count();
    const snap = await reader.read();
    expect(chain.count() - before).toBe(1);
    expect(snap.block).toBe(777); // not Arbitrum: falls back to Multicall3's block.number
    expect(snap.prices.get("uniV3-500:WETH/USDC")).toBeCloseTo(3000, 3);
    expect(snap.prices.get("sushiV2-3000:WETH/USDC")).toBeCloseTo(3010, 6);
  });

  it("on Arbitrum uses the L2 block number from ArbSys, not block.number (which is the L1 block there)", async () => {
    const chain = fakeChain({ block: 26_486_437, l2Block: 526_966_102, wethUsdcV3: 3000, wethUsdcV2: 3010 });
    const reader = new GapReader(config, chain.call);
    await reader.init();
    const snap = await reader.read();
    expect(snap.block).toBe(526_966_102);
    expect(snap.prices.get("uniV3-500:WETH/USDC")).toBeCloseTo(3000, 3); // pool data still lines up after the extra call
  });
});
