import "../config/dotenv.js";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonRpcProvider } from "ethers";
import {
  AAVE_POOL_ARBITRUM,
  decodeLiquidationLog,
  eventId,
  LIQUIDATION_CALL_TOPIC,
  type RawLog,
} from "./aave.js";
import { liquidatableForBlocks } from "./delay.js";
import {
  blockTimestamp,
  computeEconomics,
  fetchPrices,
  fetchTokenMeta,
  isLiquidatableAt,
  resolveAave,
  type TokenMeta,
} from "./enrich.js";
import { probeLogLimit, scanLogs, type ScanState } from "./logs.js";
import { renderReport, type EnrichedEvent } from "./report.js";
import { redact, ThrottledRpc, hex, num } from "./rpc.js";
import { BLOCKS_PER_DAY, markRepeats, parseEvent, pickSample, serializeEvent } from "./sample.js";

/**
 * Aave V3 liquidation measurement on Arbitrum One. READ-ONLY: only eth_getLogs, eth_call and eth_getBlockByNumber.
 *
 *   npm run liquidations -- --probe                 # 1) find out what block range your RPC accepts for eth_getLogs
 *   npm run liquidations -- --days 3                # 2) scan, enrich, sample speed, write the report
 *
 * Resumable: scanned block ranges, raw logs and enriched events are cached under data/liquidations/ (git-ignored).
 * Re-running the same command continues where it stopped; use --reset to start over.
 */
const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1]! : d;
};
const flag = (n: string) => process.argv.includes(`--${n}`);
const log = (m: string) => console.log(m);

