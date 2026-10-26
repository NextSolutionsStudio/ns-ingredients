// Open Food Facts lookups for the explorer UI: a product by EAN, or a text search. Shared by the local
// explorer (scripts/explorer.ts) and the Cloudflare Worker (src/worker.ts). Product data is Open Food
// Facts' (ODbL) and is shown as theirs, not ours. Runtime-neutral: fetch, Map and AbortSignal only.

const LANGS = ["pl", "en", "de"] as const;
const TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 300;

export const PRODUCT_FIELDS = [
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

/** OFF marks allergens as _mleka_; the parser reads CAPS as label emphasis, so carry it over. */
export function offEmphasisToCaps(text: string): string {
  return text.replace(/_([^_\n]{1,60})_/g, (_, s: string) => s.toUpperCase());
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

export function toProduct(p: Record<string, unknown>) {
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

export interface OffClient {
  /** GET /off/product/:ean */
  product(ean: string): Promise<Response>;
  /** GET /off/search?q=&page= */
  search(q: string, page: number): Promise<Response>;
}

/** `userAgent` identifies us to OFF, as their API terms ask. */
export function createOffClient(userAgent: string): OffClient {
  const cache = new Map<string, { at: number; status: number; body: any }>();

  async function offJson(url: string): Promise<{ status: number; body: any }> {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit;
    const res = await fetch(url, {
      headers: { "user-agent": userAgent, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
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

  return {
    async product(ean) {
      if (!/^\d{8,14}$/.test(ean)) return json(400, { error: "An EAN/GTIN is 8–14 digits." });
      const { status, body } = await offJson(
        `https://world.openfoodfacts.org/api/v2/product/${ean}?fields=${PRODUCT_FIELDS}`,
      );
      if (body?.status === 1 && body.product) {
        return json(200, { found: true, product: toProduct(body.product) });
      }
      if (status === 404 || body?.status === 0) return json(200, { found: false, ean });
      return json(502, { error: `Open Food Facts answered ${status}.` });
    },

    async search(q, pageNo) {
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
    },
  };
}

/** Routes /off/product/:ean and /off/search; null for any other path. */
export async function routeOff(client: OffClient, req: Request, url: URL): Promise<Response | null> {
  if (req.method !== "GET") return null;
  const product = url.pathname.match(/^\/off\/product\/([^/]+)$/);
  try {
    if (product) return await client.product(decodeURIComponent(product[1]));
    if (url.pathname === "/off/search") {
      return await client.search(
        url.searchParams.get("q") ?? "",
        Math.max(1, Number(url.searchParams.get("page")) || 1),
      );
    }
  } catch (e) {
    const timeout = e instanceof DOMException && e.name === "TimeoutError";
    return json(timeout ? 504 : 502, {
      error: timeout ? "Open Food Facts timed out." : "Open Food Facts failed.",
    });
  }
  return null;
}
