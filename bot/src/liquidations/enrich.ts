import { AbiCoder } from "ethers";
import { MULTICALL3, mcIface } from "../monitor/reader.js";
import { oracleIface, poolIface, providerIface, tokenIface, type LiquidationEvent } from "./aave.js";
import { hex, type Rpc } from "./rpc.js";

export interface Call {
  target: string;
  callData: string;
}

export async function ethCall(rpc: Rpc, to: string, data: string, blockTag: string | number = "latest"): Promise<string> {
  return rpc.request("eth_call", [{ to, data }, typeof blockTag === "number" ? hex(blockTag) : blockTag]);
}

/** Batch many reads into ONE eth_call at one block. Failures are returned, not thrown. */
export async function multicall(rpc: Rpc, calls: Call[], blockTag: string | number = "latest") {
  const data = mcIface.encodeFunctionData("aggregate3", [calls.map((c) => ({ ...c, allowFailure: true }))]);
  const raw = await ethCall(rpc, MULTICALL3, data, blockTag);
  const [res] = mcIface.decodeFunctionResult("aggregate3", raw);
  return (res as any[]).map((r) => ({ success: r[0] as boolean, returnData: r[1] as string }));
}

export interface AaveContext {
  pool: string;
  provider: string;
  oracle: string;
  /** price scale of the oracle (1e8 = USD with 8 decimals on Aave V3) */
  baseUnit: bigint;
}

/** Resolve the provider and price oracle from the pool itself: no oracle address is hard-coded. */
export async function resolveAave(rpc: Rpc, pool: string): Promise<AaveContext> {
  const provider = poolIface.decodeFunctionResult(
    "ADDRESSES_PROVIDER",
    await ethCall(rpc, pool, poolIface.encodeFunctionData("ADDRESSES_PROVIDER")),
  )[0] as string;
  const back = providerIface.decodeFunctionResult("getPool", await ethCall(rpc, provider, providerIface.encodeFunctionData("getPool")))[0] as string;
  if (back.toLowerCase() !== pool.toLowerCase()) {
    throw new Error(`Address check failed: provider ${provider} points to pool ${back}, not ${pool}`);
  }
  const oracle = providerIface.decodeFunctionResult(
    "getPriceOracle",
    await ethCall(rpc, provider, providerIface.encodeFunctionData("getPriceOracle")),
  )[0] as string;
  const baseUnit = oracleIface.decodeFunctionResult(
    "BASE_CURRENCY_UNIT",
    await ethCall(rpc, oracle, oracleIface.encodeFunctionData("BASE_CURRENCY_UNIT")),
  )[0] as bigint;
  return { pool, provider, oracle, baseUnit };
}

export interface TokenMeta {
  symbol: string;
  decimals: number;
}

function decodeSymbol(returnData: string, address: string): string {
  try {
    return tokenIface.decodeFunctionResult("symbol", returnData)[0] as string;
  } catch {
    try {
      // some old tokens (e.g. MKR) return bytes32
      const raw = AbiCoder.defaultAbiCoder().decode(["bytes32"], returnData)[0] as string;
      const s = Buffer.from(raw.slice(2), "hex").toString("utf8").replace(/\0+$/g, "");
      if (s) return s;
    } catch {
      /* fall through */
    }
    return address.slice(0, 8);
  }
}

export async function fetchTokenMeta(rpc: Rpc, assets: string[]): Promise<Record<string, TokenMeta>> {
  const out: Record<string, TokenMeta> = {};
  if (!assets.length) return out;
  const calls: Call[] = assets.flatMap((a) => [
    { target: a, callData: tokenIface.encodeFunctionData("symbol") },
    { target: a, callData: tokenIface.encodeFunctionData("decimals") },
  ]);
  const res = await multicall(rpc, calls);
  assets.forEach((a, i) => {
    const s = res[2 * i]!, d = res[2 * i + 1]!;
    out[a] = {
      symbol: s.success ? decodeSymbol(s.returnData, a) : a.slice(0, 8),
      decimals: d.success ? Number(tokenIface.decodeFunctionResult("decimals", d.returnData)[0]) : 18,
    };
  });
  return out;
}

/** Oracle price of each asset AT THE BLOCK OF THE EVENT. Missing price (oracle did not exist yet) => absent. */
export async function fetchPrices(rpc: Rpc, oracle: string, assets: string[], block: number): Promise<Map<string, bigint>> {
  const unique = [...new Set(assets)];
  const res = await multicall(
    rpc,
    unique.map((a) => ({ target: oracle, callData: oracleIface.encodeFunctionData("getAssetPrice", [a]) })),
    block,
  );
  const out = new Map<string, bigint>();
  unique.forEach((a, i) => {
    const r = res[i]!;
    if (!r.success) return;
    const p = oracleIface.decodeFunctionResult("getAssetPrice", r.returnData)[0] as bigint;
    if (p > 0n) out.set(a, p);
  });
  return out;
}

export interface Economics {
  debtUsd: number;
  collUsd: number;
  /** collateral value / debt value - 1, measured at oracle prices (gross of Aave's protocol fee on the bonus) */
  bonusPct: number;
  /** collateral value - debt value, in USD: what a liquidator earns BEFORE swap costs, gas and flash-loan fees */
  grossBonusUsd: number;
}

const toUnits = (amount: bigint, decimals: number) => Number(amount) / 10 ** decimals;

export function computeEconomics(
  e: Pick<LiquidationEvent, "debtToCover" | "collateralAmount">,
  priceDebt: bigint, priceColl: bigint, decDebt: number, decColl: number, baseUnit: bigint,
): Economics {
  const unit = Number(baseUnit);
  const debtUsd = (toUnits(e.debtToCover, decDebt) * Number(priceDebt)) / unit;
  const collUsd = (toUnits(e.collateralAmount, decColl) * Number(priceColl)) / unit;
  return { debtUsd, collUsd, bonusPct: debtUsd > 0 ? (collUsd / debtUsd - 1) * 100 : 0, grossBonusUsd: collUsd - debtUsd };
}

/** Health factor and debt of a borrower at the END of `block`. */
export async function accountAt(rpc: Rpc, pool: string, user: string, block: number) {
  const raw = await ethCall(rpc, pool, poolIface.encodeFunctionData("getUserAccountData", [user]), block);
  const r = poolIface.decodeFunctionResult("getUserAccountData", raw);
  return { debtBase: r[1] as bigint, healthFactor: r[5] as bigint };
}

const ONE = 10n ** 18n;
/** Liquidatable = has debt and health factor below 1.0. */
export async function isLiquidatableAt(rpc: Rpc, pool: string, user: string, block: number): Promise<boolean> {
  const a = await accountAt(rpc, pool, user, block);
  return a.debtBase > 0n && a.healthFactor < ONE;
}

export async function blockTimestamp(rpc: Rpc, block: number): Promise<number> {
  const b = await rpc.request("eth_getBlockByNumber", [hex(block), false]);
  if (!b?.timestamp) throw new Error(`block ${block} not found`);
  return Number(BigInt(b.timestamp));
}
