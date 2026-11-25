import { Interface } from "ethers";
import { lenderFor, type BotConfig } from "../config/load.js";
import { poolIface } from "./aave.js";
import { multicall, type Call } from "./enrich.js";
import type { Rpc } from "./rpc.js";

/**
 * Borrower health monitor for Aave V3 (module 2: Liquidation Bot). READ-ONLY and DRY-RUN ONLY.
 * There is no wallet, no signer and no transaction sending anywhere in this file or in watchCli.ts: the monitor
 * only reads the chain (eth_call through Multicall3) and decides what it WOULD do.
 */

const ONE = 10n ** 18n;
const NO_DEBT = 2n ** 255n; // Aave returns max uint256 when a user has no debt

export interface AccountHealth {
  user: string;
  totalCollateralUsd: number;
  totalDebtUsd: number;
  /** health factor as a plain number; Infinity when the user has no debt */
  hf: number;
}

export type Band = "liquidatable" | "at_risk" | "watch" | "healthy" | "no_debt";

export interface Thresholds {
  /** hf below this (but >= 1) is "at risk": worth polling fast */
  atRisk: number;
  /** hf below this is "watch" */
  watch: number;
}
export const DEFAULT_THRESHOLDS: Thresholds = { atRisk: 1.02, watch: 1.1 };

export function classify(a: AccountHealth, t: Thresholds = DEFAULT_THRESHOLDS): Band {
  if (a.totalDebtUsd <= 0) return "no_debt";
  if (a.hf < 1) return "liquidatable";
  if (a.hf < t.atRisk) return "at_risk";
  if (a.hf < t.watch) return "watch";
  return "healthy";
}

/** One eth_call per `batch` users (Multicall3). Users whose call failed are omitted (and counted by the caller). */
export async function readAccounts(
  rpc: Rpc,
  pool: string,
  baseUnit: bigint,
  users: string[],
  opts: { batch?: number; blockTag?: string | number } = {},
): Promise<{ accounts: AccountHealth[]; failed: number }> {
  const batch = opts.batch ?? 100;
  const accounts: AccountHealth[] = [];
  let failed = 0;
  for (let i = 0; i < users.length; i += batch) {
    const chunk = users.slice(i, i + batch);
    const calls: Call[] = chunk.map((u) => ({ target: pool, callData: poolIface.encodeFunctionData("getUserAccountData", [u]) }));
    const res = await multicall(rpc, calls, opts.blockTag ?? "latest");
    chunk.forEach((user, j) => {
      const r = res[j]!;
      if (!r.success) {
        failed++;
        return;
      }
      const d = poolIface.decodeFunctionResult("getUserAccountData", r.returnData);
      const unit = Number(baseUnit);
      const debtBase = d[1] as bigint;
      const hfRaw = d[5] as bigint;
      accounts.push({
        user: user.toLowerCase(),
        totalCollateralUsd: Number(d[0] as bigint) / unit,
        totalDebtUsd: Number(debtBase) / unit,
        hf: debtBase === 0n || hfRaw >= NO_DEBT ? Infinity : Number(hfRaw) / Number(ONE),
      });
    });
  }
  return { accounts, failed };
}

// ---------------------------------------------------------------- what we would do

export interface Assumptions {
  /** Aave's liquidation bonus is per collateral asset (about 4.5%-6.3% on Arbitrum). One flat number is an ESTIMATE. */
  bonusPct: number;
  /** gas price in gwei and ETH price in USD: read from the chain by the CLI */
  gasPriceGwei: number;
  ethUsd: number;
}

export interface Estimate {
  /** Aave closes 50% of the debt when 0.95 <= hf < 1, and 100% below 0.95 */
  closeFactor: number;
  coverUsd: number;
  grossBonusUsd: number;
  gasUsd: number;
  /** gross bonus - gas. Swap costs are NOT included: a real trade would earn less. */
  netUsd: number;
  decision: "would_attempt" | "rejected";
  reason?: string;
}

/**
 * Same risk limits as the arbitrage bot (strategies.config.json -> risk) applied to a liquidation candidate:
 * minimum net profit, maximum gas price, maximum trade size. The flash loan itself costs nothing (zero-interest
 * lenders only), so no loan fee is subtracted.
 */
