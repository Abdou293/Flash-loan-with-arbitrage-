import type { BotConfig } from "../config/load.js";
import type { Dataset } from "../core/dataset.js";
import { ReplayMarket } from "../core/market/ReplayMarket.js";
import { RiskEngine } from "../core/risk.js";
import { Store, type StrategyStats } from "../core/store.js";
import type { Opportunity } from "../core/types.js";
import { Engine } from "../engine.js";

export interface BacktestResult {
  dataset: Dataset["header"];
  snapshots: number;
  opportunities: Opportunity[];
  stats: Record<string, StrategyStats>;
  enabledStrategies: string[];
  flashLoanFeeBps: number;
}

/**
 * Replays every snapshot through the real engine (same strategies, profit calculator and risk engine as
 * the bot). Assumption (optimistic): an opportunity is filled at the recorded quote. There is no model of
 * competing bots, latency, or the price moving before inclusion, so results are an UPPER BOUND.
 */
export async function runBacktest(ds: Dataset, config: BotConfig): Promise<BacktestResult> {
  const market = new ReplayMarket(ds);
  const store = new Store(null);
  const engine = new Engine({
    config,
    market,
    simulator: { simulate: async () => ({ ok: true }) }, // no execution model in a backtest
    store,
    risk: new RiskEngine(config.risk),
    dryRun: true,
  });
  while (market.hasNext()) await engine.runCycle();
  return {
    dataset: ds.header,
    snapshots: market.snapshotCount,
    opportunities: store.recent,
    stats: store.stats,
    enabledStrategies: engine.enabledStrategies,
    flashLoanFeeBps: config.global.flashLoanFeeBps,
  };
}
