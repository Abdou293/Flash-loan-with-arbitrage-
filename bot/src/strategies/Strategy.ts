import type { MarketData, Route, Token, Venue } from "../core/types.js";

export interface ScanContext {
  market: MarketData;
  tokens: Record<string, Token>;
  venues: Venue[];
  /** Strategy-specific parameters from strategies.config.json */
  params: any;
}

/**
 * Plug-in contract. A strategy only PROPOSES candidate routes (each must start and end in the same
 * token = the borrowed token). Shared code then sizes, prices, risk-checks and simulates them.
 * To add a strategy: implement this, register it in registry.ts, add a block in strategies.config.json.
 */
export interface Strategy {
  readonly name: string;
  routes(ctx: ScanContext): Promise<Route[]>;
}

export function venuesForPair(venues: Venue[], a: Token, b: Token): Venue[] {
  const k1 = `${a.symbol}/${b.symbol}`;
  const k2 = `${b.symbol}/${a.symbol}`;
  return venues.filter((v) => v.pairs.includes(k1) || v.pairs.includes(k2));
}
