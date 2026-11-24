import { readFileSync } from "node:fs";
import type { GlobalConfig, RiskConfig, Token, Venue } from "../core/types.js";

export interface FlashLoanConfig {
  provider: string;
  vault: string;
  /** Token symbols the lender can actually supply. Routes starting with any other token are skipped. */
  borrowable: string[];
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
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const tokens: Record<string, Token> = {};
  const tokenUsd: Record<string, number> = {};
  for (const [symbol, t] of Object.entries<any>(raw.tokens)) {
    tokens[symbol] = { symbol, address: t.address, decimals: t.decimals };
    tokenUsd[symbol] = t.usd;
  }
  for (const v of raw.venues as Venue[])
    for (const p of v.pairs) for (const s of p.split("/")) if (!tokens[s]) throw new Error(`venue ${v.id}: unknown token ${s}`);
  if (!tokens["WETH"]) throw new Error("config must define WETH (used to price gas)");
  const flashLoan: FlashLoanConfig = raw.flashLoan ?? { provider: "none", vault: "", borrowable: Object.keys(tokens) };
  for (const s of flashLoan.borrowable) if (!tokens[s]) throw new Error(`flashLoan.borrowable: unknown token ${s}`);
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
