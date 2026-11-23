import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { loadConfig } from "../config/load.js";
import { appendSnapshot, writeHeader } from "../core/dataset.js";
import { SampleMarket } from "../core/market/SampleMarket.js";
import { buildSnapshot, DEFAULT_CURVE_SIZES_USD } from "./snapshot.js";

/** Writes a SYNTHETIC dataset (random prices). Used to test the pipeline and to feed the demo dashboard. */
async function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const arg = (n: string, d: string) => {
    const i = process.argv.indexOf(`--${n}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
  };
  const out = arg("out", join(root, "data", "dataset.synthetic.local.jsonl"));
  const snapshots = Number(arg("snapshots", "300"));
  const seed = Number(arg("seed", "42"));
  const config = loadConfig(join(root, "strategies.config.json"));
  const market = new SampleMarket({ seed, tokenUsd: config.tokenUsd, venues: config.venues, tokens: config.tokens });

  writeHeader(out, {
    type: "header",
    source: "synthetic",
    createdAt: new Date().toISOString(),
    curveSizesUsd: DEFAULT_CURVE_SIZES_USD,
    note: `SYNTHETIC random data (seed ${seed}). Not real market history.`,
  });
  for (let i = 0; i < snapshots; i++) {
    await market.advance();
    appendSnapshot(out, await buildSnapshot(market, config, DEFAULT_CURVE_SIZES_USD, i + 1, 1_700_000_000 + i * 60));
  }
  console.log(`wrote ${snapshots} synthetic snapshots -> ${out}`);
}
main();
