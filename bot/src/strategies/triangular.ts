import type { Route, Step } from "../core/types.js";
import { venuesForPair, type ScanContext, type Strategy } from "./Strategy.js";

/** (b) Triangular: A -> B -> C -> A, trying every venue combination per hop. */
export const triangular: Strategy = {
  name: "triangular",
  async routes(ctx: ScanContext): Promise<Route[]> {
    const out: Route[] = [];
    for (const cyc of ctx.params.cycles as string[][]) {
      const toks = cyc.map((s) => ctx.tokens[s]);
      if (toks.some((t) => !t) || toks.length < 3) continue;
      const hops = toks.map((t, i) => ({ a: t!, b: toks[(i + 1) % toks.length]! }));
      const options = hops.map((h) => venuesForPair(ctx.venues, h.a, h.b));
      if (options.some((o) => o.length === 0)) continue;
      const build = (i: number, acc: Step[]): void => {
        if (i === hops.length) {
          out.push([...acc]);
          return;
        }
        for (const v of options[i]!) build(i + 1, [...acc, { venue: v, tokenIn: hops[i]!.a, tokenOut: hops[i]!.b }]);
      };
      build(0, []);
    }
    return out;
  },
};
