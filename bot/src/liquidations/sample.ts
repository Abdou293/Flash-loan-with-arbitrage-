import type { EnrichedEvent } from "./report.js";

/** Arbitrum produced about 3.7 blocks per second in our own measurements (about 0.27 s per block). */
export const BLOCKS_PER_DAY = 320_000;

export const byPosition = (a: { block: number; logIndex: number }, b: { block: number; logIndex: number }) =>
  a.block - b.block || a.logIndex - b.logIndex;

/**
 * Flag liquidations of a borrower who was already liquidated within `lookback` blocks before (partial liquidations).
 * For those the "how long was it liquidatable" measurement is not clean. Returns how many were flagged.
 * Events must belong to one chain; they are sorted in place.
 */
export function markRepeats(events: EnrichedEvent[], lookback: number): number {
  events.sort(byPosition);
  const lastBlock = new Map<string, number>();
  let n = 0;
  for (const e of events) {
    const prev = lastBlock.get(e.user);
    e.repeatUser = prev !== undefined && e.block - prev <= lookback;
    if (e.repeatUser) n++;
    lastBlock.set(e.user, e.block);
  }
  return n;
}

/** Deterministic, evenly spaced sample of up to n items (keeps the order). */
export function pickSample<T>(items: T[], n: number): T[] {
  if (n <= 0) return [];
  if (items.length <= n) return [...items];
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(items[Math.floor(((i + 0.5) * items.length) / n)]!);
  return out;
}

/** Plain-JSON (de)serialisation of events: bigint fields travel as strings. */
export const serializeEvent = (e: EnrichedEvent) => JSON.stringify(e, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
export const parseEvent = (o: any): EnrichedEvent => ({ ...o, debtToCover: BigInt(o.debtToCover), collateralAmount: BigInt(o.collateralAmount) });
