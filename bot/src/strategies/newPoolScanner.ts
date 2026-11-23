import type { Route } from "../core/types.js";
import type { ScanContext, Strategy } from "./Strategy.js";

/**
 * (d) Long-tail / new-pool scanner. HIGHEST RISK strategy: new tokens are often scams (honeypots,
 * transfer taxes, rug pulls). Safety filters are mandatory and configurable:
 * minimum liquidity, minimum age, sellable check, max tax.
 */
export const newPoolScanner: Strategy = {
  name: "newPoolScanner",
  async routes(ctx: ScanContext): Promise<Route[]> {
    const p = ctx.params;
    const pools = await ctx.market.getNewPools();
    const out: Route[] = [];
    for (const pool of pools) {
      if (!(p.baseTokens as string[]).includes(pool.base.symbol)) continue;
      if (pool.liquidityUsd < p.minLiquidityUsd) continue;
      if (pool.ageMinutes < p.minAgeMinutes) continue;
      if (p.requireSellable && !pool.sellable) continue;
      if (pool.taxBps > p.maxTaxBps) continue;
      for (const v1 of pool.venues)
        for (const v2 of pool.venues) {
          if (v1.id === v2.id) continue;
          out.push([
            { venue: v1, tokenIn: pool.base, tokenOut: pool.newToken },
            { venue: v2, tokenIn: pool.newToken, tokenOut: pool.base },
          ]);
        }
    }
    return out;
  },
};
