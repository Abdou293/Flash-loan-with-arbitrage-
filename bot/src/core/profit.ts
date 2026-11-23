import type { Candidate, GlobalConfig, MarketData, ProfitBreakdown, Route, Token } from "./types.js";
import { fromHuman, toHuman } from "./units.js";

/** Quote a whole route step by step. Returns 0n if any step cannot be quoted. */
export async function quoteRoute(route: Route, amountIn: bigint, market: MarketData): Promise<bigint> {
  let amount = amountIn;
  for (const step of route) {
    amount = await market.quote(step, amount);
    if (amount === 0n) return 0n;
  }
  return amount;
}

/**
 * Net profit = out - in - flash-loan fee - slippage reserve - gas.
 * DEX swap fees and price impact are already inside the quotes.
 * Gas is an ESTIMATE (units come from config; Arbitrum also pays an L1 data fee, folded into baseGasUnits).
 */
export async function computeProfit(args: {
  borrowToken: Token;
  amountIn: bigint;
  amountOut: bigint;
  steps: number;
  gasPriceGwei: number;
  market: MarketData;
  cfg: GlobalConfig;
  weth: Token;
}): Promise<ProfitBreakdown> {
  const { borrowToken: t, amountIn, amountOut, steps, gasPriceGwei, market, cfg, weth } = args;
  const gross = amountOut - amountIn;
  const flashLoanFee = (amountIn * BigInt(Math.round(cfg.flashLoanFeeBps * 100))) / 1_000_000n;
  const slippageReserve = (amountOut * BigInt(Math.round(cfg.slippageBps * 100))) / 1_000_000n;

  const gasUnits = cfg.baseGasUnits + cfg.perStepGasUnits * steps;
  const gasEth = gasUnits * gasPriceGwei * 1e-9;
  const [ethUsd, tokenUsd] = await Promise.all([market.usdPrice(weth), market.usdPrice(t)]);
  const gasUsd = gasEth * ethUsd;
  const gasCost = tokenUsd > 0 ? fromHuman(gasUsd / tokenUsd, t) : 0n;

  const net = gross - flashLoanFee - slippageReserve - gasCost;
  const usd = (x: bigint) => toHuman(x < 0n ? -x : x, t) * tokenUsd * (x < 0n ? -1 : 1);
  return {
    gross,
    flashLoanFee,
    slippageReserve,
    gasCost,
    net,
    netUsd: usd(net),
    grossUsd: usd(gross),
    flashLoanFeeUsd: usd(flashLoanFee),
    slippageReserveUsd: usd(slippageReserve),
    gasCostUsd: gasUsd,
    gasUnits,
  };
}

/** Try each configured trade size (capped) and return the best candidate for this route, or null if unquotable. */
export async function bestSizeCandidate(args: {
  strategy: string;
  route: Route;
  market: MarketData;
  cfg: GlobalConfig;
  maxTradeSizeUsd: number;
  weth: Token;
}): Promise<Candidate | null> {
  const { strategy, route, market, cfg, maxTradeSizeUsd, weth } = args;
  const borrowToken = route[0]!.tokenIn;
  const borrowUsd = await market.usdPrice(borrowToken);
  if (borrowUsd <= 0) return null;
  const gasPriceGwei = await market.gasPriceGwei();

  let best: Candidate | null = null;
  for (const sizeUsd of cfg.tradeSizesUsd) {
    if (sizeUsd > maxTradeSizeUsd) continue;
    const amountIn = fromHuman(sizeUsd / borrowUsd, borrowToken);
    if (amountIn === 0n) continue;
    const amountOut = await quoteRoute(route, amountIn, market);
    if (amountOut === 0n) continue;
    const profit = await computeProfit({
      borrowToken,
      amountIn,
      amountOut,
      steps: route.length,
      gasPriceGwei,
      market,
      cfg,
      weth,
    });
    if (!best || profit.netUsd > best.profit.netUsd) {
      best = { strategy, route, borrowToken, amountIn, amountInUsd: sizeUsd, amountOut, profit };
    }
  }
  return best;
}
