import type { Candidate, RiskConfig } from "./types.js";

export interface RiskDecision {
  ok: boolean;
  reason?: string;
}

/** Guards every opportunity before simulation/execution. */
export class RiskEngine {
  private consecutiveFailures = 0;
  private _paused = false;

  constructor(private readonly cfg: RiskConfig) {}

  get paused(): boolean {
    return this._paused;
  }

  check(c: Candidate, gasPriceGwei: number): RiskDecision {
    if (this._paused) return { ok: false, reason: "auto-paused after consecutive failures" };
    if (c.profit.netUsd < this.cfg.minNetProfitUsd)
      return { ok: false, reason: `net profit $${c.profit.netUsd.toFixed(2)} < min $${this.cfg.minNetProfitUsd}` };
    if (gasPriceGwei > this.cfg.maxGasPriceGwei)
      return { ok: false, reason: `gas ${gasPriceGwei.toFixed(3)} gwei > max ${this.cfg.maxGasPriceGwei}` };
    if (c.amountInUsd > this.cfg.maxTradeSizeUsd)
      return { ok: false, reason: `size $${c.amountInUsd} > cap $${this.cfg.maxTradeSizeUsd}` };
    return { ok: true };
  }

  /** Report the outcome of a simulation/execution. Pauses after N failures in a row. */
  recordResult(success: boolean): void {
    if (success) {
      this.consecutiveFailures = 0;
      return;
    }
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.cfg.maxConsecutiveFailures) this._paused = true;
  }

  /** Manual resume (operator decision). */
  resume(): void {
    this._paused = false;
    this.consecutiveFailures = 0;
  }
}
