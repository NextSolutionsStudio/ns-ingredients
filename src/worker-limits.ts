// Keyless rate limits for the Cloudflare deployment, kept apart from src/worker.ts so tests can import
// them without the build-time KB bundle.
import type { LimitDecision } from "./http/limits.ts";
import { RateLimiter } from "./http/limits.ts";

export interface RateLimitBinding {
  limit(o: { key: string }): Promise<{ success: boolean }>;
}

export interface LimitBindings {
  ANON_READ: RateLimitBinding;
  ANON_ANALYZE: RateLimitBinding;
  ANON_OFF: RateLimitBinding;
}

/** Requests a minute per IP address. wrangler.toml's [[ratelimits]] must match (tests/unit/worker_test.ts). */
export const ANON_RATES = { "kb:read": 120, analyze: 30, off: 20 } as const;
export type AnonBucket = keyof typeof ANON_RATES;

export const ANON_BINDINGS: Record<AnonBucket, keyof LimitBindings> = {
  "kb:read": "ANON_READ",
  analyze: "ANON_ANALYZE",
  off: "ANON_OFF",
};

function bucketId(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** A per-isolate token bucket gives exact RateLimit-* headers; the binding is the limit shared across
 * isolates in one Cloudflare location. A request must pass both. */
export function anonymousLimiter(env: LimitBindings, local = new RateLimiter()) {
  return async (client: string, bucket: AnonBucket): Promise<LimitDecision> => {
    const perMin = ANON_RATES[bucket];
    const mine = local.take(bucketId(`${bucket}|${client}`), perMin);
    if (!mine.allowed) return mine;
    const { success } = await env[ANON_BINDINGS[bucket]].limit({ key: client });
    return success ? mine : { allowed: false, limit: perMin, remaining: 0, resetSeconds: 60, reason: "rate" };
  };
}
