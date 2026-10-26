// The Cloudflare deployment: keyless access in the HTTP layer, the per-IP limiter, and wrangler.toml
// staying in step with the limits the code reports.
import { assertEquals, assertMatch } from "@std/assert";
import { createApp } from "../../src/http/app.ts";
import { DailyQuota, type LimitDecision, RateLimiter } from "../../src/http/limits.ts";
import { memoryLogger } from "../../src/http/log.ts";
import { ANON_BINDINGS, ANON_RATES, anonymousLimiter, type LimitBindings } from "../../src/worker-limits.ts";
import { fixtureIndex } from "../helpers.ts";

const allow = { limit: () => Promise.resolve({ success: true }) };
const deny = { limit: () => Promise.resolve({ success: false }) };
const bindings = (b: Partial<LimitBindings> = {}): LimitBindings => ({
  ANON_READ: allow,
  ANON_ANALYZE: allow,
  ANON_OFF: allow,
  ...b,
});

async function edgeApp(take?: (client: string, scope: string) => Promise<LimitDecision>) {
  const index = await fixtureIndex();
  return createApp({
    index: () => index,
    keys: { verify: () => Promise.resolve(null) },
    limiter: new RateLimiter(),
    quota: new DailyQuota(() => Promise.resolve(0)),
    usage: { record() {} },
    log: memoryLogger(),
    config: { CORS_ORIGINS: "", PUBLIC_BASE_URL: "https://edge.test" },
    ...(take ? { anonymous: { scopes: ["kb:read", "analyze"] as const, take } } : {}),
  });
}

const analyze = (headers: Record<string, string> = {}) =>
  new Request("https://edge.test/v1/analyze", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7", ...headers },
    body: JSON.stringify({ text: "Składniki: cukier, kwas cytrynowy", lang: "pl" }),
  });

Deno.test("keyless: analyze and KB reads work, with RateLimit headers, and the client IP is what is limited", async () => {
  const seen: string[] = [];
  const app = await edgeApp((client, scope) => {
    seen.push(`${scope}@${client}`);
    return Promise.resolve({ allowed: true, limit: 30, remaining: 29, resetSeconds: 2 });
  });
  const res = await app.fetch(analyze());
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("ratelimit-limit"), "30");
  assertEquals(res.headers.get("ratelimit-remaining"), "29");
  const read = await app.fetch(new Request("https://edge.test/v1/ingredients?q=cukier"));
  assertEquals(read.status, 200);
  assertEquals(seen, ["analyze@203.0.113.7", "kb:read@unknown"]);
});

Deno.test("keyless: a denied request is a 429 problem with Retry-After", async () => {
  const app = await edgeApp(() =>
    Promise.resolve({ allowed: false, limit: 30, remaining: 0, resetSeconds: 17, reason: "rate" })
  );
  const res = await app.fetch(analyze());
  assertEquals(res.status, 429);
  assertEquals(res.headers.get("retry-after"), "17");
  const body = await res.json();
  assertMatch(body.type, /rate-limited$/);
  assertMatch(body.detail, /30 requests a minute per IP address/);
});

Deno.test("keyless: off unless configured; a malformed or unknown key is still rejected", async () => {
  assertEquals((await (await edgeApp()).fetch(analyze())).status, 401);
  const app = await edgeApp(() =>
    Promise.resolve({ allowed: true, limit: 30, remaining: 29, resetSeconds: 2 })
  );
  assertEquals((await app.fetch(analyze({ authorization: "Basic abc" }))).status, 401);
  assertEquals((await app.fetch(analyze({ authorization: "Bearer nsi_unknown" }))).status, 401);
});

Deno.test("keyless: the OpenAPI document marks the key as optional", async () => {
  const keyless =
    await (await (await edgeApp(() =>
      Promise.resolve({ allowed: true, limit: 1, remaining: 0, resetSeconds: 1 })
    )).fetch(new Request("https://edge.test/v1/openapi.json"))).json();
  assertEquals(keyless.paths["/v1/analyze"].post.security, [{ bearerAuth: [] }, {}]);
  const keyed = await (await (await edgeApp()).fetch(new Request("https://edge.test/v1/openapi.json")))
    .json();
  assertEquals(keyed.paths["/v1/analyze"].post.security, [{ bearerAuth: [] }]);
});

Deno.test("anonymousLimiter: the local bucket runs out first, and a denying binding blocks too", async () => {
  const t = 0;
  const take = anonymousLimiter(bindings(), new RateLimiter(() => t));
  for (let i = 0; i < ANON_RATES.off; i++) assertEquals((await take("198.51.100.1", "off")).allowed, true);
  assertEquals((await take("198.51.100.1", "off")).allowed, false);
  assertEquals((await take("198.51.100.2", "off")).allowed, true, "another IP has its own bucket");
  assertEquals((await take("198.51.100.1", "analyze")).allowed, true, "another bucket for the same IP");

  const blocked = await anonymousLimiter(bindings({ ANON_ANALYZE: deny }))("198.51.100.3", "analyze");
  assertEquals(blocked, {
    allowed: false,
    limit: ANON_RATES.analyze,
    remaining: 0,
    resetSeconds: 60,
    reason: "rate",
  });
});

Deno.test("wrangler.toml declares one [[ratelimits]] per bucket with the limits the code reports", async () => {
  const toml = await Deno.readTextFile(new URL("../../wrangler.toml", import.meta.url));
  const blocks = toml.split("[[ratelimits]]").slice(1).map((b) => ({
    name: b.match(/name\s*=\s*"(\w+)"/)?.[1],
    namespace: b.match(/namespace_id\s*=\s*"(\d+)"/)?.[1],
    limit: Number(b.match(/limit\s*=\s*(\d+)/)?.[1]),
    period: Number(b.match(/period\s*=\s*(\d+)/)?.[1]),
  }));
  for (const [bucket, binding] of Object.entries(ANON_BINDINGS)) {
    const block = blocks.find((b) => b.name === binding);
    assertEquals(block?.limit, ANON_RATES[bucket as keyof typeof ANON_RATES], binding);
    assertEquals(block?.period, 60, binding);
  }
  assertEquals(new Set(blocks.map((b) => b.namespace)).size, blocks.length, "namespace ids must be unique");
});
