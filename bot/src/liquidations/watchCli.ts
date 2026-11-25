import "../config/dotenv.js";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonRpcProvider } from "ethers";
import { loadConfig } from "../config/load.js";
import { AAVE_POOL_ARBITRUM } from "./aave.js";
import { fetchPrices, resolveAave } from "./enrich.js";
import { scanLogs, type ScanState } from "./logs.js";
import { redact, ThrottledRpc, num } from "./rpc.js";
import { safeHead } from "./sample.js";
import { BORROW_SIG, borrowerFromLog, DEFAULT_THRESHOLDS, resolveDataProvider } from "./watch.js";
import { formatCycle, runCycle } from "./watchRun.js";
import { id } from "ethers";

/**
 * Aave V3 borrower health monitor, DRY-RUN ONLY. Reads the chain, never sends a transaction (no wallet is loaded).
 *
 *   npm run liq-watch -- --users 0xabc...,0xdef...                 # watch specific accounts, one pass
 *   npm run liq-watch -- --discover-blocks 20000 --once            # find recent borrowers from Borrow events, one pass
 *   npm run liq-watch -- --discover-blocks 20000 --interval-s 30   # keep watching (Ctrl+C to stop)
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
const readJson = <T>(p: string, fb: T): T => {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return fb;
  }
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main() {
  if (flag("help") || flag("h")) {
    log(
      [
        "Usage: npm run liq-watch -- [options]   (DRY-RUN ONLY: nothing is ever signed or sent)",
        "  --users A,B,C          watch these accounts",
        "  --users-file FILE      one address per line",
        "  --discover-blocks N    add borrowers seen in Aave Borrow events of the last N blocks (cached; adds to the list)",
        "  --once                 one pass, then exit (default when no --interval-s)",
        "  --interval-s S         repeat every S seconds (minimum 5)",
        "  --cycles N             stop after N passes",
        "  --at-risk X --watch Y  health-factor bands (defaults 1.02 and 1.10)",
        "  --bonus-pct P          assumed liquidation bonus for the estimate (default 5)",
        "  --config FILE          bot config (default strategies.config.json) - same risk limits and lenders as the arbitrage bot",
        "  --logs-rpc-url URL     RPC for eth_getLogs only (or ARBITRUM_LOGS_RPC_URL)",
        "  --interval-ms N        minimum delay between RPC requests (default 250)",
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
  const rpc = mk(stateUrl);
  const logsRpc = logsUrl === stateUrl ? rpc : mk(logsUrl);

  const chainId = num(await rpc.request("eth_chainId", []));
  if (chainId !== 42161) throw new Error(`chain id is ${chainId}, expected 42161 (Arbitrum One)`);
  const cfg = loadConfig(join(root, arg("config", "strategies.config.json")!));
  const thresholds = { atRisk: Number(arg("at-risk", String(DEFAULT_THRESHOLDS.atRisk))), watch: Number(arg("watch", String(DEFAULT_THRESHOLDS.watch))) };
  const bonusPct = Number(arg("bonus-pct", "5"));

  const cacheDir = join(root, "data", "liquidations");
  mkdirSync(cacheDir, { recursive: true });
  const files = {
    borrowers: join(cacheDir, `watch-borrowers.${chainId}.json`),
    scan: join(cacheDir, `watch-borrow-scan.${chainId}.json`),
    history: join(cacheDir, `watch-history.${chainId}.jsonl`),
    latest: join(cacheDir, `watch-latest.${chainId}.json`),
  };

  const aave = await resolveAave(rpc, AAVE_POOL_ARBITRUM);
  let dataProvider: string | undefined;
  try {
    dataProvider = await resolveDataProvider(rpc, aave.provider);
  } catch (e) {
    log(`(asset/lender lookup disabled: ${redact(e instanceof Error ? e.message : String(e))})`);
  }
  log(`Aave V3 pool ${aave.pool}, oracle ${aave.oracle}. DRY-RUN ONLY: this tool has no wallet and sends nothing.`);

  // ---- borrower list ----------------------------------------------------------------------------
  const users = new Set<string>(readJson<string[]>(files.borrowers, []));
  for (const u of (arg("users") ?? "").split(",").map((x) => x.trim()).filter(Boolean)) users.add(u.toLowerCase());
  const uf = arg("users-file");
  if (uf) for (const l of readFileSync(uf, "utf8").split("\n")) if (/^0x[0-9a-fA-F]{40}$/.test(l.trim())) users.add(l.trim().toLowerCase());

  const discover = Number(arg("discover-blocks", "0"));
  if (discover > 0) {
    const logsLatest = logsRpc === rpc ? num(await rpc.request("eth_blockNumber", [])) : num(await logsRpc.request("eth_blockNumber", []));
    const to = safeHead([num(await rpc.request("eth_blockNumber", [])), logsLatest]);
    const from = Math.max(1, to - discover);
    const state = readJson<ScanState>(files.scan, { done: [] });
    log(`Looking for borrowers in blocks ${from}-${to} (Borrow events)...`);
    const stats = await scanLogs({
      rpc: logsRpc,
      address: aave.pool,
      topic0: id(BORROW_SIG),
      from,
      to,
      state,
      chunk: { start: 5000, min: 1, max: 50_000 },
      onLogs: (logs) => {
        for (const l of logs) {
          const u = borrowerFromLog(l);
          if (u) users.add(u);
        }
      },
      onChunkDone: (s) => {
        atomicWrite(files.scan, JSON.stringify(s));
        atomicWrite(files.borrowers, JSON.stringify([...users]));
      },
    });
    log(`  ${stats.requests} getLogs requests, ${stats.logs} Borrow events. Borrowers known: ${users.size}`);
  }
  if (users.size === 0) throw new Error("No accounts to watch: pass --users, --users-file or --discover-blocks N");
  const list = [...users];

  // ---- cycles ----------------------------------------------------------------------------------
  const intervalS = arg("interval-s") ? Math.max(5, Number(arg("interval-s"))) : 0;
  const maxCycles = arg("cycles") ? Number(arg("cycles")) : intervalS ? Infinity : 1;
  for (let i = 0; i < maxCycles; i++) {
    const gasHex = (await rpc.request("eth_gasPrice", [])) as string;
    const gasPriceGwei = Number(BigInt(gasHex)) / 1e9;
    const weth = cfg.tokens["WETH"]!.address;
    const price = (await fetchPrices(rpc, aave.oracle, [weth], num(await rpc.request("eth_blockNumber", [])))).get(weth);
    const ethUsd = price ? Number(price) / Number(aave.baseUnit) : cfg.tokenUsd["WETH"]!;
    const res = await runCycle(rpc, { pool: aave.pool, baseUnit: aave.baseUnit, dataProvider, cfg, thresholds, assumptions: { bonusPct, gasPriceGwei, ethUsd } }, list);
    log(`\n[${res.timestamp}] gas ${gasPriceGwei.toFixed(4)} gwei, ETH $${ethUsd.toFixed(0)}\n${formatCycle(res)}`);
    appendFileSync(files.history, JSON.stringify({ ...res, rows: res.rows.slice(0, 50) }) + "\n");
    atomicWrite(files.latest, JSON.stringify({ ...res, source: "liq-watch", assumptions: { bonusPct, note: "estimates use a flat bonus and ignore swap costs" } }, null, 2));
    if (i + 1 < maxCycles) await sleep(intervalS * 1000);
  }
  log("\nDone. This was a DRY RUN: nothing was signed or sent. Estimates use a flat assumed bonus and ignore swap costs and competition (see the liquidation reports: profitable ones are taken within the same block).");
}

main().catch((e) => {
  console.error("ERROR:", redact(e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
