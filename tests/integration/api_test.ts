// The whole HTTP API in-process: auth, scopes, limits, validation, contract, caching, privacy.
// Runs on PGlite by default and on real Postgres when TEST_DATABASE_URL is set (CI: postgres:17).
import { assert, assertEquals, assertFalse, assertMatch } from "@std/assert";
import { createKey } from "../../src/auth/keys.ts";
import { PROBLEM_TYPES } from "../../src/http/app.ts";
import * as S from "../../src/http/schemas.ts";
import { startApi } from "../helpers.ts";

const LABEL =
  "Skład: koncentrat białka serwatkowego (z MLEKA) 80%, emulgator: lecytyny (z soi), kwas jabłkowy, sukraloza. Może zawierać orzechy laskowe.";
const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const PUBLIC = new Set(["/v1/meta"]);

Deno.test("public endpoints need no key", async () => {
  const api = await startApi();
  try {
    assertEquals((await (await api.req("/health", { auth: false })).json()).status, "ok");
    const ready = await api.req("/ready", { auth: false });
    assertEquals(ready.status, 200);
    assertEquals((await ready.json()).kb_version, "kb-fixture");
    const meta = S.MetaResponse.parse(await (await api.req("/v1/meta", { auth: false })).json());
    assertEquals(meta.licences.knowledge_base, "CC-BY-SA-4.0");
    const spec = await (await api.req("/v1/openapi.json", { auth: false })).json();
    assertEquals(spec.openapi, "3.1.0");
    const docs = await api.req("/docs", { auth: false });
    assert((await docs.text()).includes("/v1/openapi.json"));
    assertEquals((await api.req("/", { auth: false, redirect: "manual" })).status, 302);
  } finally {
    await api.close();
  }
});

Deno.test("route walker: every operation in the published spec rejects a missing key with problem+json", async () => {
  const api = await startApi();
  try {
    const spec = await (await api.req("/v1/openapi.json", { auth: false })).json();
    const ops = Object.entries(spec.paths as Record<string, Record<string, unknown>>)
      .flatMap(([path, methods]) =>
        Object.keys(methods).map((m) => [m.toUpperCase(), path.replace(/\{[^}]+\}/g, "E296")])
      );
    assert(ops.length >= 6, `spec lists ${ops.length} operations`);
    for (const [method, path] of ops) {
      if (PUBLIC.has(path)) continue;
      const r = await api.req(path, {
        method,
        auth: false,
        ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: "{}" } : {}),
      });
      assertEquals(r.status, 401, `${method} ${path}`);
      assertEquals(r.headers.get("content-type"), "application/problem+json");
      assertMatch(r.headers.get("www-authenticate") ?? "", /^Bearer/);
      const p = S.Problem.parse(await r.json());
      assertEquals(p.status, 401);
    }
    // Declared security matches behaviour: every non-public operation declares bearerAuth.
    for (
      const [path, methods] of Object.entries(
        spec.paths as Record<string, Record<string, { security?: unknown }>>,
      )
    ) {
      for (const op of Object.values(methods)) {
        if (!PUBLIC.has(path)) assert(op.security, `${path} declares security`);
      }
    }
  } finally {
    await api.close();
  }
});

Deno.test("invalid and revoked keys are 401; missing scope is 403", async () => {
  const api = await startApi({ scopes: ["kb:read"] });
  try {
    assertEquals((await api.req("/v1/implications", { auth: "nsi_AAAAAAAA_" + "B".repeat(32) })).status, 401);
    assertEquals(
      (await api.req("/v1/implications", { headers: { authorization: "Basic abc" }, auth: false })).status,
      401,
    );
    assertEquals((await api.req("/v1/implications")).status, 200);
    const forbidden = await api.req("/v1/analyze", json({ text: "cukier" }));
    assertEquals(forbidden.status, 403);
    assertEquals(
      (await forbidden.json()).type,
      "https://ingredients.nextsolutions.studio/problems/forbidden",
    );
    const { token, key } = await createKey(api.rt.db, { label: "r", scopes: ["kb:read"] });
    assertEquals((await api.req("/v1/implications", { auth: token })).status, 200);
    await api.rt.db.query("update api_key set revoked_at = now() where id = $1", [key.id]);
    api.rt.keys.invalidate(key.prefix);
    assertEquals((await api.req("/v1/implications", { auth: token })).status, 401);
  } finally {
    await api.close();
  }
});

