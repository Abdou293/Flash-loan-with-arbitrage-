import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildShadow, parseHistory } from "./shadow.js";

/**
 * Writes dashboard/data/shadow.json from the cycles recorded by `npm run liq-watch`.
 *   npm run export-shadow
 * Run `npm run liq-watch -- --discover-blocks 20000 --interval-s 60` for a few hours first (shadow mode).
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const history = join(root, "data", "liquidations", "watch-history.42161.jsonl");
if (!existsSync(history)) {
  console.error("No shadow data yet. Run: npm run liq-watch -- --discover-blocks 20000 --interval-s 60 (let it run for hours)");
  process.exit(1);
}
const out = buildShadow(parseHistory(readFileSync(history, "utf8")));
const dir = join(root, "..", "dashboard", "data");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "shadow.json"), JSON.stringify(out, null, 2));
console.log(`Wrote dashboard/data/shadow.json: ${out.meta.cycles} cycles over ${out.meta.hoursObserved} h, ${out.meta.accountsWatched} accounts watched.`);
console.log(`Cycles with a liquidatable account: ${out.meta.cyclesWithLiquidatable}; with a dry-run "would attempt": ${out.meta.cyclesWithWouldAttempt}.`);
