import { Interface, ZeroAddress } from "ethers";
import type { BotConfig } from "../config/load.js";
import type { Token, Venue } from "../core/types.js";
import { orientPrice, v2PriceToken1PerToken0, v3PriceToken1PerToken0 } from "./math.js";

/** Canonical Multicall3 (same address on every EVM chain). Checked by scripts/verify-addresses.sh. */
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

/** Transport: performs one eth_call. Injected so the reader can be tested without a network. */
export type CallFn = (tx: { to: string; data: string }) => Promise<string>;

export const mcIface = new Interface([
  "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)",
  "function getBlockNumber() view returns (uint256)",
]);
/** Arbitrum's ArbSys precompile. On Arbitrum, `block.number` returns the L1 (Ethereum) block number, so the real L2
 *  block number has to come from ArbSys.arbBlockNumber(). On other chains this call fails and we fall back. */
export const ARBSYS = "0x0000000000000000000000000000000000000064";
export const arbSysIface = new Interface(["function arbBlockNumber() view returns (uint256)"]);
export const routerIface = new Interface(["function factory() view returns (address)"]);
export const v3FactoryIface = new Interface(["function getPool(address,address,uint24) view returns (address)"]);
export const v2FactoryIface = new Interface(["function getPair(address,address) view returns (address)"]);
export const poolIface = new Interface([
  "function token0() view returns (address)",
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)",
  "function getReserves() view returns (uint112 reserve0,uint112 reserve1,uint32 blockTimestampLast)",
]);

export interface PoolInfo {
  id: string; // `${venue.id}:${A}/${B}`
  pairKey: string; // sorted symbols, groups pools of the same pair
  venue: Venue;
  a: Token;
  b: Token;
  address: string;
  aIsToken0: boolean;
}

export interface Snapshot {
  block: number;
  /** price of A in B ("B per A") for each pool id; pools that failed this poll are absent */
  prices: Map<string, number>;
}

interface Call {
  target: string;
  callData: string;
}

export class GapReader {
  pools: PoolInfo[] = [];

  constructor(private readonly config: BotConfig, private readonly call: CallFn) {}

  private async multicall(calls: Call[]): Promise<{ success: boolean; returnData: string }[]> {
    const data = mcIface.encodeFunctionData("aggregate3", [calls.map((c) => ({ ...c, allowFailure: true }))]);
    const raw = await this.call({ to: MULTICALL3, data });
    const [results] = mcIface.decodeFunctionResult("aggregate3", raw);
    return (results as any[]).map((r) => ({ success: r[0] as boolean, returnData: r[1] as string }));
  }

  /** Discover pool addresses from the routers' own factories (no hard-coded pool addresses). */
  async init(): Promise<PoolInfo[]> {
    const routers = [...new Set(this.config.venues.map((v) => v.router))];
    const fac = await this.multicall(routers.map((r) => ({ target: r, callData: routerIface.encodeFunctionData("factory") })));
    const factoryOf = new Map<string, string>();
    routers.forEach((r, i) => {
      if (fac[i]?.success) factoryOf.set(r, routerIface.decodeFunctionResult("factory", fac[i]!.returnData)[0] as string);
    });

    const candidates: Omit<PoolInfo, "address" | "aIsToken0">[] = [];
    const lookups: Call[] = [];
    for (const venue of this.config.venues) {
      const factory = factoryOf.get(venue.router);
      if (!factory) continue;
      for (const pair of venue.pairs) {
        const [sa, sb] = pair.split("/") as [string, string];
        const a = this.config.tokens[sa]!;
        const b = this.config.tokens[sb]!;
        candidates.push({ id: `${venue.id}:${pair}`, pairKey: [sa, sb].sort().join("/"), venue, a, b });
        lookups.push(
          venue.kind === "uniV3"
            ? { target: factory, callData: v3FactoryIface.encodeFunctionData("getPool", [a.address, b.address, venue.fee]) }
            : { target: factory, callData: v2FactoryIface.encodeFunctionData("getPair", [a.address, b.address]) },
        );
      }
    }
    const found = await this.multicall(lookups);
    const withAddr = candidates
      .map((c, i) => {
        const r = found[i];
        if (!r?.success) return null;
        const iface = c.venue.kind === "uniV3" ? v3FactoryIface : v2FactoryIface;
        const fn = c.venue.kind === "uniV3" ? "getPool" : "getPair";
        const address = iface.decodeFunctionResult(fn, r.returnData)[0] as string;
        return address && address !== ZeroAddress ? { ...c, address } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    const t0 = await this.multicall(withAddr.map((p) => ({ target: p.address, callData: poolIface.encodeFunctionData("token0") })));
    this.pools = withAddr
      .map((p, i) => {
        const r = t0[i];
        if (!r?.success) return null;
        const token0 = (poolIface.decodeFunctionResult("token0", r.returnData)[0] as string).toLowerCase();
        return { ...p, aIsToken0: token0 === p.a.address.toLowerCase() };
      })
      .filter((x): x is PoolInfo => x !== null);
    return this.pools;
  }

  /** ONE eth_call: block number + the state of every pool. */
  async read(): Promise<Snapshot> {
    const calls: Call[] = [
      { target: ARBSYS, callData: arbSysIface.encodeFunctionData("arbBlockNumber") },
      { target: MULTICALL3, callData: mcIface.encodeFunctionData("getBlockNumber") },
    ];
    for (const p of this.pools) {
      calls.push({
        target: p.address,
        callData: poolIface.encodeFunctionData(p.venue.kind === "uniV3" ? "slot0" : "getReserves"),
      });
    }
    const res = await this.multicall(calls);
    const arb = res[0]!;
    const block =
      arb.success && arb.returnData !== "0x"
        ? Number(arbSysIface.decodeFunctionResult("arbBlockNumber", arb.returnData)[0])
        : Number(mcIface.decodeFunctionResult("getBlockNumber", res[1]!.returnData)[0]);
    const POOL_OFFSET = 2;
    const prices = new Map<string, number>();
    this.pools.forEach((p, i) => {
      const r = res[i + POOL_OFFSET];
      if (!r?.success) return;
      const [dec0, dec1] = p.aIsToken0 ? [p.a.decimals, p.b.decimals] : [p.b.decimals, p.a.decimals];
      let t1PerT0: number;
      if (p.venue.kind === "uniV3") {
        const [sqrt] = poolIface.decodeFunctionResult("slot0", r.returnData);
        t1PerT0 = v3PriceToken1PerToken0(sqrt as bigint, dec0, dec1);
      } else {
        const [r0, r1] = poolIface.decodeFunctionResult("getReserves", r.returnData);
        t1PerT0 = v2PriceToken1PerToken0(r0 as bigint, r1 as bigint, dec0, dec1);
      }
      const price = orientPrice(t1PerT0, p.aIsToken0);
      if (price > 0) prices.set(p.id, price);
    });
    return { block, prices };
  }
}
