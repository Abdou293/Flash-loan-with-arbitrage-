/** Minimal JSON-RPC surface used by the liquidation tools. Anything with `send` (an ethers provider) fits. */
export interface Rpc {
  request(method: string, params: unknown[]): Promise<any>;
}
export interface SendLike {
  send(method: string, params: unknown[]): Promise<any>;
}

/** Remove API keys from any text before it is printed or saved. */
export const redact = (s: string) =>
  s.replace(/(\/v2\/)[^\s"'?&)]+/g, "$1***").replace(/(api[_-]?key=)[^\s"'&)]+/gi, "$1***");

/** ethers hides the provider's real message in nested fields: gather all of them. */
export function errorText(e: unknown): string {
  const x = e as any;
  const parts = [x?.message, x?.error?.message, x?.info?.responseBody, x?.info?.error?.message, x?.shortMessage]
    .filter((p): p is string => typeof p === "string" && p.length > 0);
  return [...new Set(parts)].join(" | ") || String(e);
}

const TRANSIENT = /429|too many requests|rate.?limit|compute units|throughput|timeout|timed out|etimedout|econnreset|socket hang up|\b50[234]\b|bad gateway|service unavailable/i;
export const isTransient = (msg: string) => TRANSIENT.test(msg);

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface ThrottleOptions {
  /** minimum delay between two requests (free-tier friendly) */
  minIntervalMs: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Spaces requests out and retries rate-limit/timeout errors with backoff. Other errors are thrown (redacted). */
export class ThrottledRpc implements Rpc {
  private last = 0;
  requests = 0;
  retries = 0;

  constructor(private readonly p: SendLike, private readonly o: ThrottleOptions) {}

  async request(method: string, params: unknown[]): Promise<any> {
    const sleep = this.o.sleep ?? defaultSleep;
    const now = this.o.now ?? Date.now;
    const maxRetries = this.o.maxRetries ?? 6;
    for (let attempt = 0; ; attempt++) {
      const wait = this.o.minIntervalMs - (now() - this.last);
      if (wait > 0) await sleep(wait);
      this.last = now();
      this.requests++;
      try {
        return await this.p.send(method, params);
      } catch (e) {
        const msg = redact(errorText(e));
        if (attempt < maxRetries && isTransient(msg)) {
          this.retries++;
          await sleep(Math.min(30_000, 500 * 2 ** attempt));
          continue;
        }
        throw new Error(msg);
      }
    }
  }
}

export const hex = (n: number | bigint) => "0x" + BigInt(n).toString(16);
export const num = (h: string) => Number(BigInt(h));
