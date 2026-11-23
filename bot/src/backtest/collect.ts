import "dotenv/config";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config/load.js";
import { appendSnapshot, writeHeader } from "../core/dataset.js";
import { RpcMarket } from "../core/market/RpcMarket.js";
import type { Step } from "../core/types.js";
import { buildSnapshot, DEFAULT_CURVE_SIZES_USD } from "./snapshot.js";

/**
 * Records REAL historical snapshots into a dataset file by querying past blocks (read-only eth_call).
 *   - needs an ARCHIVE-capable RPC (free Alchemy plans work for limited history) or a local anvil --fork-url fork.
 *   - free-tier friendly: one call at a time, `--interval-ms` between calls, resumable by choosing block ranges.
 * Example:  npm run collect -- --from-block <N> --to-block <M> --step 2000 --interval-ms 300
 * NOT exercised by automated tests (the build sandbox has no network). Try a tiny range first (3 snapshots).
 */
async function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const arg = (n: string, d?: string) => {
    const i = process.argv.indexOf(`--${n}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
  };
  const rpcUrl = process.env.ARBITRUM_RPC_URL;
  if (!rpcUrl) throw new Error("Set ARBITRUM_RPC_URL in .env");
  const from = Number(arg("from-block"));
  const to = Number(arg("to-block"));
  const step = Number(arg("step", "1000"));
  if (!from || !to || to < from) throw new Error("Provide --from-block and --to-block (to >= from)");
  const out = arg("out", join(root, "data", "dataset.rpc.local.jsonl"))!;
  const config = loadConfig(arg("config", join(root, "strategies.config.json"))!);

  const lookup = (a: any, b: any): Step | undefined => {
    const v = config.venues.find((x) => x.pairs.includes(`${a.symbol}/${b.symbol}`) || x.pairs.includes(`${b.symbol}/${a.symbol}`));
    return v ? { venue: v, tokenIn: a, tokenOut: b } : undefined;
  };
  const market = new RpcMarket({ rpcUrl, minCallIntervalMs: Number(arg("interval-ms", "300")) }, config.tokens, lookup);

  writeHeader(out, {
    type: "header",
    source: rpcUrl.includes("127.0.0.1") || rpcUrl.includes("localhost") ? "fork" : "rpc-archive",
    createdAt: new Date().toISOString(),
    curveSizesUsd: DEFAULT_CURVE_SIZES_USD,
    note: "Real on-chain quotes (Uniswap QuoterV2 / V2 getAmountsOut) recorded per block.",
    fromBlock: from,
    toBlock: to,
  });
  let n = 0;
  for (let b = from; b <= to; b += step) {
    market.setBlockTag(b);
    const snap = await buildSnapshot(market, config, DEFAULT_CURVE_SIZES_USD, b, 0);
    appendSnapshot(out, snap);
    console.log(`block ${b}: ${Object.keys(snap.curves).length} curves, gas ${snap.gasGwei.toFixed(4)} gwei (#${++n})`);
  }
  console.log(`done -> ${out}`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