export function estimate(a: AccountHealth, cfg: BotConfig, as: Assumptions): Estimate {
  const closeFactor = a.hf < 0.95 ? 1 : 0.5;
  const rawCover = a.totalDebtUsd * closeFactor;
  const coverUsd = Math.min(rawCover, cfg.risk.maxTradeSizeUsd);
  const grossBonusUsd = (coverUsd * as.bonusPct) / 100;
  const gasUnits = cfg.global.baseGasUnits + cfg.global.perStepGasUnits; // loan + liquidation + one swap
  const gasUsd = gasUnits * as.gasPriceGwei * 1e-9 * as.ethUsd;
  const netUsd = grossBonusUsd - gasUsd;
  const base = { closeFactor, coverUsd, grossBonusUsd, gasUsd, netUsd };
  if (a.hf >= 1) return { ...base, decision: "rejected", reason: "not liquidatable (health factor >= 1)" };
  if (as.gasPriceGwei > cfg.risk.maxGasPriceGwei)
    return { ...base, decision: "rejected", reason: `gas ${as.gasPriceGwei.toFixed(3)} gwei > max ${cfg.risk.maxGasPriceGwei}` };
  if (netUsd < cfg.risk.minNetProfitUsd)
    return { ...base, decision: "rejected", reason: `net $${netUsd.toFixed(2)} < min $${cfg.risk.minNetProfitUsd}` };
  return { ...base, decision: "would_attempt" };
}

// ---------------------------------------------------------------- which assets (for the lender check)

const dataProviderIface = new Interface([
  "function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)",
]);
const providerIface2 = new Interface(["function getPoolDataProvider() view returns (address)"]);

export interface PositionAssets {
  debtSymbol?: string;
  collateralSymbol?: string;
  /** which zero-interest lender could fund the debt asset (from strategies.config.json), if any */
  lender?: string;
}

/** The pool data provider is read from the PoolAddressesProvider: no address is hard-coded. */
export async function resolveDataProvider(rpc: Rpc, provider: string): Promise<string> {
  const raw = await rpc.request("eth_call", [{ to: provider, data: providerIface2.encodeFunctionData("getPoolDataProvider") }, "latest"]);
  return providerIface2.decodeFunctionResult("getPoolDataProvider", raw)[0] as string;
}

/**
 * Biggest debt and biggest collateral among the tokens in our config (WETH, USDC, ...). Positions held in other
 * assets are reported as unknown: the bot can only trade what its config and lenders know about.
 */
export async function findAssets(rpc: Rpc, dataProvider: string, cfg: BotConfig, user: string): Promise<PositionAssets> {
  const symbols = Object.keys(cfg.tokens);
  const calls: Call[] = symbols.map((s) => ({
    target: dataProvider,
    callData: dataProviderIface.encodeFunctionData("getUserReserveData", [cfg.tokens[s]!.address, user]),
  }));
  const res = await multicall(rpc, calls);
  let bestDebt = 0, bestColl = 0;
  const out: PositionAssets = {};
  symbols.forEach((s, i) => {
    const r = res[i]!;
    if (!r.success) return;
    const d = dataProviderIface.decodeFunctionResult("getUserReserveData", r.returnData);
    const t = cfg.tokens[s]!;
    const usd = cfg.tokenUsd[s] ?? 0;
    const debtUsd = (Number((d[1] as bigint) + (d[2] as bigint)) / 10 ** t.decimals) * usd;
    const collUsd = d[8] ? (Number(d[0] as bigint) / 10 ** t.decimals) * usd : 0;
    if (debtUsd > bestDebt) ((bestDebt = debtUsd), (out.debtSymbol = s));
    if (collUsd > bestColl) ((bestColl = collUsd), (out.collateralSymbol = s));
  });
  if (out.debtSymbol) out.lender = lenderFor(cfg.flashLoan, out.debtSymbol)?.provider;
  return out;
}

// ---------------------------------------------------------------- finding borrowers

export const BORROW_SIG = "Borrow(address,address,address,uint256,uint8,uint256,uint16)";
/** `onBehalfOf` (the account that owns the debt) is the 2nd indexed topic of Aave's Borrow event. */
export function borrowerFromLog(log: { topics: string[] }): string | undefined {
  const t = log.topics[2];
  return t ? ("0x" + t.slice(26)).toLowerCase() : undefined;
}
