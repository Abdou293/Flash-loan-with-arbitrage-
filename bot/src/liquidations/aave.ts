import { id, Interface } from "ethers";

/**
 * Aave V3 Pool on Arbitrum One. Written from memory; `scripts/verify-addresses.sh` checks it on-chain
 * (the pool answers ADDRESSES_PROVIDER(), the provider points back to it, the oracle answers prices).
 */
export const AAVE_POOL_ARBITRUM = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";

export const LIQUIDATION_CALL_SIG = "LiquidationCall(address,address,address,uint256,uint256,address,bool)";
export const LIQUIDATION_CALL_TOPIC = id(LIQUIDATION_CALL_SIG);

export const poolIface = new Interface([
  "event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)",
  "function ADDRESSES_PROVIDER() view returns (address)",
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
]);
export const providerIface = new Interface([
  "function getPool() view returns (address)",
  "function getPriceOracle() view returns (address)",
]);
export const oracleIface = new Interface([
  "function getAssetPrice(address asset) view returns (uint256)",
  "function BASE_CURRENCY_UNIT() view returns (uint256)",
]);
export const tokenIface = new Interface([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

/** A log as returned by eth_getLogs (hex strings). */
export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  transactionIndex?: string;
  logIndex: string;
}

export interface LiquidationEvent {
  block: number;
  txHash: string;
  txIndex: number;
  logIndex: number;
  collateralAsset: string;
  debtAsset: string;
  user: string;
  liquidator: string;
  /** debt repaid, in debt-asset units */
  debtToCover: bigint;
  /** collateral taken by the liquidator, in collateral-asset units (gross of Aave's protocol fee on the bonus) */
  collateralAmount: bigint;
  receiveAToken: boolean;
}

export const eventId = (e: { txHash: string; logIndex: number }) => `${e.txHash.toLowerCase()}:${e.logIndex}`;

export function decodeLiquidationLog(log: RawLog): LiquidationEvent {
  const parsed = poolIface.parseLog({ topics: log.topics, data: log.data });
  if (!parsed || parsed.name !== "LiquidationCall") throw new Error("not a LiquidationCall log");
  const a = parsed.args;
  return {
    block: Number(BigInt(log.blockNumber)),
    txHash: log.transactionHash,
    txIndex: log.transactionIndex ? Number(BigInt(log.transactionIndex)) : -1,
    logIndex: Number(BigInt(log.logIndex)),
    collateralAsset: (a[0] as string).toLowerCase(),
    debtAsset: (a[1] as string).toLowerCase(),
    user: (a[2] as string).toLowerCase(),
    debtToCover: a[3] as bigint,
    collateralAmount: a[4] as bigint,
    liquidator: (a[5] as string).toLowerCase(),
    receiveAToken: a[6] as boolean,
  };
}
