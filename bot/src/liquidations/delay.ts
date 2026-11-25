export interface DelayResult {
  /**
   * How many whole blocks the position had ALREADY been liquidatable when the liquidation block started:
   *   0  = it became liquidatable inside the same block as the liquidation (e.g. an oracle update, then the bot)
   *   1  = liquidatable at the end of the previous block, liquidated in the next one, and so on.
   */
  blocks: number;
  /** true when still liquidatable at the lookback limit: the real delay is at least `blocks` */
  censored: boolean;
  /** number of state queries used */
  calls: number;
  error?: string;
}

/**
 * Binary search for the first block from which a borrower stayed liquidatable until `liquidationBlock`.
 * `isLiquidatable(b)` must answer for the state at the END of block b. Assumes the status does not flip back and
 * forth inside the lookback window (positions that were liquidated before, in part, are flagged by the caller).
 */
export async function liquidatableForBlocks(
  isLiquidatable: (block: number) => Promise<boolean>,
  liquidationBlock: number,
  maxLookback: number,
): Promise<DelayResult> {
  let calls = 0;
  const q = async (b: number) => {
    calls++;
    return isLiquidatable(b);
  };
  const N = liquidationBlock;

  if (!(await q(N - 1))) return { blocks: 0, censored: false, calls };

  let liq = N - 1; // known liquidatable
  let notLiq: number | undefined;
  for (let step = 1; ; step *= 2) {
    let b = N - 1 - step;
    const clamped = N - b > maxLookback;
    if (clamped) b = N - maxLookback;
    if (await q(b)) {
      if (clamped) return { blocks: maxLookback, censored: true, calls };
      liq = b;
    } else {
      notLiq = b;
      break;
    }
  }
  let lo = notLiq!;
  let hi = liq;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (await q(mid)) hi = mid;
    else lo = mid;
  }
  return { blocks: N - hi, censored: false, calls };
}
