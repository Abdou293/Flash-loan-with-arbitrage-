import type { LiquidationEvent } from "./aave.js";
import type { DelayResult } from "./delay.js";
import { BLOCKS_PER_DAY } from "./sample.js";

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
  /** false when the delay was measured only because of --focus-debt: such events stay out of the general statistics */
  inSample?: boolean;
}

/** Measured AND part of the random sample (events without the flag count as sampled, e.g. in older caches). */
export const inRandomSample = (e: EnrichedEvent) => e.delay !== undefined && e.inSample !== false;

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
  const sampled = events.filter(inRandomSample);
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

/** A sampled liquidation that waited more than this many blocks is called "slow". */
export const SLOW_MIN_BLOCKS = 10;

export interface SizeSpeed {
  clean: number;
  instant: number;
  slow: number;
  medianBonusInstantUsd?: number;
  medianBonusSlowUsd?: number;
  /** share of the sampled gross bonus (in USD) that was taken within INSTANT_MAX_BLOCKS */
  valueInstantShare?: number;
  /** share of the sampled gross bonus (in USD) carried by the slow liquidations */
  slowValueShare?: number;
}

/** Does speed depend on how much there is to win? Uses only the clean sampled liquidations with a known bonus. */
export function sizeVsSpeed(events: EnrichedEvent[]): SizeSpeed {
  const clean = events.filter((e) => inRandomSample(e) && !e.delay!.error && !e.repeatUser && e.grossBonusUsd !== undefined);
  const instant = clean.filter((e) => e.delay!.blocks <= INSTANT_MAX_BLOCKS);
  const slow = clean.filter((e) => e.delay!.blocks > SLOW_MIN_BLOCKS);
  const med = (xs: EnrichedEvent[]) => percentile(sortNum(xs.map((e) => e.grossBonusUsd!)), 50);
  const total = sum(clean.map((e) => Math.max(0, e.grossBonusUsd!)));
  return {
    clean: clean.length,
    instant: instant.length,
    slow: slow.length,
    medianBonusInstantUsd: med(instant),
    medianBonusSlowUsd: med(slow),
    valueInstantShare: total > 0 ? sum(instant.map((e) => Math.max(0, e.grossBonusUsd!))) / total : undefined,
    slowValueShare: total > 0 ? sum(slow.map((e) => Math.max(0, e.grossBonusUsd!))) / total : undefined,
  };
}

export function speedByBonus(events: EnrichedEvent[]) {
  const clean = events.filter((e) => inRandomSample(e) && !e.delay!.error && !e.repeatUser && e.grossBonusUsd !== undefined);
  return BONUS_BUCKETS.map(([label, lo, hi]) => {
    const inB = clean.filter((e) => e.grossBonusUsd! >= lo && e.grossBonusUsd! < hi);
    const blocks = sortNum(inB.map((e) => e.delay!.blocks));
    return {
      label,
      samples: inB.length,
      instantShare: inB.length ? inB.filter((e) => e.delay!.blocks <= INSTANT_MAX_BLOCKS).length / inB.length : undefined,
      medianBlocks: percentile(blocks, 50),
      censored: inB.filter((e) => e.delay!.censored).length,
    };
  });
}

export interface PrizeSummary {
  totalGrossBonusUsd: number;
  days: number;
  perDayUsd: number;
  top3Share?: number;
}

/** How much is there to win in the whole market, before anyone's costs? */
export function prizeSummary(events: EnrichedEvent[], coveredBlocks: number): PrizeSummary {
  const bonuses = events.map((e) => Math.max(0, e.grossBonusUsd ?? 0)).sort((a, b) => b - a);
  const total = sum(bonuses);
  const days = coveredBlocks / BLOCKS_PER_DAY;
  return {
    totalGrossBonusUsd: total,
    days,
    perDayUsd: days > 0 ? total / days : 0,
    top3Share: total > 0 ? sum(bonuses.slice(0, 3)) / total : undefined,
  };
}

