// Login throttling, stored in the database: it survives restarts and is shared by every process using the file.
// Per account: after `accountFree` failures inside the window the account is locked with exponential backoff —
// rotating or forged client IPs do not help an attacker guessing one account's password. Per client IP (the
// address the trusted proxy reported): a ceiling on failures from one address across accounts.
import type { Db } from "../db/db.js";

export interface ThrottlePolicy {
  accountFree: number;
  ipFree: number;
  windowMs: number;
  baseLockMs: number;
  maxLockMs: number;
}

export const DEFAULT_THROTTLE: ThrottlePolicy = { accountFree: 5, ipFree: 30, windowMs: 15 * 60_000, baseLockMs: 30_000, maxLockMs: 15 * 60_000 };

interface Row { failures: number; window_start: string; locked_until: string | null }

const iso = (ms: number) => new Date(ms).toISOString();

export class LoginThrottle {
  /** `scope` separates counters of different entry points (login, account activation) */
  constructor(private db: Db, private p: ThrottlePolicy = DEFAULT_THROTTLE, private scope = "") {}

  private keys(username: string, ip: string) {
    return [`${this.scope}user:${username.trim().toLowerCase()}`, `${this.scope}ip:${ip}`] as const;
  }

  /** Address-only limit (for entry points without an account name, e.g. one-time activation tokens). */
  retryAfterIpMs(ip: string, at = Date.now()): number {
    const r = this.db.get<Row>("SELECT locked_until FROM login_throttle WHERE key = ?", this.keys("", ip)[1]);
    return r?.locked_until ? Math.max(0, Date.parse(r.locked_until) - at) : 0;
  }

  failIp(ip: string, at = Date.now()): number {
    return this.db.tx(() => this.bump(this.keys("", ip)[1], this.p.ipFree, at));
  }

  /** Milliseconds until another attempt is allowed for this account / address (0 = allowed now). */
  retryAfterMs(username: string, ip: string, at = Date.now()): number {
    let wait = 0;
    for (const key of this.keys(username, ip)) {
      const r = this.db.get<Row>("SELECT failures, window_start, locked_until FROM login_throttle WHERE key = ?", key);
      if (r?.locked_until) wait = Math.max(wait, Date.parse(r.locked_until) - at);
    }
    return Math.max(0, wait);
  }

  /** Records a failed attempt; returns the lock now in force (ms, 0 = none). */
  fail(username: string, ip: string, at = Date.now()): number {
    const [userKey, ipKey] = this.keys(username, ip);
    return this.db.tx(() => Math.max(this.bump(userKey, this.p.accountFree, at), this.bump(ipKey, this.p.ipFree, at)));
  }

  /** A successful login clears the account's counter (not the address's: one good password must not unlock a sprayer). */
  succeed(username: string) {
    this.db.run("DELETE FROM login_throttle WHERE key = ?", this.keys(username, "")[0]);
  }

  /** Drops rows whose window and lock are both over. */
  prune(at = Date.now()) {
    return this.db.run(
      "DELETE FROM login_throttle WHERE window_start < ? AND (locked_until IS NULL OR locked_until < ?)",
      iso(at - this.p.windowMs), iso(at),
    ).changes;
  }

  private bump(key: string, free: number, at: number): number {
    const r = this.db.get<Row>("SELECT failures, window_start, locked_until FROM login_throttle WHERE key = ?", key);
    const fresh = !r || Date.parse(r.window_start) < at - this.p.windowMs;
    const failures = fresh ? 1 : r.failures + 1;
    const lockMs = failures >= free ? Math.min(this.p.maxLockMs, this.p.baseLockMs * 2 ** (failures - free)) : 0;
    this.db.run(
      `INSERT INTO login_throttle (key, failures, window_start, locked_until) VALUES (?,?,?,?)
       ON CONFLICT(key) DO UPDATE SET failures = excluded.failures, window_start = excluded.window_start, locked_until = excluded.locked_until`,
      key, failures, fresh ? iso(at) : r.window_start, lockMs ? iso(at + lockMs) : null,
    );
    return lockMs;
  }
}

/**
 * Which proxies may set X-Forwarded-For. Never "trust everyone": that would let any client choose its own IP.
 * TRUSTED_PROXIES = hop count (e.g. 1 = the platform's load balancer) or a comma-separated list of IPs/CIDRs.
 * The legacy TRUST_PROXY=true maps to one hop.
 */
export function trustedProxiesFrom(env: Record<string, string | undefined>): false | number | string {
  const v = env.TRUSTED_PROXIES?.trim();
  if (v) return /^\d+$/.test(v) ? Number(v) : v;
  if (env.TRUST_PROXY === "true") return 1;
  return false;
}
