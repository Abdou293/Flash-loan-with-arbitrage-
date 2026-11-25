import { describe, expect, it } from "vitest";
import { LIQUIDATION_CALL_TOPIC } from "../src/liquidations/aave.js";
import { addInterval, classifyLogsError, missingIntervals, probeLogLimit, scanLogs, type Interval, type ScanState } from "../src/liquidations/logs.js";
import { isTransient, redact, ThrottledRpc } from "../src/liquidations/rpc.js";
import { BOT1, FakeChain, liqLog, POOL } from "./liq.fakechain.js";

const mkLogs = (blocks: number[]) => blocks.map((b, i) => liqLog({ block: b, idx: i, user: "0x0000000000000000000000000000000000000001", liquidator: BOT1, debtToCover: 1n, collateralAmount: 1n }));
const ids = (logs: { transactionHash: string; logIndex: string }[]) => logs.map((l) => l.transactionHash + l.logIndex).sort();

async function run(chain: FakeChain, from: number, to: number, state: ScanState, start = 100, extra: Partial<Parameters<typeof scanLogs>[0]> = {}) {
  const seen: any[] = [];
  const stats = await scanLogs({
    rpc: chain, address: POOL, topic0: LIQUIDATION_CALL_TOPIC, from, to, state,
    chunk: { start, min: 1, max: 10_000 },
    onLogs: (l) => void seen.push(...l),
    ...extra,
  });
  return { seen, stats };
}

describe("interval bookkeeping", () => {
  it("merges adjacent and overlapping intervals", () => {
    let d: Interval[] = [];
    d = addInterval(d, { from: 10, to: 20 });
    d = addInterval(d, { from: 30, to: 40 });
    d = addInterval(d, { from: 21, to: 29 });
    expect(d).toEqual([{ from: 10, to: 40 }]);
  });
  it("lists what is still missing", () => {
    const done = [{ from: 10, to: 20 }, { from: 40, to: 50 }];
    expect(missingIntervals(done, 1, 60)).toEqual([{ from: 1, to: 9 }, { from: 21, to: 39 }, { from: 51, to: 60 }]);
    expect(missingIntervals(done, 12, 18)).toEqual([]);
    expect(missingIntervals([], 5, 7)).toEqual([{ from: 5, to: 7 }]);
  });
});

describe("provider error classification", () => {
  it("recognises range / result-size limits and extracts the suggestion", () => {
    expect(classifyLogsError("Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range.")).toEqual({ kind: "range", suggestedSize: 10 });
    expect(classifyLogsError("query returned more than 10000 results")).toEqual({ kind: "range" });
    expect(classifyLogsError("Log response size exceeded. Try with this block range [0x1000, 0x10ff]")).toEqual({ kind: "range", suggestedSize: 256 });
    expect(classifyLogsError("exceeded maximum block range of 5000 blocks")).toMatchObject({ kind: "range", suggestedSize: 5000 });
    expect(classifyLogsError("invalid argument 0: hex string without 0x prefix").kind).toBe("other");
  });
  it("treats rate limits as transient and range limits as not", () => {
    expect(isTransient("429 Too Many Requests")).toBe(true);
    expect(isTransient("exceeded its compute units per second capacity")).toBe(true);
    expect(isTransient("you can make eth_getLogs requests with up to a 10 block range")).toBe(false);
  });
  it("redacts API keys", () => {
    expect(redact("failed https://arb-mainnet.g.alchemy.com/v2/alch_SECRET123 now")).not.toMatch(/SECRET123/);
    expect(redact("GET /api?module=logs&apikey=ABC123XYZ&x=1")).not.toMatch(/ABC123XYZ/);
  });
});

