// Local explorer: look up products on Open Food Facts by EAN or name, search the KB, and run ingredient
// lists through the real API.   deno task explorer   →   http://127.0.0.1:8030
//
// The API runs in-process on an in-memory database with a throwaway key. The key lives only in this
// process — it is never printed or sent to the browser; the proxy below attaches it. Binds to loopback only.
// Product data comes from Open Food Facts (ODbL) and is shown as theirs, not ours.
import { createKey } from "../src/auth/keys.ts";
import { loadConfig } from "../src/config.ts";
import { jsonLogger } from "../src/http/log.ts";
import { createRuntime } from "../src/runtime.ts";

const PORT = Number(Deno.env.get("EXPLORER_PORT") ?? 8030);
const OFF_UA = "ns-ingredients-explorer/0.1 (NextSolutions; local development tool)";
const OFF_TIMEOUT_MS = 15_000;
const LANGS = ["pl", "en", "de"] as const;
const PRODUCT_FIELDS = [
  "code",
  "product_name",
  "product_name_pl",
  "product_name_en",
  "generic_name",
  "brands",
  "quantity",
  "lang",
  "ingredients_text",
  ...LANGS.map((l) => `ingredients_text_${l}`),
  "image_front_small_url",
  "image_front_url",
  "image_ingredients_url",
  "nutriscore_grade",
  "nova_group",
  "allergens_tags",
  "traces_tags",
  "additives_tags",
  "categories",
].join(",");

const rt = await createRuntime(
  loadConfig({ DATABASE_URL: "pglite:memory", LOG_LEVEL: "warn" }),
  jsonLogger("warn"),
);
const { token } = await createKey(rt.db, {
  label: "explorer",
  scopes: ["kb:read", "analyze"],
  ratePerMin: 600,
  dailyQuota: 100_000,
});
const PAGE = new URL("./explorer.html", import.meta.url); // re-read per request: edits show on reload

// ---------------------------------------------------------------- API proxy
const API_PATHS = /^\/(?:v1\/|problems\/|docs$|health$|ready$)/;
const FORWARD_HEADERS = ["content-type", "if-none-match", "accept", "accept-language"];

async function toApi(req: Request, url: URL): Promise<Response> {
  const headers = new Headers({ authorization: `Bearer ${token}` });
  for (const h of FORWARD_HEADERS) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
  return await rt.app.request(url.pathname + url.search, { method: req.method, headers, body });
}

// ---------------------------------------------------------------- Open Food Facts
const cache = new Map<string, { at: number; status: number; body: unknown }>();
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 300;

