import { Interface, JsonRpcProvider } from "ethers";
import { hashString, mulberry32 } from "./rng.js";
import type { Candidate } from "./types.js";

export interface SimResult {
  ok: boolean;
  reason?: string;
}

/** Pre-send simulation. Implementations must NEVER broadcast a transaction. */
export interface Simulator {
  simulate(c: Candidate, cycle: number): Promise<SimResult>;
}

/**
 * Synthetic simulator for sample mode: passes when the estimate is profitable, but fails ~`failRate`
 * of the time (deterministic from the seed) so the risk engine's auto-pause logic gets exercised.
 */
export class SampleSimulator implements Simulator {
  constructor(private readonly seed: number, private readonly failRate = 0.05) {}

  async simulate(c: Candidate, cycle: number): Promise<SimResult> {
    const r = mulberry32(hashString(`${this.seed}|sim|${cycle}|${c.strategy}|${c.amountInUsd}`))();
    if (r < this.failRate) return { ok: false, reason: "synthetic revert (state changed before inclusion)" };
    return { ok: true };
  }
}

/** Used when no contract is deployed yet: nothing is simulated on-chain; the reason says so explicitly. */
export class QuoteOnlySimulator implements Simulator {
  async simulate(): Promise<SimResult> {
    return { ok: true, reason: "quote-only: no on-chain simulation (FlashArb contract not configured)" };
  }
}

const EXECUTE_ABI = [
  "function execute(uint8 lender,address asset,uint256 amount,(uint8 dex,address router,address tokenOut,uint24 fee)[] steps,uint256 minProfit)",
];
/** FlashArb.Lender enum values */
export const LENDER_ID = { balancerV2: 0, uniswapV4: 1 } as const;

/**
 * Real simulation: eth_call (static call) of FlashArb.execute from the owner's ADDRESS (no private key
 * is needed or read). Requires a deployed contract (Phase 5). Not covered by automated tests.
 */
export class StaticCallSimulator implements Simulator {
  private iface = new Interface(EXECUTE_ABI);
  private provider: JsonRpcProvider;

  constructor(
    rpcUrl: string,
    private readonly contract: string,
    private readonly ownerAddress: string,
    private readonly pickLender: (symbol: string) => keyof typeof LENDER_ID | undefined,
  ) {
    this.provider = new JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });
  }

  async simulate(c: Candidate): Promise<SimResult> {
    const steps = c.route.map((s) => [s.venue.kind === "uniV3" ? 0 : 1, s.venue.router, s.tokenOut.address, s.venue.fee]);
    const minProfit = c.profit.net > 0n ? c.profit.net / 2n : 0n;
    const lender = this.pickLender(c.borrowToken.symbol);
    if (!lender) return { ok: false, reason: `no zero-interest lender for ${c.borrowToken.symbol}` };
    const data = this.iface.encodeFunctionData("execute", [LENDER_ID[lender], c.borrowToken.address, c.amountIn, steps, minProfit]);
    try {
      await this.provider.call({ from: this.ownerAddress, to: this.contract, data });
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message.slice(0, 200) : "revert" };
    }
  }
}
