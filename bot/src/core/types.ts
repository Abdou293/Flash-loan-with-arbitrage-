export interface Token {
  symbol: string;
  address: string;
  decimals: number;
}

export type VenueKind = "uniV3" | "uniV2";

export interface Venue {
  id: string;
  dex: string; // "uniswap" | "sushiswap" | ...
  kind: VenueKind;
  fee: number; // fee in hundredths of a bip: 500 = 0.05%, 3000 = 0.30%
  router: string;
  liquidityUsd: number; // used by the synthetic market only
  pairs: string[]; // "A/B" pairs traded on this venue
}

export interface Step {
  venue: Venue;
  tokenIn: Token;
  tokenOut: Token;
}
export type Route = Step[];

export interface NewPool {
  base: Token;
  newToken: Token;
  venues: Venue[]; // venues where the new token trades against `base`
  ageMinutes: number;
  liquidityUsd: number;
  sellable: boolean; // result of a sell-simulation (honeypot check)
  taxBps: number; // transfer/sell tax detected
}

/** Everything the bot knows about the outside world. Implementations: synthetic sample data, or RPC. */
export interface MarketData {
  readonly source: "synthetic" | "rpc";
  /** Start a new scan cycle (refresh caches / snapshot). */
  advance(): Promise<void>;
  /** Amount out for a single swap step. Returns 0n when the pool has no liquidity / cannot be quoted. */
  quote(step: Step, amountIn: bigint): Promise<bigint>;
  usdPrice(token: Token): Promise<number>;
  gasPriceGwei(): Promise<number>;
  getNewPools(): Promise<NewPool[]>;
}

export interface GlobalConfig {
  flashLoanFeeBps: number;
  slippageBps: number;
  baseGasUnits: number;
  perStepGasUnits: number;
  tradeSizesUsd: number[];
}

export interface RiskConfig {
  minNetProfitUsd: number;
  maxGasPriceGwei: number;
  maxConsecutiveFailures: number;
  maxTradeSizeUsd: number;
}

export interface ProfitBreakdown {
  gross: bigint; // amountOut - amountIn (borrowed token units)
  flashLoanFee: bigint;
  slippageReserve: bigint;
  gasCost: bigint;
  net: bigint;
  netUsd: number;
  grossUsd: number;
  flashLoanFeeUsd: number;
  slippageReserveUsd: number;
  gasCostUsd: number;
  gasUnits: number;
}

export interface Candidate {
  strategy: string;
  route: Route;
  borrowToken: Token;
  amountIn: bigint;
  amountInUsd: number;
  amountOut: bigint;
  profit: ProfitBreakdown;
}

export type OpportunityStatus =
  | "unprofitable"
  | "rejected_risk"
  | "simulated_ok"
  | "simulated_revert"
  | "skipped_paused";

export interface Opportunity {
  id: string;
  cycle: number;
  timestamp: string;
  strategy: string;
  route: string;
  borrowToken: string;
  amountInUsd: number;
  grossProfitUsd: number;
  flashLoanFeeUsd: number;
  slippageReserveUsd: number;
  gasCostUsd: number;
  netProfitUsd: number;
  status: OpportunityStatus;
  reason?: string;
  dataSource: "synthetic" | "rpc";
}
