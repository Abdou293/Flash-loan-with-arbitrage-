import { AbiCoder } from "ethers";
import { MULTICALL3, mcIface } from "../src/monitor/reader.js";
import { oracleIface, poolIface, providerIface, tokenIface, LIQUIDATION_CALL_TOPIC, type RawLog } from "../src/liquidations/aave.js";
import { hex, num, type Rpc } from "../src/liquidations/rpc.js";

export const POOL = "0x794a61358d6845594f94dc1db02a252b5b4814ad";
export const PROVIDER = "0xa97684ead0e402dc232d5a977953df7ecbab3cdb";
export const ORACLE = "0x00000000000000000000000000000000000000aa";
export const WETH = "0x82af49447d8a07e3bd95bd0d56f35241523fbab1";
export const USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
export const BOT1 = "0x00000000000000000000000000000000000b0b01";
export const BOT2 = "0x00000000000000000000000000000000000b0b02";

export interface FakeChainOptions {
  latest: number;
  logs: RawLog[];
  /** reject getLogs ranges wider than this, with an Alchemy-style message */
  maxRange?: number;
  /** reject getLogs whose end is beyond this node's head, like a public RPC that lags behind */
  strictHead?: boolean;
  /** reject getLogs that would return more than this many logs */
  maxResults?: number;
  prices?: (asset: string, block: number) => bigint;
  hf?: (user: string, block: number) => { debtBase: bigint; healthFactor: bigint };
  /** block -> unix time */
  time?: (block: number) => number;
  /** blocks before this one have no oracle price / no state (like a pruned or too-young chain) */
  oracleFrom?: number;
}

export const ONE = 10n ** 18n;

/** In-memory Arbitrum + Aave: answers exactly the calls the liquidation tools make. */
export class FakeChain implements Rpc {
  counts: Record<string, number> = {};
  getLogsCalls: { from: number; to: number }[] = [];

  constructor(public o: FakeChainOptions) {}

  async request(method: string, params: unknown[]): Promise<any> {
    this.counts[method] = (this.counts[method] ?? 0) + 1;
    const p = params as any[];
    switch (method) {
      case "eth_chainId":
        return "0xa4b1";
      case "eth_blockNumber":
        return hex(this.o.latest);
      case "eth_getBlockByNumber": {
        const b = num(p[0]);
        return { number: hex(b), timestamp: hex((this.o.time ?? ((x) => 1_700_000_000 + x))(b)) };
      }
      case "eth_getLogs": {
        const f = p[0];
        const from = num(f.fromBlock), to = num(f.toBlock);
        this.getLogsCalls.push({ from, to });
        if (this.o.strictHead && to > this.o.latest) throw new Error("block range extends beyond current head block");
        if (this.o.maxRange && to - from + 1 > this.o.maxRange) {
          throw new Error(`Under the Free tier plan, you can make eth_getLogs requests with up to a ${this.o.maxRange} block range. Upgrade to PAYG.`);
        }
        const hits = this.o.logs.filter((l) => {
          const b = num(l.blockNumber);
          return b >= from && b <= to && l.topics[0] === (f.topics?.[0] ?? l.topics[0]);
        });
        if (this.o.maxResults !== undefined && hits.length > this.o.maxResults) {
          throw new Error(`query returned more than ${this.o.maxResults} results`);
        }
        return hits;
      }
      case "eth_call": {
        const tx = p[0];
        const block = p[1] === "latest" ? this.o.latest : num(p[1]);
        return this.handle(tx.to.toLowerCase(), tx.data, block);
      }
      default:
        throw new Error("fake chain: unsupported " + method);
    }
  }

  private handle(to: string, data: string, block: number): string {
    if (to === MULTICALL3.toLowerCase()) {
      const [inner] = mcIface.decodeFunctionData("aggregate3", data);
      const results = (inner as any[]).map((c) => {
        try {
          return { success: true, returnData: this.handle((c[0] as string).toLowerCase(), c[2] as string, block) };
        } catch {
          return { success: false, returnData: "0x" };
        }
      });
      return mcIface.encodeFunctionResult("aggregate3", [results]);
    }
    const sel = data.slice(0, 10);
    const sig = (i: { getFunction(n: string): { selector: string } | null }, n: string) => i.getFunction(n)!.selector;
    if (to === POOL) {
      if (sel === sig(poolIface, "ADDRESSES_PROVIDER")) return poolIface.encodeFunctionResult("ADDRESSES_PROVIDER", [PROVIDER]);
      if (sel === sig(poolIface, "getUserAccountData")) {
        if (this.o.oracleFrom !== undefined && block < this.o.oracleFrom) throw new Error("missing trie node");
        const [user] = poolIface.decodeFunctionData("getUserAccountData", data);
        const a = (this.o.hf ?? (() => ({ debtBase: 0n, healthFactor: 2n ** 256n - 1n })))((user as string).toLowerCase(), block);
        return poolIface.encodeFunctionResult("getUserAccountData", [0n, a.debtBase, 0n, 0n, 0n, a.healthFactor]);
      }
    }
    if (to === PROVIDER) {
      if (sel === sig(providerIface, "getPool")) return providerIface.encodeFunctionResult("getPool", [POOL]);
      if (sel === sig(providerIface, "getPriceOracle")) return providerIface.encodeFunctionResult("getPriceOracle", [ORACLE]);
    }
    if (to === ORACLE) {
      if (sel === sig(oracleIface, "BASE_CURRENCY_UNIT")) return oracleIface.encodeFunctionResult("BASE_CURRENCY_UNIT", [10n ** 8n]);
      if (sel === sig(oracleIface, "getAssetPrice")) {
        if (this.o.oracleFrom !== undefined && block < this.o.oracleFrom) throw new Error("no code");
        const [asset] = oracleIface.decodeFunctionData("getAssetPrice", data);
        const price = (this.o.prices ?? defaultPrices)((asset as string).toLowerCase(), block);
        return oracleIface.encodeFunctionResult("getAssetPrice", [price]);
      }
    }
    if (sel === sig(tokenIface, "symbol")) {
      return tokenIface.encodeFunctionResult("symbol", [to === WETH ? "WETH" : to === USDC ? "USDC" : "TKN"]);
    }
    if (sel === sig(tokenIface, "decimals")) return tokenIface.encodeFunctionResult("decimals", [to === USDC ? 6 : 18]);
    throw new Error("fake chain: unhandled call " + sel + " to " + to);
  }
}

export const defaultPrices = (asset: string): bigint => (asset === WETH ? 3_000n * 10n ** 8n : 1n * 10n ** 8n);

const coder = AbiCoder.defaultAbiCoder();
const topicAddr = (a: string) => "0x" + a.toLowerCase().replace("0x", "").padStart(64, "0");

/** Build a LiquidationCall log. debt in debt-asset units, collateral in collateral-asset units. */
export function liqLog(o: {
  block: number; idx?: number; tx?: string; user: string; liquidator: string;
  collateral?: string; debt?: string; debtToCover: bigint; collateralAmount: bigint;
}): RawLog {
  return {
    address: POOL,
    topics: [LIQUIDATION_CALL_TOPIC, topicAddr(o.collateral ?? WETH), topicAddr(o.debt ?? USDC), topicAddr(o.user)],
    data: coder.encode(["uint256", "uint256", "address", "bool"], [o.debtToCover, o.collateralAmount, o.liquidator, false]),
    blockNumber: hex(o.block),
    transactionHash: o.tx ?? "0x" + o.block.toString(16).padStart(64, "0"),
    transactionIndex: "0x1",
    logIndex: hex(o.idx ?? 0),
  };
}
