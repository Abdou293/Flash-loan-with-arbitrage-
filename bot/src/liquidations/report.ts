import type { LiquidationEvent } from "./aave.js";
import type { DelayResult } from "./delay.js";

export interface EnrichedEvent extends LiquidationEvent {
  timestamp: number;
  debtSymbol: string;
  collSymbol: string;
  debtUsd?: number;
  collUsd?: number;
  bonusPct?: number;
  grossBonusUsd?: number;
  /** same borrower liquidated again within the lookback window: delay is not a clean measurement */
  repeatUser?: boolean;
  delay?: DelayResult;
}

// ----- verdict rules (my rule of thumb, stated in the report; not a law) -----
/** a liquidation within this many blocks of becoming liquidatable counts as "instant" (2 blocks = about 0.5 s) */
export const INSTANT_MAX_BLOCKS = 2;
/** if at least this share of clean samples is instant, the field is treated as taken by professionals */
export const CROWDED_SHARE = 0.7;
export const MIN_SAMPLES = 10;

export const percentile = (sorted: number[], p: number): number | undefined =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] : undefined;

const sortNum = (a: number[]) => [...a].sort((x, y) => x - y);
const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
const day = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
const usd = (x: number | undefined, d = 0) =>
  x === undefined ? "-" : "$" + x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (x: number | undefined, d = 1) => (x === undefined ? "-" : x.toFixed(d) + "%");

export interface DayRow {
  day: string;
  count: number;
  debtUsd: number;
  medianDebtUsd?: number;
  maxDebtUsd?: number;
  medianBonusPct?: number;
  grossBonusUsd: number;
  liquidators: number;
}

export function perDay(events: EnrichedEvent[]): DayRow[] {
  const by = new Map<string, EnrichedEvent[]>();
  for (const e of events) by.set(day(e.timestamp), [...(by.get(day(e.timestamp)) ?? []), e]);
  return [...by.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([d, evs]) => {
      const debts = sortNum(evs.map((e) => e.debtUsd).filter((x): x is number => x !== undefined));
      const bonus = sortNum(evs.map((e) => e.bonusPct).filter((x): x is number => x !== undefined));
      return {
        day: d,
        count: evs.length,
        debtUsd: sum(debts),
        medianDebtUsd: percentile(debts, 50),
        maxDebtUsd: debts.length ? debts[debts.length - 1] : undefined,
        medianBonusPct: percentile(bonus, 50),
        grossBonusUsd: sum(evs.map((e) => e.grossBonusUsd ?? 0)),
        liquidators: new Set(evs.map((e) => e.liquidator)).size,
      };
    });
}

export interface AssetRow {
  symbol: string;
  count: number;
  usd: number;
}
export function topAssets(events: EnrichedEvent[], side: "debt" | "coll", n = 6): AssetRow[] {
  const m = new Map<string, AssetRow>();
  for (const e of events) {
    const symbol = side === "debt" ? e.debtSymbol : e.collSymbol;
    const usdv = (side === "debt" ? e.debtUsd : e.collUsd) ?? 0;
    const r = m.get(symbol) ?? { symbol, count: 0, usd: 0 };
    r.count++;
    r.usd += usdv;
    m.set(symbol, r);
  }
  return [...m.values()].sort((a, b) => b.count - a.count).slice(0, n);
}

export interface LiquidatorRow {
  address: string;
  count: number;
  share: number;
  usd: number;
}
export function liquidatorConcentration(events: EnrichedEvent[]) {
  const m = new Map<string, LiquidatorRow>();
  for (const e of events) {
    const r = m.get(e.liquidator) ?? { address: e.liquidator, count: 0, share: 0, usd: 0 };
    r.count++;
    r.usd += e.debtUsd ?? 0;
    m.set(e.liquidator, r);
  }
  const rows = [...m.values()].sort((a, b) => b.count - a.count);
  for (const r of rows) r.share = events.length ? r.count / events.length : 0;
  return { distinct: rows.length, top: rows.slice(0, 5), top3Share: sum(rows.slice(0, 3).map((r) => r.share)) };
}

export const BONUS_BUCKETS: [string, number, number][] = [
  ["< $1", -Infinity, 1],
  ["$1 - $5", 1, 5],
  ["$5 - $20", 5, 20],
  ["$20 - $100", 20, 100],
  ["$100 or more", 100, Infinity],
];

