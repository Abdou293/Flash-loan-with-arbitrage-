import { loadConfig } from "../src/config/load.js";
import type { MarketData, NewPool, Step, Token } from "../src/core/types.js";
import { fromHuman, toHuman } from "../src/core/units.js";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

export const config = loadConfig(join(dirname(fileURLToPath(import.meta.url)), "..", "strategies.config.json"));

/** Hand-made market: explicit price multipliers per venue+direction, so tests control the spread exactly. */
export class FakeMarket implements MarketData {
  readonly source = "synthetic" as const;
  constructor(
    private mult: (venueId: string, a: string, b: string) => number = () => 1,
    private newPools: NewPool[] = [],
    private gwei = 0.02,
  ) {}
  async advance() {}
  async usdPrice(t: Token) {
    return config.tokenUsd[t.symbol] ?? 1;
  }
  async gasPriceGwei() {
    return this.gwei;
  }
  async getNewPools() {
    return this.newPools;
  }
  async quote(step: Step, amountIn: bigint) {
    const pIn = await this.usdPrice(step.tokenIn);
    const pOut = await this.usdPrice(step.tokenOut);
    const out =
      ((toHuman(amountIn, step.tokenIn) * pIn) / pOut) *
      (1 - step.venue.fee / 1e6) *
      this.mult(step.venue.id, step.tokenIn.symbol, step.tokenOut.symbol);
    return fromHuman(out, step.tokenOut);
  }
}
