import { assert, assertEquals, assertFalse, assertNotEquals } from "@std/assert";
import {
  createKey,
  KeyStore,
  listKeys,
  parseToken,
  revokeKey,
  sha256Hex,
  timingSafeEqual,
} from "../../src/auth/keys.ts";
import { connect } from "../../src/db/client.ts";
import { migrate } from "../../src/db/migrate.ts";
import { DailyQuota, RateLimiter } from "../../src/http/limits.ts";

Deno.test("token format: nsi_<8>_<32>, parsed by prefix only", () => {
  assertEquals(parseToken("nsi_ABCDefgh_0123456789abcdefghijABCDEFGHIJ01"), { prefix: "ABCDefgh" });
  for (
    const bad of [
      "",
      "nsi_",
      "nsk_ABCDefgh_0123456789abcdefghijABCDEFGHIJ01",
      "nsi_ABCDefg_0123456789abcdefghijABCDEFGHIJ01",
      "nsi_ABCDefgh_short",
      "nsi_ABCDefgh_0123456789abcdefghijABCDEFGHIJ01x",
      "nsi_ABC-efgh_0123456789abcdefghijABCDEFGHIJ01",
    ]
  ) {
    assertEquals(parseToken(bad), null, bad);
  }
});

Deno.test("timingSafeEqual and sha256Hex", async () => {
  assert(timingSafeEqual("abc", "abc"));
  assertFalse(timingSafeEqual("abc", "abd"));
  assertFalse(timingSafeEqual("abc", "abcd"));
  assertEquals((await sha256Hex("x")).length, 64);
});

Deno.test("keys: create stores only a hash; verify, scopes, revoke, cache bound", async () => {
  const db = await connect("pglite:memory");
  await migrate(db);
  let clock = 1_000_000;
  const store = new KeyStore(db, 60, () => clock);
  const { token, key } = await createKey(db, {
    label: "t",
    scopes: ["kb:read"],
    ratePerMin: 5,
    dailyQuota: 7,
  });
  assert(parseToken(token));
  const [row] = await db.query<{ hash: string }>("select hash from api_key where id = $1", [key.id]);
  assertNotEquals(row.hash, token);
  assertEquals(row.hash, await sha256Hex(token));

  const v = await store.verify(token);
  assertEquals([v?.label, v?.scopes, v?.rate_per_min, v?.daily_quota], ["t", ["kb:read"], 5, 7]);
  // Same prefix, wrong secret → rejected.
  assertEquals(await store.verify(token.slice(0, -1) + (token.endsWith("a") ? "b" : "a")), null);
  assertEquals(await store.verify("garbage"), null);

  assert(await revokeKey(db, key.prefix));
  assertFalse(await revokeKey(db, key.prefix)); // already revoked
  assert(await store.verify(token), "cached for up to cacheSeconds");
  clock += 61_000;
  assertEquals(await store.verify(token), null, "revocation visible after the cache window");
  assertEquals((await listKeys(db))[0].revoked_at !== null, true);
  await db.close();
});

Deno.test("createKey rejects unknown or empty scopes", async () => {
  const db = await connect("pglite:memory");
  await migrate(db);
  let threw = 0;
  for (const scopes of [[], ["admin"]] as never[]) {
    try {
      await createKey(db, { label: "x", scopes });
    } catch {
      threw++;
    }
  }
  assertEquals(threw, 2);
  await db.close();
});

Deno.test("token bucket: burst, refill, eviction", () => {
  let t = 0;
  const rl = new RateLimiter(() => t);
  for (let i = 0; i < 3; i++) assert(rl.take(1, 3).allowed);
  const denied = rl.take(1, 3);
  assertFalse(denied.allowed);
  assertEquals(denied.reason, "rate");
  assertEquals(denied.resetSeconds, 20); // one token per 20 s at 3/min
  t += 20_000;
  assert(rl.take(1, 3).allowed);
  assert(rl.take(2, 3).allowed, "keys have separate buckets");
  t += 16 * 60_000;
  rl.take(3, 3); // triggers the sweep
  assertEquals(rl.size, 1);
});

Deno.test("daily quota: seeded after restart, resets at UTC midnight", async () => {
  let t = Date.parse("2026-09-27T23:59:00Z");
  const q = new DailyQuota(() => Promise.resolve(2), () => t); // 2 already used today (persisted)
  assert((await q.take(9, 3)).allowed);
  const d = await q.take(9, 3);
  assertFalse(d.allowed);
  assertEquals(d.reason, "quota");
  assertEquals(d.resetSeconds, 60);
  t = Date.parse("2026-09-28T00:00:01Z");
  const q2 = new DailyQuota(() => Promise.resolve(0), () => t);
  assert((await q2.take(9, 3)).allowed);
});