function atomicWrite(path: string, text: string) {
  const tmp = path + ".tmp";
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function main() {
  if (flag("help") || flag("h")) {
    log(
      [
        "Usage: npm run liquidations -- [options]",
        "  --probe               only test which eth_getLogs block ranges the RPC accepts, then exit",
        "  --days N              scan about N days back from the latest block (default 3)",
        "  --from-block B --to-block B   explicit range (overrides --days)",
        "  --chunk-blocks N      starting eth_getLogs range (default 5000; adapts automatically)",
        "  --max-chunk N         largest range ever tried (default 50000)",
        "  --interval-ms N       minimum delay between RPC requests (default 250, free-tier friendly)",
        "  --sample-hf N         liquidations to measure for speed (default 40; each costs ~25 eth_calls)",
        "  --lookback N          how far back (blocks) to look for when a position became liquidatable (default 20000)",
        "  --logs-rpc-url URL    use another RPC for eth_getLogs only (or set ARBITRUM_LOGS_RPC_URL)",
        "  --out-dir DIR         where the report is written (default data)",
        "  --reset               ignore cached data and start over",
      ].join("\n"),
    );
    return;
  }

  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const stateUrl = process.env.ARBITRUM_RPC_URL;
  if (!stateUrl) throw new Error("Set ARBITRUM_RPC_URL in .env");
  const logsUrl = arg("logs-rpc-url") ?? process.env.ARBITRUM_LOGS_RPC_URL ?? stateUrl;
  const intervalMs = Number(arg("interval-ms", "250"));
  const mk = (url: string) => new ThrottledRpc(new JsonRpcProvider(url, undefined, { staticNetwork: true }), { minIntervalMs: intervalMs });
  const stateRpc = mk(stateUrl);
  const logsRpc = logsUrl === stateUrl ? stateRpc : mk(logsUrl);

  const chainId = num(await stateRpc.request("eth_chainId", []));
  if (chainId !== 42161) log(`WARNING: chain id is ${chainId}, expected 42161 (Arbitrum One). Aborting is safer.`);
  const latest = num(await stateRpc.request("eth_blockNumber", []));
  const pool = AAVE_POOL_ARBITRUM;

  // ---- probe mode -----------------------------------------------------------------------------
  if (flag("probe")) {
    log(`Probing eth_getLogs on ${logsUrl === stateUrl ? "your RPC" : "the logs RPC"} (latest block ${latest}). Read-only.\n`);
    const res = await probeLogLimit(logsRpc, pool, LIQUIDATION_CALL_TOPIC, latest);
    for (const r of res) log(`  ${String(r.size).padStart(7)} blocks: ${r.ok ? "accepted" : "REFUSED  " + redact(r.error ?? "")}`);
    const best = res.find((r) => r.ok)?.size;
    if (!best) {
      log("\nNo range was accepted at all. Check ARBITRUM_RPC_URL (and that the Arbitrum network is enabled in your provider).");
      return;
    }
    const perDay = Math.ceil(BLOCKS_PER_DAY / best);
    log(`\nLargest accepted size from the list: ${best} blocks per request.`);
    log(`One day (about ${BLOCKS_PER_DAY.toLocaleString("en-US")} blocks) needs at least ${perDay.toLocaleString("en-US")} getLogs requests`);
    log(`  = about ${((perDay * (intervalMs + 100)) / 60_000).toFixed(0)} minutes (${intervalMs} ms between requests plus about 100 ms per request), and about ${((perDay * 60) / 1e6).toFixed(2)}M compute units (Alchemy counts ~60 per getLogs).`);
    if (best < 1000) {
      log("\nThis RPC only allows tiny ranges, so a multi-day scan would be slow and use a lot of your free quota.");
      log("Options: scan fewer days, or use --logs-rpc-url with another free RPC that allows larger ranges (only for eth_getLogs).");
    } else {
      log("\nThis is fine for a multi-day scan.");
    }
    return;
  }

  // ---- range ----------------------------------------------------------------------------------
  const days = Number(arg("days", "3"));
  const to = arg("to-block") ? Number(arg("to-block")) : latest;
  const from = arg("from-block") ? Number(arg("from-block")) : Math.max(1, to - Math.round(days * BLOCKS_PER_DAY));
  if (!(from > 0 && to >= from)) throw new Error("Invalid block range");
  const startChunk = Number(arg("chunk-blocks", "5000"));
  const maxChunk = Number(arg("max-chunk", "50000"));
  const sampleN = Number(arg("sample-hf", "40"));
  const lookback = Number(arg("lookback", "20000"));
  const outDir = arg("out-dir") ?? join(root, "data");
  const cacheDir = join(root, "data", "liquidations");
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  const files = {
    state: join(cacheDir, `scan-state.${chainId}.json`),
    logs: join(cacheDir, `logs.${chainId}.jsonl`),
    enriched: join(cacheDir, `enriched.${chainId}.json`),
  };
  if (flag("reset")) {
    for (const f of Object.values(files)) if (existsSync(f)) renameSync(f, f + ".old");
    log("Cache reset (old files kept with a .old suffix).");
  }

  log(`Aave V3 liquidations: blocks ${from}–${to} (${(to - from + 1).toLocaleString("en-US")} blocks, about ${((to - from + 1) / BLOCKS_PER_DAY).toFixed(1)} days). Read-only.`);
  const aave = await resolveAave(stateRpc, pool);
  log(`Pool ${pool}\n  addresses provider ${aave.provider} (points back to the pool: ok)\n  price oracle       ${aave.oracle} (price unit ${aave.baseUnit})`);

  // ---- 1) scan logs (adaptive, resumable) -----------------------------------------------------
  const state = readJson<ScanState & { pool?: string }>(files.state, { done: [] });
  if (state.pool && state.pool.toLowerCase() !== pool.toLowerCase()) throw new Error("Cache belongs to another pool; use --reset");
  const startedAt = Date.now();
  let lastPrint = 0;
  const stats = await scanLogs({
    rpc: logsRpc,
    address: pool,
    topic0: LIQUIDATION_CALL_TOPIC,
    from,
    to,
    state,
    chunk: { start: startChunk, min: 1, max: maxChunk },
    onLogs: (logs: RawLog[]) => {
      if (logs.length) appendFileSync(files.logs, logs.map((l) => JSON.stringify(l)).join("\n") + "\n");
    },
    onChunkDone: (s) => atomicWrite(files.state, JSON.stringify({ pool, done: s.done })),
    onProgress: (p) => {
      if (Date.now() - lastPrint < 10_000) return;
      lastPrint = Date.now();
      log(`  scanning... blocks left ${p.remaining.toLocaleString("en-US")}, chunk ${p.chunk}, requests ${p.requests}, liquidations found so far ${p.logs}`);
    },
  });
  const minutes = ((Date.now() - startedAt) / 60_000).toFixed(1);
  const chunkInfo = `${stats.requests} getLogs requests, ${stats.rangeErrors} range errors, final chunk ${stats.finalChunk} blocks` + (stats.ceiling ? `, provider limit found: about ${stats.ceiling} blocks` : "");
  log(`Scan finished in ${minutes} min: ${chunkInfo}.`);

  // ---- load + decode every cached log in range --------------------------------------------------
  const seen = new Map<string, ReturnType<typeof decodeLiquidationLog>>();
  if (existsSync(files.logs)) {
    for (const line of readFileSync(files.logs, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = decodeLiquidationLog(JSON.parse(line) as RawLog);
        if (e.block >= from && e.block <= to) seen.set(eventId(e), e);
      } catch {
        /* a half-written last line from a crash: ignore */
      }
    }
  }
  log(`Liquidation events in range: ${seen.size}`);

  // ---- 2) enrich: token info, oracle prices at each event's block, timestamps ---------------------
  type Stored = { tokens: Record<string, TokenMeta>; events: Record<string, any>; blocks: Record<string, number> };
  const store = readJson<Stored>(files.enriched, { tokens: {}, events: {}, blocks: {} });
  const assets = [...new Set([...seen.values()].flatMap((e) => [e.debtAsset, e.collateralAsset]))];
  const unknown = assets.filter((a) => !store.tokens[a]);
  if (unknown.length) Object.assign(store.tokens, await fetchTokenMeta(stateRpc, unknown));
  const save = () => atomicWrite(files.enriched, JSON.stringify(store));

  const sorted = [...seen.values()].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  const events: EnrichedEvent[] = [];
  let done = 0;
  for (const e of sorted) {
    const id = eventId(e);
    let ev: EnrichedEvent;
    if (store.events[id]) {
      ev = parseEvent(store.events[id]);
    } else {
      const key = String(e.block);
      if (store.blocks[key] === undefined) store.blocks[key] = await blockTimestamp(stateRpc, e.block);
      const dt = store.tokens[e.debtAsset]!, ct = store.tokens[e.collateralAsset]!;
      ev = { ...e, timestamp: store.blocks[key]!, debtSymbol: dt.symbol, collSymbol: ct.symbol };
      try {
        const prices = await fetchPrices(stateRpc, aave.oracle, [e.debtAsset, e.collateralAsset], e.block);
        const pd = prices.get(e.debtAsset), pc = prices.get(e.collateralAsset);
        if (pd && pc) Object.assign(ev, computeEconomics(e, pd, pc, dt.decimals, ct.decimals, aave.baseUnit));
      } catch (err) {
        log(`  price lookup failed at block ${e.block}: ${redact(String(err instanceof Error ? err.message : err)).slice(0, 100)}`);
      }
      store.events[id] = JSON.parse(serializeEvent(ev));
      if (++done % 25 === 0) {
        save();
        log(`  enriched ${done} new event(s)...`);
      }
    }
    events.push(ev);
  }
  save();
  const repeatEvents = markRepeats(events, lookback);

  // ---- 3) speed sample: how long was the position liquidatable before it was liquidated? --------------
  const todo = pickSample(events.filter((e) => !e.repeatUser), sampleN);
  const toMeasure = todo.filter((e) => !e.delay);
  if (toMeasure.length) log(`Measuring speed for ${toMeasure.length} liquidation(s) (about 25 state queries each; this part needs an archive-capable RPC)...`);
  let k = 0;
  for (const e of toMeasure) {
    try {
      e.delay = await liquidatableForBlocks((b) => isLiquidatableAt(stateRpc, pool, e.user, b), e.block, lookback);
    } catch (err) {
      e.delay = { blocks: 0, censored: false, calls: 0, error: redact(String(err instanceof Error ? err.message : err)).slice(0, 120) };
    }
    store.events[eventId(e)] = JSON.parse(serializeEvent(e));
    if (++k % 5 === 0) {
      save();
      log(`  measured ${k}/${toMeasure.length}`);
    }
  }
  save();
  // sampled results come from the cache (events loaded from the cache already carry their delay)
  const delayErrors = events.filter((e) => e.delay?.error).length;
  if (delayErrors) log(`  ${delayErrors} speed measurement(s) failed (e.g. the RPC has no old state): they are reported as failed, not guessed.`);

  // ---- 4) report ---------------------------------------------------------------------------------
  const report = renderReport({
    events,
    fromBlock: from,
    toBlock: to,
    generatedAt: new Date().toISOString(),
    chunkInfo,
    lookback,
    eventsWithoutPrice: events.filter((e) => e.debtUsd === undefined).length,
    repeatEvents,
    poolAddress: pool,
  });
  const tag = `${from}-${to}`;
  const mdPath = join(outDir, `liquidations.${tag}.local.md`);
  writeFileSync(mdPath, report);
  writeFileSync(join(outDir, `liquidations.${tag}.local.json`), JSON.stringify({ from, to, events: events.map((e) => JSON.parse(serializeEvent(e))) }, null, 1));
  log("\n" + report);
  log(`Saved: ${mdPath} (and .json). The request counter of this run: ${stateRpc.requests + (logsRpc === stateRpc ? 0 : logsRpc.requests)} RPC calls, ${stateRpc.retries + (logsRpc === stateRpc ? 0 : logsRpc.retries)} retries.`);
  void hex;
}

main().catch((e) => {
  console.error(redact(String(e?.stack ?? e)));
  process.exit(1);
});