async function offJson(url: string): Promise<{ status: number; body: any }> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit;
  const res = await fetch(url, {
    headers: { "user-agent": OFF_UA, accept: "application/json" },
    signal: AbortSignal.timeout(OFF_TIMEOUT_MS),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  const entry = { at: Date.now(), status: res.status, body };
  if (res.status < 500) {
    cache.set(url, entry);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  }
  return entry;
}

/** OFF marks allergens as _mleka_; the parser reads CAPS as label emphasis, so carry it over. */
function offEmphasisToCaps(text: string): string {
  return text.replace(/_([^_\n]{1,60})_/g, (_, s: string) => s.toUpperCase());
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

function toProduct(p: Record<string, unknown>) {
  const main = str(p.lang);
  const texts: { lang: string; text: string; supported: boolean }[] = [];
  const order = main && (LANGS as readonly string[]).includes(main)
    ? [main, ...LANGS.filter((l) => l !== main)]
    : [...LANGS];
  for (const l of order) {
    const t = str(p[`ingredients_text_${l}`]) ?? (main === l ? str(p.ingredients_text) : null);
    if (t) texts.push({ lang: l, text: offEmphasisToCaps(t), supported: true });
  }
  const fallback = str(p.ingredients_text);
  if (fallback && !texts.some((t) => t.text === offEmphasisToCaps(fallback))) {
    texts.push({ lang: main ?? "?", text: offEmphasisToCaps(fallback), supported: false });
  }
  const code = String(p.code ?? "");
  return {
    ean: code,
    name: str(p.product_name_pl) ?? str(p.product_name) ?? str(p.product_name_en) ?? str(p.generic_name),
    brands: str(p.brands),
    quantity: str(p.quantity),
    lang: main,
    image: str(p.image_front_url) ?? str(p.image_front_small_url),
    ingredients_image: str(p.image_ingredients_url),
    nutriscore: str(p.nutriscore_grade),
    nova: typeof p.nova_group === "number" ? p.nova_group : null,
    off_allergens: (p.allergens_tags as string[] | undefined) ?? [],
    off_traces: (p.traces_tags as string[] | undefined) ?? [],
    off_additives: (p.additives_tags as string[] | undefined) ?? [],
    categories: str(p.categories),
    texts,
    off_url: `https://world.openfoodfacts.org/product/${encodeURIComponent(code)}`,
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

async function offProduct(ean: string): Promise<Response> {
  if (!/^\d{8,14}$/.test(ean)) return json(400, { error: "An EAN/GTIN is 8–14 digits." });
  const { status, body } = await offJson(
    `https://world.openfoodfacts.org/api/v2/product/${ean}?fields=${PRODUCT_FIELDS}`,
  );
  if (body?.status === 1 && body.product) return json(200, { found: true, product: toProduct(body.product) });
  if (status === 404 || body?.status === 0) return json(200, { found: false, ean });
  return json(502, { error: `Open Food Facts answered ${status}.` });
}

async function offSearch(q: string, pageNo: number): Promise<Response> {
  if (!q.trim() || q.length > 200) return json(400, { error: "Search text must be 1–200 characters." });
  const u = new URL("https://search.openfoodfacts.org/search");
  u.searchParams.set("q", q.trim());
  u.searchParams.set("langs", "pl,en,de,fr"); // the index has no Polish fields; PL names mostly sit in .en
  u.searchParams.set("page_size", "24");
  u.searchParams.set("page", String(pageNo));
  u.searchParams.set("fields", "code,product_name,brands,quantity,lang");
  const { status, body } = await offJson(u.href);
  if (status !== 200 || !Array.isArray(body?.hits)) {
    return json(502, { error: `Open Food Facts search answered ${status}.` });
  }
  return json(200, {
    page: body.page ?? pageNo,
    page_count: body.page_count ?? 1,
    count: body.count ?? null,
    items: body.hits.map((h: Record<string, unknown>) => ({
      ean: String(h.code ?? ""),
      name: str(h.product_name),
      brands: Array.isArray(h.brands) ? h.brands.join(", ") : str(h.brands),
      quantity: str(h.quantity),
      lang: str(h.lang),
    })),
  });
}

// ---------------------------------------------------------------- server
async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/" && req.method === "GET") {
    return new Response(await Deno.readTextFile(PAGE), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'self'; img-src 'self' https://images.openfoodfacts.org data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'",
      },
    });
  }
  if (API_PATHS.test(url.pathname)) return await toApi(req, url);
  const product = url.pathname.match(/^\/off\/product\/([^/]+)$/);
  if (product && req.method === "GET") return await offProduct(decodeURIComponent(product[1]));
  if (url.pathname === "/off/search" && req.method === "GET") {
    return await offSearch(
      url.searchParams.get("q") ?? "",
      Math.max(1, Number(url.searchParams.get("page")) || 1),
    );
  }
  return json(404, { error: "not found" });
}

Deno.serve({
  hostname: "127.0.0.1",
  port: PORT,
  onListen: ({ port }) =>
    console.log(
      `ns-ingredients explorer on http://127.0.0.1:${port}  (KB ${rt.index.version}, ${rt.index.ingredients.size} ingredients)`,
    ),
}, async (req) => {
  try {
    return await handle(req);
  } catch (e) {
    const timeout = e instanceof DOMException && e.name === "TimeoutError";
    return json(timeout ? 504 : 500, { error: timeout ? "Open Food Facts timed out." : String(e) });
  }
});
