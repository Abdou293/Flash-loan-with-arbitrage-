import type { Route } from "../core/types.js";
import { venuesForPair, type ScanContext, type Strategy } from "./Strategy.js";

/** (a) Cross-DEX spread: sell on one DEX, buy back on a different DEX. */
export const crossDex: Strategy = {
  name: "crossDex",
  async routes(ctx: ScanContext): Promise<Route[]> {
    const out: Route[] = [];
    for (const [sa, sb] of ctx.params.pairs as [string, string][]) {
      const a = ctx.tokens[sa];
      const b = ctx.tokens[sb];
      if (!a || !b) continue;
      const vs = venuesForPair(ctx.venues, a, b);
      for (const v1 of vs)
        for (const v2 of vs) {
          if (v1.dex === v2.dex) continue; // same DEX is the feeTier strategy
          out.push([
            { venue: v1, tokenIn: a, tokenOut: b },
            { venue: v2, tokenIn: b, tokenOut: a },
          ]);
        }
    }
    return out;
  },
};
