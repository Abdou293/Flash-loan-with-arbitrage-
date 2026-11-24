/** An "episode" is a continuous run of observations where a pool pair's gap is outside its fee band. */
export interface Episode {
  key: string;
  startBlock: number;
  endBlock: number; // last block observed still outside the band
  observations: number; // polls that saw it outside the band
  peakExcessBps: number;
  peakBlock: number;
  openAtEnd: boolean; // still open when monitoring stopped
  bestNetUsd?: number; // best estimated net profit found while open (if quoting was enabled)
  bestSizeUsd?: number; // trade size that gave bestNetUsd
  /** best net BEFORE the configured slippage safety reserve (the on-chain quote already includes price impact) */
  bestNetBeforeReserveUsd?: number;
  hypothetical?: boolean; // quoted with a token the zero-interest lender cannot supply
  quotedAtExcessBps?: number; // excess when the last quote was taken (re-quote when the gap widens)
  quotedAtPoll?: number;
  quotes?: number;
}

export class EpisodeTracker {
  private open = new Map<string, Episode>();
  readonly closed: Episode[] = [];

  /** Feed one observation. Returns the episode if this observation opened a NEW one. */
  observe(key: string, block: number, excessBps: number): Episode | undefined {
    const ep = this.open.get(key);
    if (excessBps > 0) {
      if (!ep) {
        const fresh: Episode = {
          key, startBlock: block, endBlock: block, observations: 1,
          peakExcessBps: excessBps, peakBlock: block, openAtEnd: false,
        };
        this.open.set(key, fresh);
        return fresh;
      }
      ep.endBlock = block;
      ep.observations++;
      if (excessBps > ep.peakExcessBps) {
        ep.peakExcessBps = excessBps;
        ep.peakBlock = block;
      }
      return undefined;
    }
    if (ep) {
      this.closed.push(ep);
      this.open.delete(key);
    }
    return undefined;
  }

  get(key: string): Episode | undefined {
    return this.open.get(key);
  }

  /** Close everything still open (call when monitoring stops). */
  finish(): Episode[] {
    for (const ep of this.open.values()) {
      ep.openAtEnd = true;
      this.closed.push(ep);
    }
    this.open.clear();
    return this.closed;
  }
}

/** Duration in blocks, inclusive (an episode seen in a single block lasts 1 block). */
export const durationBlocks = (e: Episode) => e.endBlock - e.startBlock + 1;