Deno.test("analyze: contract, headers, and no-store caching", async () => {
  const api = await startApi();
  try {
    const r = await api.req(
      "/v1/analyze",
      json({ text: LABEL, profile: { avoid: ["allergen.*"], diets: ["vegan"] } }),
    );
    assertEquals(r.status, 200);
    const a = S.AnalysisResponse.parse(await r.json());
    assertEquals(r.headers.get("x-kb-version"), "kb-fixture");
    assertEquals(r.headers.get("cache-control"), "no-store");
    assertMatch(r.headers.get("x-request-id") ?? "", /^[0-9a-f-]{36}$/);
    assertEquals(r.headers.get("ratelimit-limit"), "1000");
    assertEquals(a.items[0].match?.ingredient_id, "whey-protein-concentrate");
    assertEquals(a.items[0].percent?.value, 80);
    assert(a.flags.some((f) => f.code === "allergen.milk"));
    assert(a.flags.some((f) => f.code === "allergen.soybeans"));
    assertEquals(a.diets.vegan.status, "no");
    assertEquals(a.may_contain[0].ingredient_id, "hazelnuts");
    assert(a.profile!.hits.some((h) => h.code === "allergen.nuts" && h.trace));
  } finally {
    await api.close();
  }
});

Deno.test("analyze: validation, media type and size limits answer with problems", async () => {
  const api = await startApi();
  try {
    const cases: [RequestInit, number][] = [
      [json({}), 400],
      [json({ text: "" }), 400],
      [json({ text: "cukier", extra: 1 }), 400],
      [json({ text: "cukier", profile: { avoid: ["DROP TABLE"] } }), 400],
      [json({ text: "cukier", lang: "fr" }), 400],
      [{ method: "POST", headers: { "content-type": "text/plain" }, body: "cukier" }, 415],
      [{ method: "POST", headers: { "content-type": "application/json" }, body: "{not json" }, 400],
      [json({ text: "x".repeat(20_000) }), 413],
    ];
    for (const [init, status] of cases) {
      const r = await api.req("/v1/analyze", init);
      assertEquals(r.status, status, String(init.body).slice(0, 60));
      assertEquals(r.headers.get("content-type"), "application/problem+json");
      const p = S.Problem.parse(await r.json());
      assertFalse(JSON.stringify(p).includes("at "), "no stack traces");
    }
    const bad = await (await api.req("/v1/analyze", json({ text: "" }))).json();
    assertEquals(bad.errors[0].path, "text");
  } finally {
    await api.close();
  }
});

Deno.test("search: E-numbers, typos, facets, pagination, hostile input", async () => {
  const api = await startApi();
  try {
    const get = async (qs: string) => {
      const r = await api.req(`/v1/ingredients?${qs}`);
      assertEquals(r.status, 200, qs);
      return S.SearchResponse.parse(await r.json());
    };
    assertEquals((await get("q=e%20296")).items[0].id, "malic-acid");
    assertEquals((await get("q=INS%20322")).items[0].id, "lecithins");
    assertEquals((await get("q=kwas%20jablkowy")).items[0].id, "malic-acid");
    assertEquals((await get("q=%C3%84pfels%C3%A4ure")).items[0].id, "malic-acid");
    assertEquals((await get("q=sukralosa")).items[0].id, "sucralose");
    const pl = await get("q=lecytyna&lang=pl");
    assertEquals(pl.items[0].name, "lecytyny");
    const petro = await get("origin=petrochemical_synthetic");
    assertEquals(petro.items.map((i) => i.id), ["malic-acid"]);
    const emu = await get("function=emulsifier");
    assertEquals(emu.items.map((i) => i.id).sort(), ["lecithins", "mono-and-diglycerides"]);
    // Facets match claims of any variant: the powder qualifies through its palm variant.
    const both = await get("implication=origin.vegetable_oil_derived,ethics.palm_oil");
    assertEquals(both.items.map((i) => i.id).sort(), ["palm-oil", "vegetable-fat-powder"]);

    const p1 = await get("limit=5");
    assertEquals(p1.items.length, 5);
    assert(p1.next_cursor);
    const p2 = await get(`limit=5&cursor=${p1.next_cursor}`);
    assertFalse(p2.items.some((i) => p1.items.some((j) => j.id === i.id)));

    for (const q of ["' OR 1=1 --", "%", "_", "\\", "🍫".repeat(20), "<script>", "a".repeat(200)]) {
      await get(`q=${encodeURIComponent(q)}`);
    }
    assertEquals((await api.req("/v1/ingredients?limit=500")).status, 400);
    assertEquals((await api.req(`/v1/ingredients?q=${"a".repeat(201)}`)).status, 400);
    assertEquals((await api.req("/v1/ingredients?cursor=%%%")).status, 400);
  } finally {
    await api.close();
  }
});