describe("scanLogs", () => {
  const events = [3, 7, 8, 55, 56, 120, 399, 400, 401, 777, 1000];

  it("adapts to a 10-block provider limit and returns every log exactly once, with no gaps", async () => {
    const chain = new FakeChain({ latest: 1000, logs: mkLogs(events), maxRange: 10 });
    const state: ScanState = { done: [] };
    const { seen, stats } = await run(chain, 1, 1000, state, 500);
    expect(ids(seen)).toEqual(ids(mkLogs(events)));
    expect(state.done).toEqual([{ from: 1, to: 1000 }]);
    expect(stats.ceiling).toBe(10);
    expect(stats.rangeErrors).toBeLessThanOrEqual(3); // learns the limit quickly from the provider's own message
    const okCalls = chain.getLogsCalls.filter((c) => c.to - c.from + 1 <= 10);
    expect(okCalls.length).toBeGreaterThanOrEqual(100);
  });

  it("halves the range when a chunk returns too many results, then still gets everything", async () => {
    const dense = Array.from({ length: 60 }, (_, i) => 100 + i);
    const chain = new FakeChain({ latest: 300, logs: mkLogs(dense), maxResults: 8 });
    const { seen, stats } = await run(chain, 1, 300, { done: [] }, 300);
    expect(ids(seen)).toEqual(ids(mkLogs(dense)));
    expect(stats.rangeErrors).toBeGreaterThan(0);
  });

  it("resumes after a crash: finished chunks are not requested again and nothing is lost or duplicated", async () => {
    const all = mkLogs(events);
    const state: ScanState = { done: [] };
    const stored: any[] = [];
    let chunks = 0;
    const chain1 = new FakeChain({ latest: 1000, logs: all });
    await expect(
      scanLogs({
        rpc: chain1, address: POOL, topic0: LIQUIDATION_CALL_TOPIC, from: 1, to: 1000, state,
        chunk: { start: 100, min: 1, max: 100 },
        onLogs: (l) => void stored.push(...l),
        onChunkDone: () => { if (++chunks === 4) throw new Error("crash"); },
      }),
    ).rejects.toThrow("crash");
    expect(state.done).toEqual([{ from: 1, to: 400 }]);

    const chain2 = new FakeChain({ latest: 1000, logs: all });
    await scanLogs({
      rpc: chain2, address: POOL, topic0: LIQUIDATION_CALL_TOPIC, from: 1, to: 1000, state,
      chunk: { start: 100, min: 1, max: 100 }, onLogs: (l) => void stored.push(...l),
    });
    expect(Math.min(...chain2.getLogsCalls.map((c) => c.from))).toBe(401);
    expect(ids(stored)).toEqual(ids(all));
  });

  it("fails clearly if even a single block is refused", async () => {
    const chain = new FakeChain({ latest: 10, logs: mkLogs([5]), maxResults: 0 }); // any block with a log is refused
    await expect(run(chain, 1, 10, { done: [] }, 4)).rejects.toThrow(/fails even for 1 block/);
  });
});

describe("probe", () => {
  it("reports which range sizes the provider accepts", async () => {
    const chain = new FakeChain({ latest: 500_000, logs: [], maxRange: 1000 });
    const r = await probeLogLimit(chain, POOL, LIQUIDATION_CALL_TOPIC, 500_000);
    expect(r.filter((x) => x.ok).map((x) => x.size)).toEqual([1000, 500, 100, 10, 1]);
    expect(r.find((x) => !x.ok)?.error).toMatch(/block range/);
  });
});

describe("ThrottledRpc", () => {
  it("spaces requests, retries rate limits with backoff, and never leaks the key", async () => {
    let n = 0;
    const waits: number[] = [];
    let t = 0;
    const rpc = new ThrottledRpc(
      { send: async () => { if (++n <= 2) throw new Error("429 Too Many Requests https://x.g.alchemy.com/v2/KEY999"); return "ok"; } },
      { minIntervalMs: 100, sleep: async (ms) => { waits.push(ms); t += ms; }, now: () => t },
    );
    expect(await rpc.request("eth_blockNumber", [])).toBe("ok");
    expect(rpc.retries).toBe(2);
    expect(waits.some((w) => w >= 500)).toBe(true); // backoff happened

    const bad = new ThrottledRpc({ send: async () => { throw new Error("boom https://x/v2/KEY999"); } }, { minIntervalMs: 0, sleep: async () => {} });
    await expect(bad.request("x", [])).rejects.toThrow(/boom/);
    await bad.request("x", []).catch((e) => expect(String(e.message)).not.toMatch(/KEY999/));
  });
});

