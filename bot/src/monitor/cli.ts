import "../config/dotenv.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonRpcProvider } from "ethers";
import { loadConfig } from "../config/load.js";
import { RpcMarket } from "../core/market/RpcMarket.js";
import { bestSizeCandidate } from "../core/profit.js";
import type { Step, Token } from "../core/types.js";
import { durationBlocks, EpisodeTracker, type Episode } from "./episodes.js";
import { gapVersusFees, poolTvlUsd, usdPricesFrom } from "./math.js";
import { GapReader, type PoolInfo } from "./reader.js";

/**
 * Gap monitor ("radar"). Polls every pool in ONE eth_call (Multicall3) and records each moment the price gap between
 * two pools of the same pair is OUTSIDE the band their fees allow. For gaps involving a borrowable token it also quotes
 * the real round trip at that block and computes the net result with the bot's own profit calculator.
 * READ-ONLY: never sends a transaction.
 *
 *   npm run monitor -- --minutes 60 --interval-ms 500 [--no-quote]
 */
const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1]! : d;
};
const flag = (n: string) => process.argv.includes(`--${n}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const redact = (s: string) => s.replace(/(\/v2\/)[^\s"']+/g, "$1***");

interface PairStats {
  key: string;
  polls: number;
  outsideBand: number;
  closestExcessBps: number; // max excess seen, even if negative: how close the pair came to the band edge
}

async function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const rpcUrl = process.env.ARBITRUM_RPC_URL;
  if (!rpcUrl) throw new Error("Set ARBITRUM_RPC_URL in .env");
  const minutes = Number(arg("minutes", "60"));
  const intervalMs = Number(arg("interval-ms", "500"));
  const quote = !flag("no-quote");
  // Small sizes matter on Arbitrum: gas is cents, so a $100-$500 trade can clear costs that a $1k trade cannot.
  const sizes = (arg("sizes", "100,250,500,1000,5000") ?? "").split(",").map(Number).filter((n) => n > 0);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = arg("out", join(root, "data"))!;
  const config = loadConfig(join(root, arg("config", "radar.config.json")!));
  // Pools holding less than this (USD) are treated as dead: their "price" is stale and any trade moves it.
  const minTvlUsd = Number(arg("min-tvl-usd", "50000"));
  // While a gap is open, quote again when it has widened by this many bps (at most every 10 polls).
  const requoteBps = Number(arg("requote-bps", "3"));
  // The quote is an exact on-chain quote at that block (price impact included). The slippage reserve is an extra
  // safety margin for the price moving before inclusion; with the contract's revert-on-loss check, a failed attempt
  // costs gas, not principal. Override it to see its effect: --slippage-bps 2
  const slippageBps = Number(arg("slippage-bps", String(config.global.slippageBps)));
  const quoteCfg = { ...config.global, tradeSizesUsd: sizes, slippageBps };

  const provider = new JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });
  const reader = new GapReader(config, (tx) => provider.call(tx));
  const discovered = await reader.init();
  console.log(`Pools found: ${discovered.length}`);

  // size every pool in USD with the first snapshot's prices, then drop the dead ones
  const first = await reader.read();
  const usd = usdPricesFrom(
    discovered.filter((p) => first.prices.has(p.id)).map((p) => ({ a: p.a.symbol, b: p.b.symbol, price: first.prices.get(p.id)! })),
  );
  const tvl = new Map<string, number | undefined>();
  for (const p of discovered) {
    tvl.set(p.id, poolTvlUsd(p.balanceA, p.a.decimals, usd.get(p.a.symbol), p.balanceB, p.b.decimals, usd.get(p.b.symbol)));
  }
  const pools = discovered.filter((p) => (tvl.get(p.id) ?? 0) >= minTvlUsd);
  const fmt = (v: number | undefined) => (v === undefined ? "unknown" : "$" + Math.round(v).toLocaleString("en-US"));
  for (const p of discovered) {
    const keep = pools.includes(p);
    console.log(`  ${keep ? "use " : "skip"} ${p.id.padEnd(28)} TVL ${fmt(tvl.get(p.id))}${keep ? "" : `  (< $${minTvlUsd.toLocaleString("en-US")})`}`);
  }
  console.log(`Pools used: ${pools.length} of ${discovered.length} (minimum TVL $${minTvlUsd.toLocaleString("en-US")})`);

  // every pair of pools that trade the same two tokens
  const byPair = new Map<string, PoolInfo[]>();
  for (const p of pools) byPair.set(p.pairKey, [...(byPair.get(p.pairKey) ?? []), p]);
  const combos: [PoolInfo, PoolInfo][] = [];
  for (const group of byPair.values())
    for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) combos.push([group[i]!, group[j]!]);
  console.log(`Pool pairs compared each poll: ${combos.length}. Duration ${minutes} min, every ${intervalMs} ms.`);
  console.log("Read-only. Ctrl+C stops early and still writes the report.\n");

  const lookup = (a: Token, b: Token): Step | undefined => {
    const v = config.venues.find((x) => x.pairs.includes(`${a.symbol}/${b.symbol}`) || x.pairs.includes(`${b.symbol}/${a.symbol}`));
    return v ? { venue: v, tokenIn: a, tokenOut: b } : undefined;
  };
  const market = new RpcMarket({ rpcUrl, minCallIntervalMs: 100 }, config.tokens, lookup);
  const weth = config.tokens["WETH"]!;

  const tracker = new EpisodeTracker();
  const stats = new Map<string, PairStats>();
  let polls = 0, sameBlock = 0, errors = 0, consecutiveErrors = 0, lastBlock = -1, firstBlock = -1;
  let stop = false;
  process.on("SIGINT", () => (stop = true));
  const deadline = Date.now() + minutes * 60_000;
  let nextProgress = Date.now() + 60_000;

  /** price of `x` expressed in `y` for a pool, regardless of how the pool's pair is written in the config */
  const priceOf = (p: PoolInfo, raw: number, x: Token) => (p.a.symbol === x.symbol ? raw : 1 / raw);

  async function estimate(ep: Episode, hi: PoolInfo, lo: PoolInfo, borrow: Token, other: Token, block: number) {
    // borrow `borrow`, sell it where it is expensive (hi), buy it back where it is cheap (lo)
    market.setBlockTag(block);
    const route: Step[] = [
      { venue: hi.venue, tokenIn: borrow, tokenOut: other },
      { venue: lo.venue, tokenIn: other, tokenOut: borrow },
    ];
    try {
      const c = await bestSizeCandidate({ strategy: "gap", route, market, cfg: quoteCfg, maxTradeSizeUsd: config.risk.maxTradeSizeUsd, weth });
      if (c) {
        const net = Math.round(c.profit.netUsd * 100) / 100;
        if (ep.bestNetUsd === undefined || net > ep.bestNetUsd) {
          ep.bestNetUsd = net;
          ep.bestSizeUsd = c.amountInUsd; // size of the BEST quote, not of the latest one
        }
        const beforeReserve = Math.round((c.profit.netUsd + c.profit.slippageReserveUsd) * 100) / 100;
        ep.bestNetBeforeReserveUsd = Math.max(ep.bestNetBeforeReserveUsd ?? -Infinity, beforeReserve);
      }
    } catch (e) {
      console.log(`  (quote failed: ${redact(String(e)).slice(0, 120)})`);
    }
  }

  while (!stop && Date.now() < deadline) {
    const t0 = Date.now();
    try {
      const snap = await reader.read();
      consecutiveErrors = 0;
      polls++;
      if (firstBlock < 0) firstBlock = snap.block;
      if (snap.block === lastBlock) sameBlock++;
      lastBlock = snap.block;

      for (const [p0, p1] of combos) {
        const raw0 = snap.prices.get(p0.id);
        const raw1 = snap.prices.get(p1.id);
        if (raw0 === undefined || raw1 === undefined) continue;
        const [x, y] = [p0.a, p0.b]; // orientation of the first pool
        const g = gapVersusFees(priceOf(p0, raw0, x), priceOf(p1, raw1, x), p0.venue.fee / 1e6, p1.venue.fee / 1e6);
        const key = `${p0.id} <> ${p1.id}`;
        const st = stats.get(key) ?? { key, polls: 0, outsideBand: 0, closestExcessBps: -Infinity };
        st.polls++;
        if (g.excessBps > 0) st.outsideBand++;
        st.closestExcessBps = Math.max(st.closestExcessBps, g.excessBps);
        stats.set(key, st);

        const opened = tracker.observe(key, snap.block, g.excessBps);
        const live = opened ?? tracker.get(key);
        const widened =
          !opened && live && live.quotedAtExcessBps !== undefined &&
          g.excessBps >= live.quotedAtExcessBps + requoteBps && polls - (live.quotedAtPoll ?? 0) >= 10;
        if (opened || widened) {
          const ep = live!;
          console.log(`block ${snap.block}: ${opened ? "OUTSIDE fee band" : "gap widened    "}  ${key}  gap ${g.gapBps.toFixed(1)} bps vs band ${g.bandBps.toFixed(1)} bps (+${g.excessBps.toFixed(1)})`);
          // Borrow the token the zero-interest lender can supply. If neither token is borrowable, quote anyway as a
          // HYPOTHETICAL (marked) to size the opportunity: executing it would need an extra hop through WETH.
          const borrowable = [x, y].find((t) => config.flashLoan.borrowable.includes(t.symbol));
          if (quote) {
            const borrow = borrowable ?? x;
            const other = borrow === x ? y : x;
            const b0 = priceOf(p0, raw0, borrow), b1 = priceOf(p1, raw1, borrow);
            const [hi, lo] = b0 >= b1 ? [p0, p1] : [p1, p0]; // sell `borrow` where it is more expensive
            ep.hypothetical = !borrowable;
            ep.quotedAtExcessBps = g.excessBps;
            ep.quotedAtPoll = polls;
            ep.quotes = (ep.quotes ?? 0) + 1;
            await estimate(ep, hi, lo, borrow, other, snap.block);
            const size = ep.bestSizeUsd ? ` (size $${ep.bestSizeUsd})` : "";
            const hyp = ep.hypothetical ? "  [hypothetical: token not borrowable]" : "";
            console.log(`  -> estimated best net so far: ${ep.bestNetUsd ?? "n/a"} USD${size}${hyp}`);
          }
        }
      }
    } catch (e) {
      errors++;
      consecutiveErrors++;
      console.log(`poll error (${consecutiveErrors} in a row): ${redact(String(e)).slice(0, 140)}`);
      if (consecutiveErrors >= 20) {
        console.log("Too many consecutive errors, stopping.");
        break;
      }
      await sleep(2000);
    }
    if (Date.now() >= nextProgress) {
      nextProgress += 60_000;
      console.log(`[progress] polls ${polls}, blocks ${firstBlock}..${lastBlock}, episodes so far ${tracker.closed.length}, errors ${errors}`);
    }
    const wait = intervalMs - (Date.now() - t0);
    if (wait > 0) await sleep(wait);
  }

  const episodes = tracker.finish();
  const rows = [...stats.values()].map((st) => {
    const eps = episodes.filter((e) => e.key === st.key);
    const durations = eps.map(durationBlocks).sort((a, b) => a - b);
    const nets = eps.map((e) => e.bestNetUsd).filter((v): v is number => v !== undefined);
    return {
      pair: st.key,
      polls: st.polls,
      pollsOutsideBand: st.outsideBand,
      episodes: eps.length,
      maxExcessBps: Math.round(st.closestExcessBps * 10) / 10,
      longestEpisodeBlocks: durations.length ? durations[durations.length - 1]! : 0,
      medianEpisodeBlocks: durations.length ? durations[Math.floor(durations.length / 2)]! : 0,
      bestEstimatedNetUsd: nets.length ? Math.max(...nets) : null,
      bestSizeUsd: (() => {
        const best = eps.filter((e) => e.bestNetUsd !== undefined).sort((a, b) => b.bestNetUsd! - a.bestNetUsd!)[0];
        return best?.bestSizeUsd ?? null;
      })(),
      bestNetBeforeReserveUsd: (() => {
        const v = eps.map((e) => e.bestNetBeforeReserveUsd).filter((x): x is number => x !== undefined);
        return v.length ? Math.max(...v) : null;
      })(),
      episodesPositiveBeforeReserve: eps.filter((e) => (e.bestNetBeforeReserveUsd ?? -1) > 0).length,
      hypothetical: eps.some((e) => e.hypothetical),
      profitableEpisodes: nets.filter((n) => n > config.risk.minNetProfitUsd).length,
    };
  }).sort((a, b) => b.maxExcessBps - a.maxExcessBps);

  const blocksSpanned = lastBlock >= firstBlock && firstBlock >= 0 ? lastBlock - firstBlock + 1 : 0;
  const meta = {
    generatedAt: new Date().toISOString(),
    minutesRequested: minutes,
    intervalMs,
    polls,
    pollsSeeingSameBlock: sameBlock,
    blocks: { first: firstBlock, last: lastBlock, spanned: blocksSpanned },
    errors,
    tradeSizesUsd: sizes,
    slippageReserveBps: slippageBps,
    minTvlUsd,
    poolsDiscovered: discovered.length,
    poolsSkippedAsDead: discovered.filter((p) => !pools.includes(p)).map((p) => ({ id: p.id, tvlUsd: tvl.get(p.id) ?? null })),
    pools: pools.length,
    poolPairs: combos.length,
    quoting: quote,
    note: "Read-only sampling. Gaps are measured on pool mid prices against the two pools' fee band; 'estimated net' quotes the real round trip at that block with the bot's profit calculator (zero-interest loan). Polls see roughly one block in every few, so very short gaps can be missed.",
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `gaps.${stamp}.local.json`), JSON.stringify({ meta, rows, episodes }, null, 2));

  const md = [
    `# Gap monitor report`,
    ``,
    `- Generated: ${meta.generatedAt}`,
    `- Blocks: ${firstBlock}–${lastBlock} (${blocksSpanned} blocks), ${polls} polls every ${intervalMs} ms, ${errors} errors`,
    `- Pools: ${pools.length} used of ${discovered.length} found (pools under $${minTvlUsd.toLocaleString("en-US")} TVL skipped as dead), pool pairs compared: ${combos.length}, net-profit quoting: ${quote ? "on" : "off"} (re-quoted when a gap widens by ${requoteBps} bps)`,
    ``,
    `| Pool pair | Polls | Polls outside fee band | Episodes | Max excess (bps) | Longest episode (blocks) | Median episode (blocks) | Best est. net (USD) | at size | Best net before safety reserve (USD) | Episodes > 0 before reserve | Episodes with net > min profit |`,
    `|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|`,
    ...rows.map((r) => `| ${r.pair} | ${r.polls} | ${r.pollsOutsideBand} | ${r.episodes} | ${r.maxExcessBps} | ${r.longestEpisodeBlocks} | ${r.medianEpisodeBlocks} | ${r.bestEstimatedNetUsd ?? "-"}${r.hypothetical && r.bestEstimatedNetUsd !== null ? " (hyp.)" : ""} | ${r.bestSizeUsd ? "$" + r.bestSizeUsd : "-"} | ${r.bestNetBeforeReserveUsd ?? "-"} | ${r.episodesPositiveBeforeReserve} | ${r.profitableEpisodes} |`),
    ``,
    `"Max excess" is how far the price gap went beyond what the two pool fees allow (negative = never left the band).`,
    `Blocks are Arbitrum (L2) blocks, about 0.25 s each. Trade sizes quoted: ${sizes.map((n) => "$" + n).join(", ")}.`,
    `Net = on-chain quote - DEX fees/price impact (in the quote) - ${slippageBps} bps safety reserve - estimated gas. "Before safety reserve" drops only the reserve.`,
    `(hyp.) = hypothetical: neither token can be borrowed from the zero-interest lender; executing would need an extra hop via WETH.`,
    `An episode is a run of polls outside the band. Read-only measurement; nothing was traded.`,
    ``,
  ].join("\n");
  writeFileSync(join(outDir, `gaps.${stamp}.local.md`), md);
  console.log("\n" + md);
  console.log(`Saved: ${join(outDir, `gaps.${stamp}.local.md`)} (and .json)`);
}

main().catch((e) => {
  console.error(redact(String(e?.stack ?? e)));
  process.exit(1);
});
