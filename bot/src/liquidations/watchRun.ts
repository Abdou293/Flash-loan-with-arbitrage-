import type { BotConfig } from "../config/load.js";
import { num, type Rpc } from "./rpc.js";
import {
  classify,
  estimate,
  findAssets,
  readAccounts,
  type AccountHealth,
  type Assumptions,
  type Band,
  type Estimate,
  type PositionAssets,
  type Thresholds,
} from "./watch.js";

export interface WatchContext {
  pool: string;
  baseUnit: bigint;
  /** Aave pool data provider (for the asset/lender lookup); omit to skip that lookup */
  dataProvider?: string;
  cfg: BotConfig;
  thresholds: Thresholds;
  assumptions: Assumptions;
  /** most users that get the (more expensive) asset lookup in one cycle */
  maxAssetLookups?: number;
}

export interface WatchRow {
  user: string;
  band: Band;
  hf: number;
  debtUsd: number;
  collateralUsd: number;
  estimate?: Estimate;
  assets?: PositionAssets;
}

export interface CycleResult {
  block: number;
  timestamp: string;
  watched: number;
  readFailures: number;
  counts: Record<Band, number>;
  /** liquidatable, at-risk and watch accounts, lowest health factor first */
  rows: WatchRow[];
  /** always true: this module never signs or sends anything */
  dryRun: true;
}

/** One monitoring pass: read every borrower's health in batches, classify, and say what the bot WOULD do. */
export async function runCycle(rpc: Rpc, ctx: WatchContext, users: string[]): Promise<CycleResult> {
  const block = num(await rpc.request("eth_blockNumber", []));
  // read at an explicit block so every account in the cycle is from the same state
  const { accounts, failed } = await readAccounts(rpc, ctx.pool, ctx.baseUnit, users, { blockTag: block });
  const counts: Record<Band, number> = { liquidatable: 0, at_risk: 0, watch: 0, healthy: 0, no_debt: 0 };
  const flagged: Array<{ a: AccountHealth; band: Band }> = [];
  for (const a of accounts) {
    const band = classify(a, ctx.thresholds);
    counts[band]++;
    if (band === "liquidatable" || band === "at_risk" || band === "watch") flagged.push({ a, band });
  }
  flagged.sort((x, y) => x.a.hf - y.a.hf);

  const rows: WatchRow[] = [];
  let lookups = 0;
  for (const { a, band } of flagged) {
    const row: WatchRow = { user: a.user, band, hf: a.hf, debtUsd: a.totalDebtUsd, collateralUsd: a.totalCollateralUsd };
    if (band === "liquidatable") row.estimate = estimate(a, ctx.cfg, ctx.assumptions);
    if (band !== "watch" && ctx.dataProvider && lookups < (ctx.maxAssetLookups ?? 20)) {
      lookups++;
      try {
        row.assets = await findAssets(rpc, ctx.dataProvider, ctx.cfg, a.user);
      } catch {
        /* the asset lookup is optional detail: a failure must not hide the account */
      }
    }
    rows.push(row);
  }
  return { block, timestamp: new Date().toISOString(), watched: users.length, readFailures: failed, counts, rows, dryRun: true };
}

const usd = (n: number) => "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });

export function formatCycle(r: CycleResult, maxRows = 15): string {
  const c = r.counts;
  const lines = [
    `block ${r.block}  watched ${r.watched}  liquidatable ${c.liquidatable}  at-risk ${c.at_risk}  watch ${c.watch}  healthy ${c.healthy}  no-debt ${c.no_debt}` +
      (r.readFailures ? `  (read failures: ${r.readFailures})` : ""),
  ];
  for (const x of r.rows.slice(0, maxRows)) {
    const as = x.assets?.debtSymbol
      ? ` debt ${x.assets.debtSymbol} / coll ${x.assets.collateralSymbol ?? "?"} / lender ${x.assets.lender ?? "NONE for this debt asset"}`
      : x.assets
        ? " assets: not in our token config"
        : "";
    const est = x.estimate
      ? `  -> DRY-RUN ${x.estimate.decision === "would_attempt" ? "would attempt" : "reject: " + x.estimate.reason}` +
        ` (cover ${usd(x.estimate.coverUsd)}, est. gross bonus ${usd(x.estimate.grossBonusUsd)}, gas ${usd(x.estimate.gasUsd)})`
      : "";
    lines.push(`  ${x.band.padEnd(12)} hf ${x.hf.toFixed(4)} debt ${usd(x.debtUsd).padStart(10)} ${x.user}${as}${est}`);
  }
  if (r.rows.length > maxRows) lines.push(`  ... and ${r.rows.length - maxRows} more`);
  return lines.join("\n");
}