describe("error text", () => {
  it("prefers the provider's own message over ethers' wrapper", async () => {
    const { errorText } = await import("../src/liquidations/rpc.js");
    const wrapped = Object.assign(new Error('could not coalesce error (error={ "code": -32000, "message": "limit hit" }, payload={...})'), { error: { message: "limit hit" } });
    expect(errorText(wrapped)).toBe("limit hit");
    expect(errorText(new Error("plain"))).toBe("plain");
  });
});

describe("provider messages hidden inside ethers HTTP errors", () => {
  it("extracts the JSON-RPC message from info.responseBody", async () => {
    const { errorText } = await import("../src/liquidations/rpc.js");
    const e = Object.assign(new Error("server response 400 Bad Request (request={  }, response={  }, error=null, info={...})"), {
      info: { responseBody: JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "up to a 10 block range. Upgrade to PAYG." } }) },
    });
    expect(errorText(e)).toBe("up to a 10 block range. Upgrade to PAYG.");
    expect(classifyLogsError(errorText(e))).toEqual({ kind: "range", suggestedSize: 10 });
  });
});

describe("time-budgeted scan and coverage", () => {
  it("stops cleanly when asked, saves what was done, and a second run finishes without redoing it", async () => {
    const { coveredBlocks } = await import("../src/liquidations/logs.js");
    const all = mkLogs([5, 150, 420, 800, 999]);
    const state: ScanState = { done: [] };
    const got: any[] = [];
    let n = 0;
    const chain1 = new FakeChain({ latest: 1000, logs: all });
    const s1 = await scanLogs({
      rpc: chain1, address: POOL, topic0: LIQUIDATION_CALL_TOPIC, from: 1, to: 1000, state,
      chunk: { start: 100, min: 1, max: 100 }, onLogs: (l) => void got.push(...l),
      shouldStop: () => n++ >= 3, // allow exactly 3 requests
    });
    expect(s1.stopped).toBe(true);
    expect(state.done).toEqual([{ from: 1, to: 300 }]);
    expect(coveredBlocks(state.done, 1, 1000)).toBe(300);
    expect(coveredBlocks(state.done, 200, 500)).toBe(101);
    expect(coveredBlocks(state.done, 400, 1000)).toBe(0);

    const chain2 = new FakeChain({ latest: 1000, logs: all });
    const s2 = await scanLogs({
      rpc: chain2, address: POOL, topic0: LIQUIDATION_CALL_TOPIC, from: 1, to: 1000, state,
      chunk: { start: 100, min: 1, max: 100 }, onLogs: (l) => void got.push(...l),
    });
    expect(s2.stopped).toBeUndefined();
    expect(Math.min(...chain2.getLogsCalls.map((c) => c.from))).toBe(301);
    expect(state.done).toEqual([{ from: 1, to: 1000 }]);
    expect(ids(got)).toEqual(ids(all));
  });
});

describe("a logs RPC that lags behind the state RPC", () => {
  it("fails with a clear hint instead of a confusing 'range' message when the end block is beyond its head", async () => {
    const chain = new FakeChain({ latest: 1000, logs: [], strictHead: true });
    await expect(run(chain, 900, 1010, { done: [] }, 50)).rejects.toThrow(/BEHIND the other RPC: pass --to-block/);
  });

  it("scanning up to its own head works", async () => {
    const chain = new FakeChain({ latest: 1000, logs: mkLogs([990, 1000]), strictHead: true });
    const { seen } = await run(chain, 900, 1000, { done: [] }, 50);
    expect(ids(seen)).toEqual(ids(mkLogs([990, 1000])));
  });
});
