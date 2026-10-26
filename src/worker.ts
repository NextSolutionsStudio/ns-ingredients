// Cloudflare Workers entry: the public deployment (API + the explorer UI in web/, which Workers Static
// Assets serves before this code runs). The knowledge base is baked in at build time
// (`deno task build:worker`). There is no database here, so no API keys: keyless access with per-IP
// limits instead. Keyed access with quotas is the self-hosted server (src/main.ts).
import bundle from "../dist/kb-bundle.json" with { type: "json" };
import type { Scope } from "./auth/keys.ts";
import { KbIndex } from "./core/kb-index.ts";
import { createApp } from "./http/app.ts";
import { DailyQuota, RateLimiter } from "./http/limits.ts";
import { jsonLogger } from "./http/log.ts";
import type { KbBundle } from "./kb/schema.ts";
import { createOffClient, routeOff } from "./off/off.ts";
import { ANON_RATES, anonymousLimiter, type LimitBindings } from "./worker-limits.ts";

const index = new KbIndex(bundle as unknown as KbBundle);
const off = createOffClient(
  "ns-ingredients/0.1 (NextSolutions; https://github.com/NextSolutionsStudio/ns-ingredients)",
);
const local = new RateLimiter();

let app: ReturnType<typeof createApp> | null = null;
let take: ReturnType<typeof anonymousLimiter> | null = null;

export default {
  async fetch(req: Request, env: LimitBindings): Promise<Response> {
    const url = new URL(req.url);
    take ??= anonymousLimiter(env, local);
    if (url.pathname.startsWith("/off/")) {
      const d = await take(req.headers.get("cf-connecting-ip") ?? "unknown", "off");
      if (!d.allowed) {
        return new Response(
          JSON.stringify({
            error:
              `Product lookups are limited to ${d.limit} a minute per IP address. Try again in ${d.resetSeconds} s.`,
          }),
          {
            status: 429,
            headers: {
              "content-type": "application/json; charset=utf-8",
              "retry-after": String(d.resetSeconds),
            },
          },
        );
      }
      const res = await routeOff(off, req, url);
      if (res) return res;
    }
    app ??= createApp({
      index: () => index,
      keys: { verify: () => Promise.resolve(null) },
      limiter: local,
      quota: new DailyQuota(() => Promise.resolve(0)),
      usage: { record() {} },
      log: jsonLogger("info"),
      config: { CORS_ORIGINS: "", PUBLIC_BASE_URL: url.origin },
      anonymous: {
        scopes: ["kb:read", "analyze"] satisfies Scope[],
        take: (client, scope) => take!(client, scope),
        perMinute: ANON_RATES,
      },
    });
    return await app.fetch(req);
  },
};