Deno.test("ingredient detail by id or E-number, localised, with resolved sources; ETag 304", async () => {
  const api = await startApi();
  try {
    const r = await api.req("/v1/ingredients/E296?lang=pl");
    assertEquals(r.status, 200);
    const ing = S.Ingredient.parse(await r.json());
    assertEquals([ing.id, ing.name], ["malic-acid", "kwas jabłkowy"]);
    assertEquals(ing.variants.map((v) => [v.id, v.prior]), [["dl", 0.8], ["l", 0.2]]);
    for (const a of ing.assertions) for (const s of a.sources) assert(ing.sources[s.id], s.id);
    assertEquals(ing.functions.map((f) => f.name), ["kwas", "regulator kwasowości"]);

    const etag = r.headers.get("etag")!;
    assertMatch(etag, /^W\/"kb-fixture\./);
    const again = await api.req("/v1/ingredients/E296?lang=pl", { headers: { "if-none-match": etag } });
    assertEquals(again.status, 304);
    assertEquals(
      (await api.req("/v1/ingredients/malic-acid", { headers: { "accept-language": "de-DE,de;q=0.9" } }).then(
        (x) => x.json(),
      )).name,
      "Äpfelsäure",
    );
    assertEquals((await api.req("/v1/ingredients/nope")).status, 404);
    assertEquals((await api.req("/v1/sources/reg-1333-2008")).status, 200);
    assertEquals((await api.req("/v1/sources/nope")).status, 404);
    const impl = S.ImplicationsResponse.parse(await (await api.req("/v1/implications?lang=pl")).json());
    assert(impl.items.find((i) => i.code === "allergen.milk")!.label.startsWith("Mleko"));
  } finally {
    await api.close();
  }
});

Deno.test("rate limit returns 429 with Retry-After; quota is enforced per day", async () => {
  const api = await startApi({ rate: 2, quota: 1000 });
  try {
    assertEquals((await api.req("/v1/implications")).status, 200);
    assertEquals((await api.req("/v1/implications")).status, 200);
    const limited = await api.req("/v1/implications");
    assertEquals(limited.status, 429);
    assertEquals(limited.headers.get("retry-after"), "30");
    assertEquals((await limited.json()).title, "Too many requests");
  } finally {
    await api.close();
  }
  const q = await startApi({ rate: 100, quota: 2 });
  try {
    await q.req("/v1/implications");
    await q.req("/v1/implications");
    const r = await q.req("/v1/implications");
    assertEquals(r.status, 429);
    assertEquals((await r.json()).title, "Daily quota exceeded");
  } finally {
    await q.close();
  }
  // Each request spends one unit, on every keyed route: "/v1/ingredients/*" once also matched the search
  // route, so a search was limited and counted twice.
  const once = await startApi({ rate: 100, quota: 1000 });
  try {
    for (const path of ["/v1/ingredients?q=cukier", "/v1/ingredients?q=cukier", "/v1/ingredients/E330"]) {
      await (await once.req(path)).body?.cancel();
    }
    const r = await once.req("/v1/implications");
    assertEquals(r.headers.get("ratelimit-remaining"), "96");
  } finally {
    await once.close();
  }
});

Deno.test("usage is persisted per key/day/route and survives a flush error", async () => {
  const api = await startApi();
  try {
    await api.req("/v1/implications");
    await api.req("/v1/implications");
    await api.req("/v1/ingredients/nope");
    await api.rt.usage.flush();
    const rows = await api.rt.db.query<{ route: string; count: number; errors: number }>(
      "select route, count, errors from api_usage order by route",
    );
    assertEquals(rows.map((r) => [r.route, Number(r.count), Number(r.errors)]), [
      ["/v1/implications", 2, 0],
      ["/v1/ingredients/:id", 1, 1],
    ]);
    await api.req("/v1/implications");
    await api.rt.usage.flush();
    const [imp] = await api.rt.db.query<{ count: number }>(
      "select count from api_usage where route = '/v1/implications'",
    );
    assertEquals(Number(imp.count), 3, "upsert increments");
  } finally {
    await api.close();
  }
});

Deno.test("privacy: request logs carry no body, profile or query text", async () => {
  const api = await startApi();
  try {
    await api.req(
      "/v1/analyze",
      json({ text: "Skład: SEKRETNY_SKLADNIK", profile: { avoid: ["allergen.milk"], diets: ["vegan"] } }),
    );
    await api.req("/v1/ingredients?q=ciaza_pregnancy_marker");
    const logs = api.log.lines.join("\n");
    for (const needle of ["SEKRETNY", "allergen.milk", "vegan", "ciaza", "pregnancy", api.token]) {
      assertFalse(logs.includes(needle), `log leaked ${needle}`);
    }
    const line = JSON.parse(api.log.lines.find((l) => l.includes("/v1/analyze"))!);
    assertEquals(Object.keys(line).sort(), [
      "key",
      "level",
      "method",
      "ms",
      "msg",
      "req_id",
      "route",
      "status",
      "ts",
    ]);
  } finally {
    await api.close();
  }
});

Deno.test("unknown routes and CORS", async () => {
  const api = await startApi({ env: { CORS_ORIGINS: "https://airon.app" } });
  try {
    const nf = await api.req("/v1/nothing-here", { auth: false });
    assertEquals(nf.status, 404);
    assertEquals(nf.headers.get("content-type"), "application/problem+json");
    const pre = await api.req("/v1/analyze", {
      method: "OPTIONS",
      auth: false,
      headers: { origin: "https://airon.app", "access-control-request-method": "POST" },
    });
    assertEquals(pre.headers.get("access-control-allow-origin"), "https://airon.app");
    const other = await api.req("/v1/implications", { headers: { origin: "https://evil.example" } });
    assertEquals(other.headers.get("access-control-allow-origin"), null);
  } finally {
    await api.close();
  }
});

Deno.test("every problem type the code emits is registered, documented and served at its URI", async () => {
  const code = await Deno.readTextFile(new URL("../../src/http/app.ts", import.meta.url));
  const emitted = new Set([...code.matchAll(/problem\([^,]+,\s*\d+,\s*"([a-z-]+)"/g)].map((m) => m[1]));
  emitted.add("rate-limited").add("quota-exceeded"); // chosen by a ternary
  const docs = await Deno.readTextFile(new URL("../../docs/API.md", import.meta.url));
  const api = await startApi();
  try {
    for (const slug of emitted) {
      assert(slug in PROBLEM_TYPES, `${slug} not registered`);
      assert(docs.includes(`| \`${slug}\` |`), `${slug} not in docs/API.md`);
      const r = await api.req(`/problems/${slug}`, { auth: false });
      const body = await r.json();
      assertEquals([r.status, body.status, body.type.endsWith(`/problems/${slug}`)], [
        200,
        PROBLEM_TYPES[slug].status,
        true,
      ]);
    }
    for (const slug of Object.keys(PROBLEM_TYPES)) {
      assert(emitted.has(slug), `${slug} registered but never emitted`);
    }
    const missing = await api.req("/problems/nope", { auth: false });
    await missing.body?.cancel();
    assertEquals(missing.status, 404);
  } finally {
    await api.close();
  }
});

Deno.test("fields= trims the analysis and the ingredient record; an unknown field is a 400 listing valid ones", async () => {
  const api = await startApi();
  try {
    const small = await api.req(
      "/v1/analyze?fields=summary.danger,flags.code",
      json({ text: LABEL, lang: "pl" }),
    );
    assertEquals(small.status, 200);
    const body = await small.json();
    assertEquals(Object.keys(body).sort(), ["flags", "summary"]);
    assertEquals(Object.keys(body.summary), ["danger"]);
    assert(body.flags.length > 0 && body.flags.every((f: object) => Object.keys(f).join() === "code"));

    const bad = await api.req("/v1/analyze?fields=summary,flagz", json({ text: LABEL }));
    assertEquals(bad.status, 400);
    const problem = await bad.json();
    assertEquals(problem.errors, [{ path: "fields", message: "not a field: flagz" }]);
    assert(problem.valid_fields.includes("ranking.reasons.label"));

    const ing = await (await api.req("/v1/ingredients/sugar?fields=id,assertions.code")).json();
    assertEquals(Object.keys(ing).sort(), ["assertions", "id"]);
    assertEquals((await api.req("/v1/ingredients/sugar?fields=nope")).status, 400);
  } finally {
    await api.close();
  }
});
