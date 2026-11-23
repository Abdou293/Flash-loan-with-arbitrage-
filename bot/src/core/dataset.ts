import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Historical dataset = one header line + one line per snapshot (JSONL).
 * A snapshot stores, for every venue/direction, a "rate curve": tokens-out per token-in at several trade
 * sizes (in USD). That is enough to replay any strategy, including multi-hop routes, at any size inside the
 * recorded range, without keeping an archive node around.
 */
export interface DatasetHeader {
  type: "header";
  source: "synthetic" | "rpc-archive" | "fork";
  createdAt: string;
  curveSizesUsd: number[];
  note: string;
  fromBlock?: number;
  toBlock?: number;
}

export interface Snapshot {
  type: "snapshot";
  block: number;
  timestamp: number;
  gasGwei: number;
  usd: Record<string, number>;
  /** key: `${venueId}|${tokenIn}|${tokenOut}` -> [[usdIn, tokensOutPerTokenIn], ...] ascending by usdIn */
  curves: Record<string, [number, number][]>;
}

export interface Dataset {
  header: DatasetHeader;
  snapshots: Snapshot[];
}

export function writeHeader(path: string, h: DatasetHeader): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(h) + "\n");
}

export function appendSnapshot(path: string, s: Snapshot): void {
  appendFileSync(path, JSON.stringify(s) + "\n");
}

export function readDataset(path: string): Dataset {
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const header = JSON.parse(lines[0]!) as DatasetHeader;
  if (header.type !== "header") throw new Error("dataset: first line must be the header");
  const snapshots = lines.slice(1).map((l) => JSON.parse(l) as Snapshot);
  return { header, snapshots };
}

/** Rate at `usdIn`, interpolated linearly in log(usd). Returns null when outside the recorded range. */
export function interpolateRate(curve: [number, number][], usdIn: number): number | null {
  if (curve.length === 0 || usdIn <= 0) return null;
  const first = curve[0]!;
  const last = curve[curve.length - 1]!;
  if (usdIn <= first[0]) return first[1]; // small trades: best recorded rate (least impact)
  if (usdIn > last[0] * 1.5) return null; // no data this large: refuse rather than extrapolate
  if (usdIn >= last[0]) return last[1];
  for (let i = 1; i < curve.length; i++) {
    const [x1, y1] = curve[i]!;
    if (usdIn <= x1) {
      const [x0, y0] = curve[i - 1]!;
      const t = (Math.log(usdIn) - Math.log(x0)) / (Math.log(x1) - Math.log(x0));
      return y0 + (y1 - y0) * t;
    }
  }
  return last[1];
}
