import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config/load.js";
import { readDataset } from "../core/dataset.js";
import { renderMarkdown, summarize } from "./report.js";
import { runBacktest } from "./run.js";

async function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const arg = (n: string, d?: string) => {
    const i = process.argv.indexOf(`--${n}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
  };
  const path = arg("dataset", join(root, "data", "dataset.synthetic.local.jsonl"))!;
  const outDir = arg("out", join(root, "data"))!;
  const label = arg("label", "report")!;
  const config = loadConfig(join(root, "strategies.config.json"));
  // --flash-fee-bps 0 replays the same data as if the loan came from a zero-fee lender (Balancer V2 Vault).
  const feeOverride = arg("flash-fee-bps");
  if (feeOverride !== undefined) config.global.flashLoanFeeBps = Number(feeOverride);
  const result = await runBacktest(readDataset(path), config);
  mkdirSync(outDir, { recursive: true });
  const md = renderMarkdown(result);
  writeFileSync(join(outDir, `${label}.local.md`), md);
  writeFileSync(
    join(outDir, `${label}.local.json`),
    JSON.stringify({ dataset: result.dataset, snapshots: result.snapshots, summary: summarize(result), opportunities: result.opportunities }, null, 2),
  );
  console.log(md);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
