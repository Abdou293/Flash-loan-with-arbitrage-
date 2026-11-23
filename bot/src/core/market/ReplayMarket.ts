import { interpolateRate, type Dataset, type Snapshot } from "../dataset.js";
import type { MarketData, NewPool, Step, Token } from "../types.js";
import { fromHuman, toHuman } from "../units.js";

/** Replays recorded snapshots as if they were live. Each advance() moves to the next snapshot. */
export class ReplayMarket implements MarketData {
  readonly source: "synthetic" | "rpc";
  private idx = -1;

  constructor(private readonly ds: Dataset) {
    this.source = ds.header.source === "synthetic" ? "synthetic" : "rpc";
  }

  get snapshotCount(): number {
    return this.ds.snapshots.length;
  }
  hasNext(): boolean {
    return this.idx + 1 < this.ds.snapshots.length;
  }
  get current(): Snapshot {
    const s = this.ds.snapshots[this.idx];
    if (!s) throw new Error("ReplayMarket: call advance() first");
    return s;
  }

  async advance(): Promise<void> {
    if (!this.hasNext()) throw new Error("ReplayMarket: dataset exhausted");
    this.idx++;
  }

  async usdPrice(token: Token): Promise<number> {
    return this.current.usd[token.symbol] ?? 0;
  }
  async gasPriceGwei(): Promise<number> {
    return this.current.gasGwei;
  }
  async getNewPools(): Promise<NewPool[]> {
    return []; // no historical pool-creation data in this dataset format
  }

  async quote(step: Step, amountIn: bigint): Promise<bigint> {
    const snap = this.current;
    const curve = snap.curves[`${step.venue.id}|${step.tokenIn.symbol}|${step.tokenOut.symbol}`];
    if (!curve) return 0n;
    const priceIn = snap.usd[step.tokenIn.symbol] ?? 0;
    const inHuman = toHuman(amountIn, step.tokenIn);
    const rate = interpolateRate(curve, inHuman * priceIn);
    if (rate === null || rate <= 0) return 0n;
    return fromHuman(inHuman * rate, step.tokenOut);
  }
}
