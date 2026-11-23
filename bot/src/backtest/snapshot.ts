import type { BotConfig } from "../config/load.js";
import type { Snapshot } from "../core/dataset.js";
import type { MarketData, Step } from "../core/types.js";
import { fromHuman, toHuman } from "../core/units.js";

export const DEFAULT_CURVE_SIZES_USD = [100, 1000, 5000, 25000, 100000];

/** Build one snapshot from any MarketData (synthetic or RPC): quote every venue/direction at several sizes. */
export async function buildSnapshot(
  market: MarketData,
  config: BotConfig,
  sizesUsd: number[],
  block: number,
  timestamp: number,
): Promise<Snapshot> {
  const usd: Record<string, number> = {};
  for (const t of Object.values(config.tokens)) usd[t.symbol] = await market.usdPrice(t);

  const curves: Snapshot["curves"] = {};
  for (const venue of config.venues) {
    for (const pair of venue.pairs) {
      const [a, b] = pair.split("/").map((s) => config.tokens[s!]!);
      for (const [tokenIn, tokenOut] of [[a!, b!], [b!, a!]] as const) {
        const step: Step = { venue, tokenIn, tokenOut };
        const priceIn = usd[tokenIn.symbol] ?? 0;
        if (priceIn <= 0) continue;
        const points: [number, number][] = [];
        for (const size of sizesUsd) {
          const amountIn = fromHuman(size / priceIn, tokenIn);
          const out = await market.quote(step, amountIn);
          if (out === 0n) continue;
          points.push([size, toHuman(out, tokenOut) / toHuman(amountIn, tokenIn)]);
        }
        if (points.length) curves[`${venue.id}|${tokenIn.symbol}|${tokenOut.symbol}`] = points;
      }
    }
  }
  return { type: "snapshot", block, timestamp, gasGwei: await market.gasPriceGwei(), usd, curves };
}
