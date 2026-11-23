import { Contract, JsonRpcProvider } from "ethers";
import type { MarketData, NewPool, Step, Token } from "../types.js";

// UNVERIFIED: check against official Uniswap docs before use.
const QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";

const QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160,uint32,uint256)",
];
const V2_ABI = ["function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)"];

export interface RpcMarketOptions {
  rpcUrl: string;
  stableSymbols?: string[];
  /** Minimum delay between RPC calls, to respect free-tier rate limits. */
  minCallIntervalMs?: number;
  usdcSymbol?: string;
}

/**
 * Live market data over a (free) RPC. READ-ONLY: only eth_call / gas price, never sends transactions.
 * Free-tier friendly: per-cycle cache + a minimum interval between calls.
 * NOTE: not exercised by automated tests (no network in CI); try it yourself with a free RPC URL.
 * New-pool discovery is not implemented here yet (returns []).
 */
export class RpcMarket implements MarketData {
  readonly source = "rpc" as const;
  private provider: JsonRpcProvider;
  private cache = new Map<string, bigint>();
  private priceCache = new Map<string, number>();
  private lastCall = 0;
  private gasCache: number | null = null;

  constructor(
    private readonly o: RpcMarketOptions,
    private readonly tokens: Record<string, Token>,
    private readonly usdVenueLookup: (a: Token, b: Token) => Step | undefined,
  ) {
    this.provider = new JsonRpcProvider(o.rpcUrl, undefined, { staticNetwork: true });
  }

  async advance(): Promise<void> {
    this.cache.clear();
    this.priceCache.clear();
    this.gasCache = null;
  }

  private async throttle(): Promise<void> {
    const wait = (this.o.minCallIntervalMs ?? 250) - (Date.now() - this.lastCall);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastCall = Date.now();
  }

  async quote(step: Step, amountIn: bigint): Promise<bigint> {
    const key = `${step.venue.id}|${step.tokenIn.symbol}|${step.tokenOut.symbol}|${amountIn}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    await this.throttle();
    let out = 0n;
    try {
      if (step.venue.kind === "uniV3") {
        const quoter = new Contract(QUOTER_V2, QUOTER_ABI, this.provider);
        const res = await quoter.getFunction("quoteExactInputSingle").staticCall({
          tokenIn: step.tokenIn.address,
          tokenOut: step.tokenOut.address,
          amountIn,
          fee: step.venue.fee,
          sqrtPriceLimitX96: 0,
        });
        out = res[0] as bigint;
      } else {
        const router = new Contract(step.venue.router, V2_ABI, this.provider);
        const amounts = (await router.getFunction("getAmountsOut")(amountIn, [
          step.tokenIn.address,
          step.tokenOut.address,
        ])) as bigint[];
        out = amounts[amounts.length - 1] ?? 0n;
      }
    } catch {
      out = 0n; // pool missing / no liquidity / RPC error -> treated as "no quote"
    }
    this.cache.set(key, out);
    return out;
  }

  async usdPrice(token: Token): Promise<number> {
    if ((this.o.stableSymbols ?? ["USDC", "USDT", "DAI"]).includes(token.symbol)) return 1;
    const cached = this.priceCache.get(token.symbol);
    if (cached !== undefined) return cached;
    const usdc = this.tokens[this.o.usdcSymbol ?? "USDC"];
    const step = usdc ? this.usdVenueLookup(token, usdc) : undefined;
    let price = 0;
    if (step) {
      const one = 10n ** BigInt(token.decimals);
      const out = await this.quote(step, one);
      price = Number(out) / 10 ** (usdc?.decimals ?? 6);
    }
    this.priceCache.set(token.symbol, price);
    return price;
  }

  async gasPriceGwei(): Promise<number> {
    if (this.gasCache !== null) return this.gasCache;
    await this.throttle();
    const fee = await this.provider.getFeeData();
    this.gasCache = Number(fee.gasPrice ?? 0n) / 1e9;
    return this.gasCache;
  }

  async getNewPools(): Promise<NewPool[]> {
    return [];
  }
}