export interface FocusRow {
  symbol: string;
  liquidations: number;
  /** partial liquidations of a borrower already liquidated within the lookback: not measured */
  repeats: number;
  measured: number;
  errors: number;
  instantShare?: number;
  medianBlocks?: number;
  censored: number;
  grossBonusUsd: number;
  /** gross bonus of the liquidations that waited more than SLOW_MIN_BLOCKS: what a slower bot could have competed for */
  slowGrossBonusUsd: number;
  liquidators: number;
}

/** Speed of EVERY liquidation whose debt asset is one of `symbols` (not a sample). */
export function focusStats(events: EnrichedEvent[], symbols: string[]): FocusRow[] {
  return symbols.map((symbol) => {
    const all = events.filter((e) => e.debtSymbol.toLowerCase() === symbol.toLowerCase());
    const measuredAll = all.filter((e) => e.delay && !e.repeatUser);
    const ok = measuredAll.filter((e) => !e.delay!.error);
    const blocks = sortNum(ok.map((e) => e.delay!.blocks));
    const slow = ok.filter((e) => e.delay!.blocks > SLOW_MIN_BLOCKS);
    return {
      symbol,
      liquidations: all.length,
      repeats: all.filter((e) => e.repeatUser).length,
      measured: ok.length,
      errors: measuredAll.length - ok.length,
      instantShare: ok.length ? ok.filter((e) => e.delay!.blocks <= INSTANT_MAX_BLOCKS).length / ok.length : undefined,
      medianBlocks: percentile(blocks, 50),
      censored: ok.filter((e) => e.delay!.censored).length,
      grossBonusUsd: sum(all.map((e) => Math.max(0, e.grossBonusUsd ?? 0))),
      slowGrossBonusUsd: sum(slow.map((e) => Math.max(0, e.grossBonusUsd ?? 0))),
      liquidators: new Set(all.map((e) => e.liquidator)).size,
    };
  });
}

export type VerdictLabel = "crowded" | "mixed" | "slow" | "unknown";
export interface Verdict {
  label: VerdictLabel;
  text: string;
}