export function bonusBuckets(events: EnrichedEvent[]) {
  const priced = events.filter((e) => e.grossBonusUsd !== undefined);
  return BONUS_BUCKETS.map(([label, lo, hi]) => {
    const n = priced.filter((e) => e.grossBonusUsd! >= lo && e.grossBonusUsd! < hi).length;
    return { label, count: n, share: priced.length ? n / priced.length : 0 };
  });
}

export interface SpeedStats {
  sampled: number;
  clean: number;
  errors: number;
  repeatExcluded: number;
  censored: number;
  sameBlockShare?: number;
  instantShare?: number;
  within10Share?: number;
  medianBlocks?: number;
  p90Blocks?: number;
}

export function speedStats(events: EnrichedEvent[]): SpeedStats {
  const sampled = events.filter((e) => e.delay !== undefined);
  const errors = sampled.filter((e) => e.delay!.error).length;
  const ok = sampled.filter((e) => !e.delay!.error);
  const repeatExcluded = ok.filter((e) => e.repeatUser).length;
  const clean = ok.filter((e) => !e.repeatUser);
  const blocks = sortNum(clean.map((e) => e.delay!.blocks));
  const share = (f: (b: number) => boolean) => (clean.length ? clean.filter((e) => f(e.delay!.blocks)).length / clean.length : undefined);
  return {
    sampled: sampled.length,
    clean: clean.length,
    errors,
    repeatExcluded,
    censored: clean.filter((e) => e.delay!.censored).length,
    sameBlockShare: share((b) => b === 0),
    instantShare: share((b) => b <= INSTANT_MAX_BLOCKS),
    within10Share: share((b) => b <= 10),
    medianBlocks: percentile(blocks, 50),
    p90Blocks: percentile(blocks, 90),
  };
}

export type VerdictLabel = "crowded" | "mixed" | "slow" | "unknown";
export interface Verdict {
  label: VerdictLabel;
  text: string;
}

export function verdict(speed: SpeedStats, top3Share: number, distinct: number): Verdict {
  if (speed.clean < MIN_SAMPLES) {
    return {
      label: "unknown",
      text: `Only ${speed.clean} clean speed samples (need at least ${MIN_SAMPLES}); no conclusion about how fast liquidations are taken. Re-run with a larger --sample-hf.`,
    };
  }
  const inst = speed.instantShare ?? 0;
  const concentration = `${distinct} distinct liquidator address(es) in the period, the top 3 took ${pct(top3Share * 100, 0)} of all liquidations.`;
  if (inst >= CROWDED_SHARE) {
    return {
      label: "crowded",
      text:
        `${pct(inst * 100, 0)} of the sampled liquidations (${speed.clean} clean samples) happened within ${INSTANT_MAX_BLOCKS} block(s) of the position becoming liquidatable` +
        ` (median ${speed.medianBlocks} block(s), ${pct((speed.sameBlockShare ?? 0) * 100, 0)} in the very same block). ${concentration}` +
        ` Professional bots take essentially every liquidation immediately, usually in the same block as the price update that triggers it.` +
        ` A bot running on a free RPC and a laptop cannot realistically be first. Treat a liquidation bot as a **portfolio project, not a profit source**.`,
    };
  }
  if (inst < 0.3 && (speed.medianBlocks ?? 0) >= 20) {
    return {
      label: "slow",
      text:
        `Only ${pct(inst * 100, 0)} of the sampled liquidations were instant; the median position stayed liquidatable for ${speed.medianBlocks} blocks. ${concentration}` +
        ` Some positions wait, which could leave an opening for a slower bot. This is only a lead: it must be confirmed by quoting the whole path (collateral swap, gas, flash-loan) on a fork before any conclusion.`,
    };
  }
  return {
    label: "mixed",
    text:
      `${pct(inst * 100, 0)} of the sampled liquidations were instant (within ${INSTANT_MAX_BLOCKS} blocks), median delay ${speed.medianBlocks} blocks, ${pct((speed.within10Share ?? 0) * 100, 0)} within 10 blocks. ${concentration}` +
      ` Competition is strong but not total. Which positions wait (small ones? specific assets?) decides whether anything is left; do not assume a profit.`,
  };
}

