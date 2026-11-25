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

/**
 * ethers wraps provider errors ("could not coalesce error (error={...}, payload=...)"): prefer the provider's own
 * message when it is there, otherwise gather whatever text the error carries.
 */
/** HTTP errors carry the provider's JSON-RPC error as a JSON string: pull its message out. */
function messageFromBody(body: unknown): string | undefined {
  if (typeof body !== "string") return undefined;
  try {
    const j = JSON.parse(body);
    const m = Array.isArray(j) ? j[0]?.error?.message : j?.error?.message;
    return typeof m === "string" ? m : undefined;
  } catch {
    return undefined;
  }
}

export function errorText(e: unknown): string {
  const x = e as any;
  const inner = [x?.error?.message, x?.info?.error?.message, messageFromBody(x?.info?.responseBody)].find(
    (p) => typeof p === "string" && p.length > 0,
  );
  if (inner) return inner;
  const parts = [x?.message, x?.info?.responseBody, x?.shortMessage].filter((p): p is string => typeof p === "string" && p.length > 0);
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