export function verdict(speed: SpeedStats, top3Share: number, distinct: number, size?: SizeSpeed): Verdict {
  if (speed.clean < MIN_SAMPLES) {
    return {
      label: "unknown",
      text: `Only ${speed.clean} clean speed samples (need at least ${MIN_SAMPLES}); no conclusion about how fast liquidations are taken. Re-run with a larger --sample-hf.`,
    };
  }
  const inst = speed.instantShare ?? 0;
  const concentration = `${distinct} distinct liquidator address(es) in the period, the top 3 took ${pct(top3Share * 100, 0)} of all liquidations.`;
  const valueShare = size?.valueInstantShare;
  const usdv = (x: number | undefined) => (x === undefined ? "n/a" : "$" + x.toFixed(2));
  const slowNote =
    size && size.slow > 0
      ? ` ${size.slow} sampled liquidation(s) waited more than ${SLOW_MIN_BLOCKS} blocks; their median gross bonus was ${usdv(size.medianBonusSlowUsd)} against ${usdv(size.medianBonusInstantUsd)} for the instant ones, and together they carry ${pct((size.slowValueShare ?? 0) * 100, 0)} of the sampled gross bonus` +
        ((size.slowValueShare ?? 1) < 0.1
          ? " (the slow ones are the small ones: positions too small to pay for gas and swaps may simply be left alone)."
          : " (a meaningful share of the prize: look at them one by one before concluding anything).")
      : "";
  const valueNote = valueShare === undefined ? "" : ` Weighted by gross bonus, ${pct(valueShare * 100, 0)} of the sampled prize was taken within ${INSTANT_MAX_BLOCKS} blocks.`;
  if (inst >= CROWDED_SHARE && valueShare !== undefined && valueShare < CROWDED_SHARE) {
    return {
      label: "mixed",
      text:
        `Most sampled liquidations were instant (${pct(inst * 100, 0)} within ${INSTANT_MAX_BLOCKS} blocks) but they carried only ${pct(valueShare * 100, 0)} of the sampled gross bonus: the valuable ones were NOT all taken instantly.` +
        ` ${concentration}${slowNote} This is only a lead: confirm on a fork, quoting the whole path (collateral swap, gas, flash-loan), before concluding anything.`,
    };
  }
  if (inst >= CROWDED_SHARE) {
    return {
      label: "crowded",
      text:
        `${pct(inst * 100, 0)} of the sampled liquidations (${speed.clean} clean samples) happened within ${INSTANT_MAX_BLOCKS} block(s) of the position becoming liquidatable` +
        ` (median ${speed.medianBlocks} block(s), ${pct((speed.sameBlockShare ?? 0) * 100, 0)} in the very same block). ${concentration}` +
        `${valueNote}${slowNote}` +
        ` Professional bots take essentially every liquidation worth taking immediately, usually in the same block as the price update that triggers it.` +
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
  /** debt-asset symbols whose liquidations were ALL measured (--focus-debt) */
  focusDebt?: string[];
  /** blocks of [fromBlock, toBlock] actually scanned (defaults to all of them) */
  coveredBlocks?: number;
  poolAddress: string;
}

export function renderReport(r: ReportInput): string {
  const ev = r.events;
  const total = r.toBlock - r.fromBlock + 1;
  const covered = Math.min(total, r.coveredBlocks ?? total);
  const days = perDay(ev);
  const speed = speedStats(ev);
  const liq = liquidatorConcentration(ev);
  const size = sizeVsSpeed(ev);
  const v = verdict(speed, liq.top3Share, liq.distinct, size);
  const prize = prizeSummary(ev, covered);
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
  L.push(
    `Whole market, all liquidators together: gross bonus of **${usd(prize.totalGrossBonusUsd)}** over about ${prize.days.toFixed(1)} day(s)` +
      ` (about ${usd(prize.perDayUsd)} per day) before swap costs, gas and loan fees` +
      (prize.top3Share !== undefined ? `; the 3 largest liquidations made up ${pct(prize.top3Share * 100, 0)} of it.` : "."),
    "",
  );

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

  L.push(`### Speed by prize size (clean samples)`, "");
  L.push(`| Gross bonus | Samples | Within ${INSTANT_MAX_BLOCKS} blocks | Median delay (blocks) | At lookback limit |`, `|---|---:|---:|---:|---:|`);
  for (const b of speedByBonus(ev)) L.push(`| ${b.label} | ${b.samples} | ${pct(b.instantShare === undefined ? undefined : b.instantShare * 100, 0)} | ${b.medianBlocks ?? "-"} | ${b.censored} |`);
  L.push("");
  if (r.focusDebt?.length) {
    const rows = focusStats(ev, r.focusDebt);
    L.push(`## Focus: every liquidation whose debt is ${r.focusDebt.join(", ")} (all measured, not a sample)`, "");
    L.push(
      `Measured separately with \`--focus-debt\`; these extra measurements are NOT used in the general statistics or the verdict above,`,
      `which stay based on the random sample. Partial liquidations of the same borrower within the lookback are not measured.`,
      "",
    );
    L.push(
      `| Debt asset | Liquidations | Measured | Within ${INSTANT_MAX_BLOCKS} blocks | Median delay (blocks) | At lookback limit | Waited > ${SLOW_MIN_BLOCKS} blocks: gross bonus | Gross bonus, all | Distinct liquidators | Not measured (repeat / failed) |`,
      `|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|`,
    );
    for (const f of rows) {
      L.push(
        `| ${f.symbol} | ${f.liquidations} | ${f.measured} | ${pct(f.instantShare === undefined ? undefined : f.instantShare * 100, 0)} | ${f.medianBlocks ?? "-"} | ${f.censored} | ${usd(f.slowGrossBonusUsd, 2)} | ${usd(f.grossBonusUsd, 2)} | ${f.liquidators} | ${f.repeats} / ${f.errors} |`,
      );
    }
    L.push("");
  }
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
