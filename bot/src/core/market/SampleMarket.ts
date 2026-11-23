import { hashString, mulberry32 } from "../rng.js";
import { fromHuman, toHuman } from "../units.js";
import type { MarketData, NewPool, Step, Token, Venue } from "../types.js";

export interface SampleMarketOptions {
  seed: number;
  tokenUsd: Record<string, number>; // reference USD price per symbol
  venues: Venue[];
  tokens: Record<string, Token>;
  /** max +/- price deviation of a venue vs. fair price, in percent. Invented number; tune it. */
  skewPct?: number;
  gasGwei?: number;
}

/**
 * SYNTHETIC market. Prices are random and reproducible from a seed.
 * Results from this market say NOTHING about real-world profitability; they only exercise the code.
 */
export class SampleMarket implements MarketData {
  readonly source = "synthetic" as const;
  private cycle = 0;
  private skewCache = new Map<string, number>();
  private newPools: NewPool[] = [];
  private newTokenUsd = new Map<string, number>();

  constructor(private readonly o: SampleMarketOptions) {}

  async advance(): Promise<void> {
    this.cycle++;
    this.skewCache.clear();
    this.newPools = this.makeNewPools();
  }

  private rnd(key: string): number {
    return mulberry32(hashString(`${this.o.seed}|${this.cycle}|${key}`))();
  }

  private pairKey(a: Token, b: Token): string {
    return [a.symbol, b.symbol].sort().join("/");
  }

  /** Venue price level of the "first" token of the canonical pair, as a deviation from fair (e.g. +0.002). */
  private skew(venue: Venue, a: Token, b: Token): number {
    const key = `${venue.id}|${this.pairKey(a, b)}`;
    let s = this.skewCache.get(key);
    if (s === undefined) {
      const isNew = this.newTokenUsd.has(a.symbol) || this.newTokenUsd.has(b.symbol);
      const max = (isNew ? 5 : (this.o.skewPct ?? 0.35)) / 100;
      s = (this.rnd(key) * 2 - 1) * max;
      this.skewCache.set(key, s);
    }
    return s;
  }

  async usdPrice(token: Token): Promise<number> {
    return this.newTokenUsd.get(token.symbol) ?? this.o.tokenUsd[token.symbol] ?? 0;
  }

  async gasPriceGwei(): Promise<number> {
    const base = this.o.gasGwei ?? 0.02;
    return base * (0.8 + this.rnd("gas") * 0.6);
  }

  async quote(step: Step, amountIn: bigint): Promise<bigint> {
    const { venue, tokenIn, tokenOut } = step;
    const pIn = await this.usdPrice(tokenIn);
    const pOut = await this.usdPrice(tokenOut);
    if (pIn <= 0 || pOut <= 0 || amountIn <= 0n) return 0n;

    // honeypot simulation: selling an unsellable new token always fails on that venue
    const pool = this.newPools.find((p) => p.newToken.symbol === tokenIn.symbol);
    if (pool && !pool.sellable) return 0n;

    const [first] = [tokenIn.symbol, tokenOut.symbol].sort();
    const s = this.skew(venue, tokenIn, tokenOut);
    const levelFactor = tokenIn.symbol === first ? 1 + s : 1 / (1 + s);

    const inHuman = toHuman(amountIn, tokenIn);
    const usdIn = inHuman * pIn;
    const liq = (pool ? pool.liquidityUsd : venue.liquidityUsd) / 2;
    const impact = liq / (liq + usdIn);
    const feeFactor = 1 - venue.fee / 1_000_000;
    const outHuman = ((inHuman * pIn) / pOut) * levelFactor * feeFactor * impact;
    return fromHuman(outHuman, tokenOut);
  }

  async getNewPools(): Promise<NewPool[]> {
    return this.newPools;
  }

  private makeNewPools(): NewPool[] {
    const base = this.o.tokens["WETH"];
    const dexVenues = this.o.venues.filter((v) => v.kind === "uniV3");
    const second = this.o.venues.find((v) => v.kind === "uniV2");
    if (!base || dexVenues.length < 1 || !second) return [];
    const pools: NewPool[] = [];
    const n = 1 + Math.floor(this.rnd("newpools") * 3);
    for (let i = 0; i < n; i++) {
      const id = `${this.cycle}-${i}`;
      const symbol = `NEW${this.cycle}x${i}`;
      const token: Token = {
        symbol,
        address: "0x" + hashString(id).toString(16).padStart(40, "0"),
        decimals: 18,
      };
      this.newTokenUsd.set(symbol, 0.01 + this.rnd(`p${id}`) * 5);
      const venues = [dexVenues[Math.floor(this.rnd(`v${id}`) * dexVenues.length)]!, second];
      pools.push({
        base,
        newToken: token,
        venues,
        ageMinutes: Math.floor(this.rnd(`a${id}`) * 120),
        liquidityUsd: 2_000 + this.rnd(`l${id}`) * 150_000,
        sellable: this.rnd(`s${id}`) > 0.3, // ~30% honeypots in the synthetic world
        taxBps: this.rnd(`t${id}`) > 0.8 ? 500 : 0,
      });
    }
    return pools;
  }
}