export interface ReportInput {
  events: EnrichedEvent[];
  fromBlock: number;
  toBlock: number;
  generatedAt: string;
  scanRequests?: number;
  chunkInfo?: string;
  lookback: number;
  eventsWithoutPrice: number;
  /** liquidations of a borrower already liquidated within the lookback (not sampled for speed) */
  repeatEvents?: number;
  /** blocks of [fromBlock, toBlock] actually scanned (defaults to all of them) */
  coveredBlocks?: number;
  poolAddress: string;
}

export function renderReport(r: ReportInput): string {
  const ev = r.events;
  const days = perDay(ev);
  const speed = speedStats(ev);
  const liq = liquidatorConcentration(ev);
  const v = verdict(speed, liq.top3Share, liq.distinct);
  const total = r.toBlock - r.fromBlock + 1;
  const covered = Math.min(total, r.coveredBlocks ?? total);
  const first = ev.length ? Math.min(...ev.map((e) => e.timestamp)) : undefined;
  const last = ev.length ? Math.max(...ev.map((e) => e.timestamp)) : undefined;
  const bonusSorted = sortNum(ev.map((e) => e.bonusPct).filter((x): x is number => x !== undefined));
  const sizeSorted = sortNum(ev.map((e) => e.debtUsd).filter((x): x is number => x !== undefined));
  const L: string[] = [];

  L.push(`# Aave V3 liquidations on Arbitrum One: measurement report`, "");
  L.push(
    `Read-only measurement (\`npm run liquidations\`): historical \`LiquidationCall\` events, prices from the Aave oracle at the block of each event,`,
    `and, for a sample, the borrower's health factor in the blocks before the liquidation. Nothing was traded or simulated.`, "",
    `- Aave V3 Pool: \`${r.poolAddress}\``,
    `- Blocks: ${r.fromBlock}–${r.toBlock} (${r.toBlock - r.fromBlock + 1} blocks)` +
      (first && last ? `, ${new Date(first * 1000).toISOString()} to ${new Date(last * 1000).toISOString()} (first and last event)` : ""),
    ...(covered < total
      ? [
          `- **PARTIAL SCAN: ${covered.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} blocks scanned (${((covered / total) * 100).toFixed(0)}%).** ` +
            `Every count below covers only the scanned part; run the same command again to continue.`,
        ]
      : []),
    `- Liquidation events found: **${ev.length}**` + (r.eventsWithoutPrice ? ` (${r.eventsWithoutPrice} without an oracle price: excluded from USD figures)` : ""),
    `- Generated: ${r.generatedAt}`,
  );
  if (r.chunkInfo) L.push(`- Log scan: ${r.chunkInfo}`);
  L.push("");

  L.push(`## Per day (UTC)`, "");
  L.push(`| Day | Liquidations | Debt repaid (USD) | Median size | Largest | Median bonus | Gross bonus total (USD) | Distinct liquidators |`);
  L.push(`|---|---:|---:|---:|---:|---:|---:|---:|`);
  for (const d of days) {
    L.push(`| ${d.day} | ${d.count} | ${usd(d.debtUsd)} | ${usd(d.medianDebtUsd)} | ${usd(d.maxDebtUsd)} | ${pct(d.medianBonusPct, 2)} | ${usd(d.grossBonusUsd)} | ${d.liquidators} |`);
  }
  if (!days.length) L.push(`| (no liquidations in this range) | | | | | | | |`);
  L.push("");
  L.push(
    `Size: median ${usd(percentile(sizeSorted, 50))}, 90th percentile ${usd(percentile(sizeSorted, 90))}. ` +
      `Bonus measured at oracle prices: median ${pct(percentile(bonusSorted, 50), 2)}, 10th–90th percentile ${pct(percentile(bonusSorted, 10), 2)}–${pct(percentile(bonusSorted, 90), 2)} ` +
      `(gross of Aave's protocol fee on the bonus, so what a liquidator keeps is a bit lower).`, "",
  );

  L.push(`## How big is the prize? (gross bonus per liquidation, before swap costs, gas and loan fees)`, "");
  L.push(`| Gross bonus | Liquidations | Share |`, `|---|---:|---:|`);
  for (const b of bonusBuckets(ev)) L.push(`| ${b.label} | ${b.count} | ${pct(b.share * 100, 0)} |`);
  L.push("");

  L.push(`## Assets`, "");
  L.push(`| Debt asset | Liquidations | Debt repaid (USD) |`, `|---|---:|---:|`);
  for (const a of topAssets(ev, "debt")) L.push(`| ${a.symbol} | ${a.count} | ${usd(a.usd)} |`);
  L.push("", `| Collateral asset | Liquidations | Collateral value (USD) |`, `|---|---:|---:|`);
  for (const a of topAssets(ev, "coll")) L.push(`| ${a.symbol} | ${a.count} | ${usd(a.usd)} |`);
  L.push("");

  L.push(`## Who liquidates`, "");
  L.push(`${liq.distinct} distinct liquidator address(es); the top 3 took ${pct(liq.top3Share * 100, 0)} of all liquidations.`, "");
  L.push(`| Liquidator | Liquidations | Share | Debt repaid (USD) |`, `|---|---:|---:|---:|`);
  for (const t of liq.top) L.push(`| \`${t.address}\` | ${t.count} | ${pct(t.share * 100, 0)} | ${usd(t.usd)} |`);
  L.push("");

  L.push(`## How fast are liquidations taken? (sample)`, "");
  L.push(
    `For ${speed.sampled} sampled liquidations the borrower's health factor was read at past blocks (state at the end of each block) to find the first block from which the position`,
    `stayed liquidatable (health factor < 1) until it was liquidated. "0 blocks" means it became liquidatable inside the liquidation block itself`,
    `(typically an oracle price update followed by the bot in the same block). On Arbitrum one block is about 0.25 s.`, "",
  );
  L.push(`| Measure | Value |`, `|---|---:|`);
  L.push(`| Samples used (clean) | ${speed.clean} |`);
  L.push(`| Liquidations not sampled: same borrower already liquidated within ${r.lookback} blocks (partial liquidations) | ${(r.repeatEvents ?? 0) + speed.repeatExcluded} |`);
  L.push(`| Failed to read (RPC error / archive state unavailable) | ${speed.errors} |`);
  L.push(`| Same block (0 blocks) | ${pct(speed.sameBlockShare === undefined ? undefined : speed.sameBlockShare * 100, 0)} |`);
  L.push(`| Within ${INSTANT_MAX_BLOCKS} blocks (about ${(INSTANT_MAX_BLOCKS * 0.25).toFixed(1)} s) | ${pct(speed.instantShare === undefined ? undefined : speed.instantShare * 100, 0)} |`);
  L.push(`| Within 10 blocks (about 2.5 s) | ${pct(speed.within10Share === undefined ? undefined : speed.within10Share * 100, 0)} |`);
  L.push(`| Median delay (blocks) | ${speed.medianBlocks ?? "-"} |`);
  L.push(`| 90th percentile delay (blocks) | ${speed.p90Blocks ?? "-"} |`);
  L.push(`| Still liquidatable at the ${r.lookback}-block lookback limit (delay is a lower bound) | ${speed.censored} |`, "");

  L.push(`## Verdict: ${v.label.toUpperCase()}`, "", v.text, "");
  L.push(`Rule used: "crowded" when at least ${CROWDED_SHARE * 100}% of clean samples are within ${INSTANT_MAX_BLOCKS} blocks and there are at least ${MIN_SAMPLES} samples. These thresholds are my rule of thumb, not a law.`, "");

  L.push(`## Limitations`, "");
  L.push(
    `- The delay is measured on a **sample** of liquidations, and with the borrower's state at block granularity; it cannot see transactions that were sent but lost the race.`,
    `- A liquidation that happens in the very same block as the price update shows as 0 blocks: it proves the liquidator reacted immediately, not who it was.`,
    `- Prices come from the oracle currently registered in the Aave address provider, queried at each event's block; events from before that oracle existed have no price.`,
    `- "Gross bonus" ignores the cost of swapping the collateral back, gas and any flash-loan fee, so it overstates what a bot would keep.`,
    `- This is a measurement of the past; it says nothing about positions that will become liquidatable tomorrow.`, "",
  );
  return L.join("\n") + "\n";
}
