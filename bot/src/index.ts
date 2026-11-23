import "dotenv/config";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig, loadEnv } from "./config/load.js";
import { RpcMarket } from "./core/market/RpcMarket.js";
import { SampleMarket } from "./core/market/SampleMarket.js";
import { RiskEngine } from "./core/risk.js";
import { QuoteOnlySimulator, SampleSimulator, StaticCallSimulator } from "./core/simulator.js";
import { Store } from "./core/store.js";
import type { MarketData, Step } from "./core/types.js";
import { Engine } from "./engine.js";

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, "..");
  const env = loadEnv();
  const config = loadConfig(arg("config", join(root, "strategies.config.json")));
  const source = arg("source", "sample"); // sample | rpc
  const cycles = Number(arg("cycles", "50"));
  const seed = Number(arg("seed", "42"));
  const outDir = arg("out", join(root, "data"));

  if (!env.dryRun) {
    console.error("DRY_RUN=false is not supported in this version. Refusing to start.");
    process.exit(1);
  }

  let market: MarketData;
  if (source === "rpc") {
    if (!env.rpcUrl) throw new Error("Set ARBITRUM_RPC_URL in .env for --source rpc");
    const lookup = (a: any, b: any): Step | undefined => {
      const v = config.venues.find((x) => x.pairs.includes(`${a.symbol}/${b.symbol}`) || x.pairs.includes(`${b.symbol}/${a.symbol}`));
      return v ? { venue: v, tokenIn: a, tokenOut: b } : undefined;
    };
    market = new RpcMarket({ rpcUrl: env.rpcUrl }, config.tokens, lookup);
  } else {
    market = new SampleMarket({ seed, tokenUsd: config.tokenUsd, venues: config.venues, tokens: config.tokens });
    console.log("NOTE: using SYNTHETIC data. Results do not reflect real markets.");
  }

  const store = new Store(join(outDir, `opportunities.${source}.local.jsonl`));
  const engine = new Engine({
    config,
    market,
    simulator:
      source !== "rpc"
        ? new SampleSimulator(seed)
        : process.env.FLASH_ARB_ADDRESS && process.env.OWNER_ADDRESS
          ? new StaticCallSimulator(env.rpcUrl, process.env.FLASH_ARB_ADDRESS, process.env.OWNER_ADDRESS)
          : new QuoteOnlySimulator(),
    store,
    risk: new RiskEngine(config.risk),
    dryRun: env.dryRun,
    log: (m) => console.log(m),
  });
  console.log(`Enabled strategies: ${engine.enabledStrategies.join(", ")}`);

  for (let i = 0; i < cycles; i++) {
    await engine.runCycle();
    if (source === "rpc") await new Promise((r) => setTimeout(r, env.pollIntervalMs));
  }
  store.writeSummary(join(outDir, `stats.${source}.local.json`), {
    dataSource: market.source,
    cycles,
    seed,
    dryRun: true,
    generatedAt: new Date().toISOString(),
  });
  console.table(store.stats);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
