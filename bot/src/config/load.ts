import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GlobalConfig, RiskConfig, Token, Venue } from "../core/types.js";

export interface LenderConfig {
  provider: "balancerV2" | "uniswapV4";
  address: string;
  /** Token symbols this lender can actually supply (check on-chain balances). */
  borrowable: string[];
}

export interface FlashLoanConfig {
  lenders: LenderConfig[];
  /** Union of all lenders' borrowable tokens. Routes starting with any other token are skipped. */
  borrowable: string[];
}

/** First lender that can supply `symbol` (lenders are listed in order of preference). */
export function lenderFor(cfg: FlashLoanConfig, symbol: string): LenderConfig | undefined {
  return cfg.lenders.find((l) => l.borrowable.includes(symbol));
}

export interface BotConfig {
  global: GlobalConfig;
  flashLoan: FlashLoanConfig;
  risk: RiskConfig;
  tokens: Record<string, Token>;
  tokenUsd: Record<string, number>;
  venues: Venue[];
  strategies: Record<string, { enabled: boolean; [k: string]: unknown }>;
}

export function loadConfig(path: string): BotConfig {
  let raw = JSON.parse(readFileSync(path, "utf8"));
  if (raw.extends) {
    // "extends": tokens are merged, venues appended, everything else inherited unless overridden
    const base = JSON.parse(readFileSync(join(dirname(path), raw.extends), "utf8"));
    raw = {
      ...base,
      ...raw,
      tokens: { ...base.tokens, ...raw.tokens },
      venues: [...base.venues, ...(raw.venues ?? [])],
      flashLoan: raw.flashLoan ?? base.flashLoan,
      strategies: raw.strategies ?? base.strategies,
    };
  }
  const tokens: Record<string, Token> = {};
  const tokenUsd: Record<string, number> = {};
  for (const [symbol, t] of Object.entries<any>(raw.tokens)) {
    tokens[symbol] = { symbol, address: t.address, decimals: t.decimals };
    tokenUsd[symbol] = t.usd;
  }
  for (const v of raw.venues as Venue[])
    for (const p of v.pairs) for (const s of p.split("/")) if (!tokens[s]) throw new Error(`venue ${v.id}: unknown token ${s}`);
  if (!tokens["WETH"]) throw new Error("config must define WETH (used to price gas)");
  const lenders: LenderConfig[] = raw.flashLoan?.lenders ?? [];
  const borrowable = [...new Set(lenders.flatMap((l) => l.borrowable))];
  for (const s of borrowable) if (!tokens[s]) throw new Error(`flashLoan: unknown borrowable token ${s}`);
  const flashLoan: FlashLoanConfig = { lenders, borrowable };
  return { global: raw.global, flashLoan, risk: raw.risk, tokens, tokenUsd, venues: raw.venues, strategies: raw.strategies };
}

export interface EnvConfig {
  dryRun: boolean;
  pollIntervalMs: number;
  rpcUrl: string;
}

/** Reads ONLY the variables the dry-run needs. PRIVATE_KEY is deliberately never read here. */
export function loadEnv(env: NodeJS.ProcessEnv = process.env): EnvConfig {
  return {
    dryRun: (env.DRY_RUN ?? "true").toLowerCase() !== "false",
    pollIntervalMs: Number(env.POLL_INTERVAL_MS ?? 15000),
    rpcUrl: env.ARBITRUM_RPC_URL ?? "",
  };
}
