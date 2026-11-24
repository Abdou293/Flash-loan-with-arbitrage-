/**
 * Price math for the gap monitor. All prices are "units of token B per 1 token A" for a pair written "A/B" in the config.
 */

/** Uniswap V3 slot0 sqrtPriceX96 -> price of token1 in token0, in human units. */
export function v3PriceToken1PerToken0(sqrtPriceX96: bigint, dec0: number, dec1: number): number {
  const sqrt = Number(sqrtPriceX96) / 2 ** 96;
  return sqrt * sqrt * 10 ** (dec0 - dec1);
}

/** Uniswap V2 reserves -> price of token1 in token0, in human units. */
export function v2PriceToken1PerToken0(reserve0: bigint, reserve1: bigint, dec0: number, dec1: number): number {
  if (reserve0 === 0n) return 0;
  return (Number(reserve1) / Number(reserve0)) * 10 ** (dec0 - dec1);
}

/** Convert a token1-per-token0 price into "B per A" for the configured pair orientation. */
export function orientPrice(token1PerToken0: number, aIsToken0: boolean): number {
  if (token1PerToken0 <= 0) return 0;
  return aIsToken0 ? token1PerToken0 : 1 / token1PerToken0;
}

export interface GapResult {
  /** price ratio high/low - 1, in basis points */
  gapBps: number;
  /** the no-arbitrage band created by the two pool fees, in basis points */
  bandBps: number;
  /** how far the gap is OUTSIDE the band (positive = a round trip beats both pool fees at the margin), in bps */
  excessBps: number;
  /** index (0 or 1) of the pool where A is more expensive: sell A there, buy it back in the other pool */
  sellAIn: 0 | 1;
}

/**
 * Two pools quote the same pair at prices p0 and p1 (B per A), with fees f0 and f1 (fractions, e.g. 0.0005).
 * Selling 1 A where it is expensive and buying it back where it is cheap returns, at the margin,
 *   (pHigh * (1 - fHigh)) * (1 - fLow) / pLow  units of A.
 * The trade beats the fees only if pHigh / pLow > 1 / ((1 - f0)(1 - f1)). `excessBps` measures by how much.
 * This ignores price impact, gas and the loan fee, so excess > 0 is necessary but NOT sufficient for profit.
 */
export function gapVersusFees(p0: number, p1: number, f0: number, f1: number): GapResult {
  const sellAIn: 0 | 1 = p0 >= p1 ? 0 : 1;
  const high = Math.max(p0, p1);
  const low = Math.min(p0, p1);
  const ratio = low > 0 ? high / low : 0;
  const threshold = 1 / ((1 - f0) * (1 - f1));
  return {
    gapBps: (ratio - 1) * 1e4,
    bandBps: (threshold - 1) * 1e4,
    excessBps: ratio > 0 ? (ratio / threshold - 1) * 1e4 : -1e4,
    sellAIn,
  };
}

const STABLES = new Set(["USDC", "USDT", "USDCe", "DAI"]);

/**
 * Rough USD price per token symbol from pool prices ("B per A" for pair A/B): stablecoins = 1, everything else
 * priced through a stablecoin or WETH pool. Used only to size pools (TVL), not for profit maths.
 */
export function usdPricesFrom(quotes: { a: string; b: string; price: number }[]): Map<string, number> {
  const usd = new Map<string, number>();
  for (const s of STABLES) usd.set(s, 1);
  for (let pass = 0; pass < 3; pass++) {
    for (const q of quotes) {
      if (!(q.price > 0)) continue;
      const pb = usd.get(q.b), pa = usd.get(q.a);
      if (pb !== undefined && pa === undefined) usd.set(q.a, q.price * pb);
      else if (pa !== undefined && pb === undefined) usd.set(q.b, pa / q.price);
    }
  }
  return usd;
}

/** Pool value in USD from its raw token balances. Returns undefined if a price or balance is missing. */
export function poolTvlUsd(
  balA: bigint | undefined, decA: number, usdA: number | undefined,
  balB: bigint | undefined, decB: number, usdB: number | undefined,
): number | undefined {
  if (balA === undefined || balB === undefined || usdA === undefined || usdB === undefined) return undefined;
  return (Number(balA) / 10 ** decA) * usdA + (Number(balB) / 10 ** decB) * usdB;
}
