import type { BotConfig } from "./config/load.js";
import { bestSizeCandidate } from "./core/profit.js";
import { RiskEngine } from "./core/risk.js";
import type { Simulator } from "./core/simulator.js";
import type { Store } from "./core/store.js";
import type { Candidate, MarketData, Opportunity, OpportunityStatus } from "./core/types.js";
import { ALL_STRATEGIES } from "./strategies/registry.js";
import type { Strategy } from "./strategies/Strategy.js";

export interface EngineDeps {
  config: BotConfig;
  market: MarketData;
  simulator: Simulator;
  store: Store;
  risk: RiskEngine;
  dryRun: boolean;
  log?: (msg: string) => void;
}

const describe = (c: Candidate) =>
  c.route.map((s) => `${s.tokenIn.symbol}→${s.tokenOut.symbol}@${s.venue.id}`).join(" | ");

export class Engine {
  private cycle = 0;
  private seq = 0;
  private strategies: { strategy: Strategy; params: any }[];

  constructor(private readonly d: EngineDeps) {
    // Safety: this version can only simulate. Real sending is intentionally not implemented.
    if (!d.dryRun) throw new Error("Live execution is not implemented. Set DRY_RUN=true.");
    this.strategies = Object.entries(d.config.strategies)
      .filter(([, v]) => v.enabled)
      .map(([name, params]) => {
        const strategy = ALL_STRATEGIES[name];
        if (!strategy) throw new Error(`Unknown strategy in config: ${name}`);
        return { strategy, params };
      });
  }

  get enabledStrategies(): string[] {
    return this.strategies.map((s) => s.strategy.name);
  }

  async runCycle(): Promise<Opportunity[]> {
    const { market, config, risk, simulator, store } = this.d;
    await market.advance();
    this.cycle++;
    const gwei = await market.gasPriceGwei();
    const found: Opportunity[] = [];

    for (const { strategy, params } of this.strategies) {
      const routes = await strategy.routes({ market, tokens: config.tokens, venues: config.venues, params });
      for (const route of routes) {
        // Only borrow what the zero-interest lender can actually supply.
        if (!config.flashLoan.borrowable.includes(route[0]!.tokenIn.symbol)) continue;
        const c = await bestSizeCandidate({
          strategy: strategy.name,
          route,
          market,
          cfg: config.global,
          maxTradeSizeUsd: config.risk.maxTradeSizeUsd,
          weth: config.tokens["WETH"]!,
        });
        if (!c) continue;

        let status: OpportunityStatus;
        let reason: string | undefined;
        if (c.profit.net <= 0n) {
          status = "unprofitable";
        } else {
          const decision = risk.check(c, gwei);
          if (!decision.ok) {
            status = risk.paused ? "skipped_paused" : "rejected_risk";
            reason = decision.reason;
          } else {
            const sim = await simulator.simulate(c, this.cycle);
            risk.recordResult(sim.ok);
            status = sim.ok ? "simulated_ok" : "simulated_revert";
            reason = sim.reason;
          }
        }
        const opp = this.toOpportunity(c, status, reason);
        store.record(opp);
        if (status !== "unprofitable") found.push(opp);
      }
    }
    this.d.log?.(`cycle ${this.cycle}: ${found.length} candidate(s), gas ${gwei.toFixed(3)} gwei`);
    return found;
  }

  private toOpportunity(c: Candidate, status: OpportunityStatus, reason?: string): Opportunity {
    return {
      id: `${this.cycle}-${++this.seq}`,
      cycle: this.cycle,
      timestamp: new Date().toISOString(),
      strategy: c.strategy,
      route: describe(c),
      borrowToken: c.borrowToken.symbol,
      amountInUsd: Math.round(c.amountInUsd),
      grossProfitUsd: round(c.profit.grossUsd),
      flashLoanFeeUsd: round(c.profit.flashLoanFeeUsd),
      slippageReserveUsd: round(c.profit.slippageReserveUsd),
      gasCostUsd: round(c.profit.gasCostUsd),
      netProfitUsd: round(c.profit.netUsd),
      status,
      reason,
      dataSource: this.d.market.source,
    };
  }
}

const round = (x: number) => Math.round(x * 100) / 100;
