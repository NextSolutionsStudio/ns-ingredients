// Open Food Facts lookups for the explorer UI: a product by EAN, or a text search. Shared by the local
// explorer (scripts/explorer.ts) and the Cloudflare Worker (src/worker.ts). Product data is Open Food
// Facts' (ODbL) and is shown as theirs, not ours. Runtime-neutral: fetch, Map and AbortSignal only.
// The product mapping lives in web/off-product.js, which the browser imports too.

import { productUrl, readProductResponse } from "../../web/off-product.js";

export { offEmphasisToCaps, PRODUCT_FIELDS, toProduct } from "../../web/off-product.js";

const TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 300;

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

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
      const { status, body } = await offJson(productUrl(ean));
      let product;
      try {
        product = readProductResponse(status, body);
      } catch (e) {
        return json(502, { error: (e as Error).message });
      }
      return product ? json(200, { found: true, product }) : json(200, { found: false, ean });
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
