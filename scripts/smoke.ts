// Post-deploy smoke test against a running instance. Read-only: it never creates keys or writes data.
//
//   deno task smoke                                        # public endpoints on the production host
//   SMOKE_BASE_URL=http://127.0.0.1:8029 deno task smoke   # a local server
//   vault exec --keys SMOKE_API_KEY -- deno task smoke     # also the keyed endpoints (key never printed)
const base = (Deno.env.get("SMOKE_BASE_URL") ?? "https://ingredients.nextsolutions.studio").replace(
  /\/$/,
  "",
);
const key = Deno.env.get("SMOKE_API_KEY");
const auth = key ? { authorization: `Bearer ${key}` } : undefined;

type Check = { name: string; run: () => Promise<string | void> };
const expect = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(msg);
};
const get = (path: string, headers: Record<string, string> = {}) =>
  fetch(base + path, { headers: { ...auth, ...headers }, signal: AbortSignal.timeout(10_000) });

const LABEL =
  "Składniki: koncentrat białek serwatkowych (z MLEKA), kwas jabłkowy, emulgator: lecytyna sojowa, sukraloza.";

const checks: Check[] = [
  { name: "health", run: async () => expect((await get("/health")).status === 200, "not 200") },
  {
    name: "ready (database reachable)",
    run: async () => expect((await get("/ready")).status === 200, "not 200"),
  },
  {
    name: "meta",
    run: async () => {
      const m = await (await get("/v1/meta")).json();
      expect(m.kb_version?.startsWith("kb-"), "no kb_version");
      return `${m.kb_version}, service ${m.version}`;
    },
  },
  {
    name: "openapi document",
    run: async () => {
      const d = await (await get("/v1/openapi.json")).json();
      expect(d.openapi?.startsWith("3.1"), "not OpenAPI 3.1");
      return `${Object.keys(d.paths ?? {}).length} paths`;
    },
  },
  {
    name: "keyed routes refuse anonymous callers",
    run: async () => {
      const r = await fetch(base + "/v1/ingredients?q=e330", { signal: AbortSignal.timeout(10_000) });
      await r.body?.cancel();
      expect(r.status === 401, `got ${r.status}`);
    },
  },
];

if (key) {
  checks.push(
    {
      name: "search",
      run: async () => {
        const r = await (await get(`/v1/ingredients?q=${encodeURIComponent("kwas jabłkowy")}`)).json();
        expect(r.items?.[0]?.id === "malic-acid", `first hit ${r.items?.[0]?.id}`);
      },
    },
    {
      name: "detail + ETag revalidation",
      run: async () => {
        const first = await get("/v1/ingredients/E296");
        await first.body?.cancel();
        const tag = first.headers.get("etag");
        expect(first.status === 200 && tag, "no etag");
        const again = await get("/v1/ingredients/E296", { "if-none-match": tag! });
        await again.body?.cancel();
        expect(again.status === 304, `revalidation got ${again.status}`);
      },
    },
    {
      name: "analyze",
      run: async () => {
        const r = await fetch(base + "/v1/analyze", {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify({ text: LABEL, lang: "pl" }),
          signal: AbortSignal.timeout(10_000),
        });
        expect(r.status === 200, `got ${r.status}`);
        const a = await r.json();
        const codes = a.flags.map((f: { code: string }) => f.code);
        for (const c of ["allergen.milk", "allergen.soybeans"]) expect(codes.includes(c), `missing ${c}`);
        return `${a.flags.length} flags, coverage ${a.coverage.ratio}, remaining quota ${
          r.headers.get("ratelimit-remaining") ?? "?"
        }`;
      },
    },
  );
}

let failed = 0;
console.log(`smoke: ${base}${key ? "" : " (no SMOKE_API_KEY — public checks only)"}`);
for (const c of checks) {
  try {
    const info = await c.run();
    console.log(`  ok    ${c.name}${info ? ` — ${info}` : ""}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${c.name} — ${e instanceof Error ? e.message : e}`);
  }
}
if (failed) Deno.exit(1);
