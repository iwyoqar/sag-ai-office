// Reliability for connector calls: error classification, bounded retries (reads only), per-call timeouts and a
// per-instance rate limit. Writes are never retried here: an approved write runs once, and if its outcome cannot be
// known (timeout, network) it is recorded as "unknown" for a person to check (connectors/hub.ts decide()).
import { ZodError } from "zod";
import { ConnectorError } from "./google.js";

export type ErrorClass = "auth" | "permission" | "not_found" | "rate_limited" | "timeout" | "network" | "provider" | "validation" | "config";

export interface Classified { cls: ErrorClass; retryable: boolean; message: string }

export function classify(e: unknown): Classified {
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof ZodError) return { cls: "validation", retryable: false, message };
  const name = (e as { name?: string })?.name;
  if (name === "TimeoutError" || name === "AbortError") return { cls: "timeout", retryable: true, message: "connector call timed out" };
  if (e instanceof ConnectorError) {
    const s = e.status;
    if (s === 401) return { cls: "auth", retryable: false, message };
    if (s === 403) return { cls: "permission", retryable: false, message };
    if (s === 404) return { cls: "not_found", retryable: false, message };
    if (s === 429) return { cls: "rate_limited", retryable: true, message };
    if (s === 408 || s >= 500) return { cls: "provider", retryable: true, message };
    if (s === 0) return { cls: /sozlanmagan|configured|mavjud emas|ishlamayapti/i.test(message) ? "config" : "provider", retryable: false, message };
    return { cls: "provider", retryable: false, message };
  }
  if (e instanceof TypeError && /fetch|network|ECONN|ENOTFOUND|socket/i.test(message)) return { cls: "network", retryable: true, message };
  return { cls: "provider", retryable: false, message };
}

/** Classes that say something about the connection itself (they move the instance's health). */
export const HEALTH_CLASSES: readonly ErrorClass[] = ["auth", "permission", "timeout", "network", "provider", "config"];

export interface RetryPolicy { attempts: number; baseDelayMs: number }
export const READ_RETRY: RetryPolicy = { attempts: 3, baseDelayMs: 400 };

/** Runs fn up to `attempts` times while the error is retryable; exponential backoff with jitter. */
export async function withRetry<T>(fn: () => Promise<T>, p: RetryPolicy, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))) {
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      return { value: await fn(), attempts: attempt };
    } catch (e) {
      const c = classify(e);
      if (!c.retryable || attempt >= p.attempts) throw Object.assign(e instanceof Error ? e : new Error(String(e)), { attempts: attempt, classified: c });
      await sleep(p.baseDelayMs * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5));
    }
  }
}

/** fetch with a hard deadline (combined with any signal the caller passes). */
export const fetchWithTimeout = (http: typeof fetch, ms: number): typeof fetch =>
  ((url: string | URL | Request, init: RequestInit = {}) =>
    http(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms) })) as typeof fetch;

/**
 * Sliding-window limit per key (connector instance). In-process: correct for the single server process SQLite
 * deployments run (docs/DEPLOY.md); a second process would have its own window.
 */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private perWindow: number, private windowMs = 60_000) {}
  take(key: string, at = Date.now()): boolean {
    const arr = (this.hits.get(key) ?? []).filter((t) => at - t < this.windowMs);
    if (arr.length >= this.perWindow) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(at);
    this.hits.set(key, arr);
    return true;
  }
}
