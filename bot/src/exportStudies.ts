import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseReport, type Study } from "./studies.js";

/**
 * Writes dashboard/data/studies.json from the measurement reports in docs/reports (real, read-only runs).
 *   npm run export-studies
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const reports: { id: string; file: string; module: "liquidation" | "arbitrage"; label: string }[] = [
  { id: "liq-30d", file: "liquidations-2026-10-24-to-11-25-arbitrum-30d.md", module: "liquidation", label: "Aave V3 liquidations, 30 days" },
  { id: "liq-3d", file: "liquidations-2026-11-21-to-25-arbitrum.md", module: "liquidation", label: "Aave V3 liquidations, first 3-day run" },
  { id: "arb-backtest", file: "backtest-2026-11-24-arbitrum-24h.md", module: "arbitrage", label: "Arbitrage backtest on 24 h of real quotes" },
  { id: "arb-gap-expanded", file: "gap-monitor-2026-11-24-1h-expanded.md", module: "arbitrage", label: "Gap radar, expanded, 1 hour" },
  { id: "arb-gap-1h", file: "gap-monitor-2026-11-24-1h.md", module: "arbitrage", label: "Gap radar, 1 hour" },
  { id: "arb-gap-before-reserve", file: "gap-monitor-2026-11-24-1h-before-reserve.md", module: "arbitrage", label: "Gap radar, net before the safety reserve" },
];

const studies: (Study & { module: string; label: string })[] = [];
for (const r of reports) {
  const path = join(root, "docs", "reports", r.file);
  if (!existsSync(path)) {
    console.error(`missing report: ${r.file}`);
    process.exit(1);
  }
  studies.push({ ...parseReport(r.id, r.file, readFileSync(path, "utf8")), module: r.module, label: r.label });
}
const out = {
  meta: {
    dataSource: "real measurements from past read-only runs (parsed from docs/reports, nothing retyped)",
    generatedAt: new Date().toISOString(),
    note: "Each study is a report produced on the owner's machine from real Arbitrum data. Sections called 'analyst notes' are written by the author, not produced by the tool.",
  },
  studies,
};
const dir = join(root, "dashboard", "data");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "studies.json"), JSON.stringify(out, null, 1));
console.log(`Wrote dashboard/data/studies.json: ${studies.length} studies, ${studies.reduce((a, s) => a + s.blocks.filter((b) => b.type === "table").length, 0)} tables.`);
