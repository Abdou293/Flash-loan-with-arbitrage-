import { formatUnits, parseUnits } from "ethers";
import type { Token } from "./types.js";

export function toHuman(amount: bigint, token: Token): number {
  return Number(formatUnits(amount, token.decimals));
}

export function fromHuman(x: number, token: Token): bigint {
  if (!Number.isFinite(x) || x <= 0) return 0n;
  const digits = Math.min(token.decimals, 12);
  return parseUnits(x.toFixed(digits), token.decimals);
}
