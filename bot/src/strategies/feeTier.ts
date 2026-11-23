import type { Route } from "../core/types.js";
import { venuesForPair, type ScanContext, type Strategy } from "./Strategy.js";

/** (c) Fee-tier arbitrage: same pair, different Uniswap V3 fee tiers. */
export const feeTier: Strategy = {
  name: "feeTier",
  async routes(ctx: ScanContext): Promise<Route[]> {
    const out: Route[] = [];
    for (const [sa, sb] of ctx.params.pairs as [string, string][]) {
      const a = ctx.tokens[sa];
      const b = ctx.tokens[sb];
      if (!a || !b) continue;
      const tiers = venuesForPair(ctx.venues, a, b).filter((v) => v.kind === "uniV3");
      for (const v1 of tiers)
        for (const v2 of tiers) {
          if (v1.fee === v2.fee) continue;
          out.push([
            { venue: v1, tokenIn: a, tokenOut: b },
            { venue: v2, tokenIn: b, tokenOut: a },
          ]);
        }
    }
    return out;
  },
};
