// Per-key rate limiting (token bucket) and daily quota. In-memory by design: the service runs
// as one instance; usage is persisted separately for reporting and to seed quotas after restarts.

export interface LimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the next token (rate) or until UTC midnight (quota). */
  resetSeconds: number;
  reason?: "rate" | "quota";
}

interface Bucket {
  tokens: number;
  updated: number;
}

const BUCKET_TTL_MS = 15 * 60_000;

export class RateLimiter {
  private buckets = new Map<number, Bucket>();
  private lastSweep = 0;

  constructor(private now: () => number = () => Date.now()) {}

  take(keyId: number, perMinute: number): LimitDecision {
    const t = this.now();
    this.sweep(t);
    const rate = perMinute / 60_000; // tokens per ms
    const b = this.buckets.get(keyId) ?? { tokens: perMinute, updated: t };
    b.tokens = Math.min(perMinute, b.tokens + (t - b.updated) * rate);
    b.updated = t;
    this.buckets.set(keyId, b);
    if (b.tokens < 1) {
      return {
        allowed: false,
        limit: perMinute,
        remaining: 0,
        resetSeconds: Math.max(1, Math.ceil((1 - b.tokens) / rate / 1000)),
        reason: "rate",
      };
    }
    b.tokens -= 1;
    return {
      allowed: true,
      limit: perMinute,
      remaining: Math.floor(b.tokens),
      resetSeconds: Math.ceil((perMinute - b.tokens) / rate / 1000),
    };
  }

  /** Idle buckets are full buckets; dropping them changes nothing and bounds memory. */
  private sweep(t: number) {
    if (t - this.lastSweep < 60_000) return;
    this.lastSweep = t;
    for (const [id, b] of this.buckets) if (t - b.updated > BUCKET_TTL_MS) this.buckets.delete(id);
  }

  get size() {
    return this.buckets.size;
  }
}

export class DailyQuota {
  private used = new Map<string, number>();

  constructor(
    /** Loads today's persisted count once per key per day (after a restart). */
    private seed: (keyId: number, day: string) => Promise<number>,
    private now: () => number = () => Date.now(),
  ) {}

  static day(t: number): string {
    return new Date(t).toISOString().slice(0, 10);
  }

  async take(keyId: number, quota: number): Promise<LimitDecision> {
    const t = this.now();
    const day = DailyQuota.day(t);
    const k = `${keyId}:${day}`;
    if (!this.used.has(k)) {
      for (const key of this.used.keys()) if (!key.endsWith(day)) this.used.delete(key);
      this.used.set(k, await this.seed(keyId, day).catch(() => 0));
    }
    const used = this.used.get(k)!;
    const midnight = Date.parse(`${day}T00:00:00Z`) + 86_400_000;
    const reset = Math.ceil((midnight - t) / 1000);
    if (used >= quota) {
      return { allowed: false, limit: quota, remaining: 0, resetSeconds: reset, reason: "quota" };
    }
    this.used.set(k, used + 1);
    return { allowed: true, limit: quota, remaining: quota - used - 1, resetSeconds: reset };
  }
}
