import type { RawLog } from "./aave.js";
import { hex, type Rpc } from "./rpc.js";

export interface Interval {
  from: number; // inclusive
  to: number; // inclusive
}

/** Sorted, non-overlapping, merged intervals of blocks already scanned. Persist this to resume. */
export interface ScanState {
  done: Interval[];
}

export function addInterval(done: Interval[], iv: Interval): Interval[] {
  const all = [...done, iv].sort((a, b) => a.from - b.from);
  const out: Interval[] = [];
  for (const cur of all) {
    const last = out[out.length - 1];
    if (last && cur.from <= last.to + 1) last.to = Math.max(last.to, cur.to);
    else out.push({ ...cur });
  }
  return out;
}

/** Parts of [from, to] not covered by `done`, ascending. */
export function missingIntervals(done: Interval[], from: number, to: number): Interval[] {
  const out: Interval[] = [];
  let cursor = from;
  for (const d of [...done].sort((a, b) => a.from - b.from)) {
    if (d.to < cursor) continue;
    if (d.from > to) break;
    if (d.from > cursor) out.push({ from: cursor, to: Math.min(to, d.from - 1) });
    cursor = Math.max(cursor, d.to + 1);
    if (cursor > to) break;
  }
  if (cursor <= to) out.push({ from: cursor, to });
  return out;
}

/** How many blocks of [from, to] are already scanned. */
export function coveredBlocks(done: Interval[], from: number, to: number): number {
  let n = 0;
  for (const d of done) {
    const lo = Math.max(d.from, from), hi = Math.min(d.to, to);
    if (hi >= lo) n += hi - lo + 1;
  }
  return n;
}

export type LogsErrorKind = "range" | "other";

/**
 * Providers report "too many blocks / too many results" in different words. Returns whether the request should be
 * retried with a smaller block range, and the provider's own suggestion when it gives one.
 */
export function classifyLogsError(msg: string): { kind: LogsErrorKind; suggestedSize?: number } {
  let m = /up to a (\d+) block range/i.exec(msg) ?? /(?:max(?:imum)?|limit)[^.\d]{0,40}?(\d{1,7})\s*blocks?/i.exec(msg);
  if (m) return { kind: "range", suggestedSize: Number(m[1]) };
  m = /(?:block )?range (?:of|is|limit(?: of)?)\s*:?\s*(\d{1,7})/i.exec(msg);
  if (m && /range/i.test(msg)) return { kind: "range", suggestedSize: Number(m[1]) };
  // Alchemy: "...Try with this block range [0x1a, 0x2f]"
  const h = /\[\s*(0x[0-9a-f]+)\s*,\s*(0x[0-9a-f]+)\s*\]/i.exec(msg);
  if (h) return { kind: "range", suggestedSize: Number(BigInt(h[2]!) - BigInt(h[1]!)) + 1 };
  if (/block range|too many (?:blocks|results)|more than \d+ results|response size|exceed(?:s|ed)? (?:the )?(?:max|limit)|result set too large|query timeout|range (?:too|is too) (?:large|wide|big)/i.test(msg)) {
    return { kind: "range" };
  }
  return { kind: "other" };
}

export interface ChunkPolicy {
  start: number;
  min: number;
  max: number;
}

export interface ScanStats {
  requests: number;
  rangeErrors: number;
  logs: number;
  finalChunk: number;
  /** largest range the provider is known to accept (after errors), or undefined if it never complained */
  ceiling?: number;
  /** true when the scan stopped early because `shouldStop` asked for it (progress is saved: run again to continue) */
  stopped?: boolean;
}

export interface ScanOptions {
  rpc: Rpc;
  address: string;
  topic0: string;
  from: number;
  to: number;
  state: ScanState;
  chunk: ChunkPolicy;
  /** called with the logs of one chunk BEFORE the chunk is marked done (so a crash never loses logs) */
  onLogs: (logs: RawLog[], iv: Interval) => void | Promise<void>;
  /** called after a chunk is marked done: persist `state` here */
  onChunkDone?: (state: ScanState, iv: Interval) => void | Promise<void>;
  onProgress?: (info: { iv: Interval; chunk: number; requests: number; logs: number; remaining: number }) => void;
  /** checked before every request; return true to stop cleanly (e.g. time budget used up) */
  shouldStop?: () => boolean;
}

/**
 * Scan [from, to] for logs of one event, in chunks that adapt to the provider's limits, skipping what `state`
 * says is already done (resumable). Block ranges that fail are retried smaller; the largest size that worked is
 * remembered as a ceiling so the scan does not keep re-hitting the same limit.
 */
export async function scanLogs(o: ScanOptions): Promise<ScanStats> {
  const stats: ScanStats = { requests: 0, rangeErrors: 0, logs: 0, finalChunk: o.chunk.start };
  let chunk = Math.max(o.chunk.min, Math.min(o.chunk.max, o.chunk.start));
  let ceiling = o.chunk.max;
  const gaps = missingIntervals(o.state.done, o.from, o.to);
  const total = gaps.reduce((s, g) => s + (g.to - g.from + 1), 0);
  let scanned = 0;

  for (const gap of gaps) {
    let start = gap.from;
    while (start <= gap.to) {
      if (o.shouldStop?.()) {
        stats.stopped = true;
        stats.finalChunk = chunk;
        return stats;
      }
      const end = Math.min(gap.to, start + chunk - 1);
      const iv = { from: start, to: end };
      let logs: RawLog[];
      try {
        stats.requests++;
        logs = (await o.rpc.request("eth_getLogs", [
          { address: o.address, topics: [o.topic0], fromBlock: hex(start), toBlock: hex(end) },
        ])) as RawLog[];
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const c = classifyLogsError(msg);
        if (c.kind !== "range") throw e;
        stats.rangeErrors++;
        if (chunk <= o.chunk.min) throw new Error(`eth_getLogs fails even for ${chunk} block(s): ${msg}`);
        const size = end - start + 1;
        const next = c.suggestedSize && c.suggestedSize < size ? c.suggestedSize : Math.floor(size / 2);
        chunk = Math.max(o.chunk.min, next);
        ceiling = Math.min(ceiling, chunk);
        stats.ceiling = ceiling;
        continue; // retry the same start with the smaller chunk
      }
      await o.onLogs(logs, iv);
      o.state.done = addInterval(o.state.done, iv);
      await o.onChunkDone?.(o.state, iv);
      stats.logs += logs.length;
      scanned += end - start + 1;
      o.onProgress?.({ iv, chunk, requests: stats.requests, logs: stats.logs, remaining: total - scanned });
      start = end + 1;
      chunk = Math.min(ceiling, o.chunk.max, chunk * 2); // grow again, never past a size that already failed
    }
  }
  stats.finalChunk = chunk;
  return stats;
}

export interface ProbeResult {
  size: number;
  ok: boolean;
  error?: string;
}

/** Find which block-range sizes the provider accepts for this event filter (recent blocks, read-only). */
export async function probeLogLimit(
  rpc: Rpc,
  address: string,
  topic0: string,
  latest: number,
  sizes = [100_000, 10_000, 2_000, 1_000, 500, 100, 10, 1],
): Promise<ProbeResult[]> {
  const out: ProbeResult[] = [];
  for (const size of sizes) {
    try {
      await rpc.request("eth_getLogs", [
        { address, topics: [topic0], fromBlock: hex(Math.max(0, latest - size + 1)), toBlock: hex(latest) },
      ]);
      out.push({ size, ok: true });
    } catch (e) {
      out.push({ size, ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 160) });
    }
  }
  return out;
}
