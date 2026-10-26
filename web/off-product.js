// @ts-check
// Open Food Facts product → the explorer's product shape. One copy, used twice: the browser fetches
// products from OFF directly (their product API allows any origin, so each visitor spends their own OFF
// allowance), and the Worker / local explorer use it for the /off/product fallback (src/off/off.ts).
// Plain JS so the page can import it as-is; JSDoc gives the TypeScript side its types.

export const LANGS = /** @type {const} */ (["pl", "en", "de"]);

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
  "categories_tags",
  "nutriments",
  "serving_quantity",
  "serving_quantity_unit",
].join(",");

/**
 * OFF marks allergens as _mleka_; the parser reads CAPS as label emphasis, so carry it over.
 * @param {string} text
 */
export function offEmphasisToCaps(text) {
  return text.replace(/_([^_\n]{1,60})_/g, (_, s) => s.toUpperCase());
}

/**
 * Declared sugars in the API's nutrition shape, or null. OFF keeps liquids per 100 ml in its *_100g fields;
 * a product in en:beverages is read as a drink.
 * @param {any} p
 * @returns {{ basis: "100g" | "100ml"; sugars_g: number; serving?: { amount: number; unit: "g" | "ml" } } | null}
 */
export function toNutrition(p) {
  const sugars = p?.nutriments?.sugars_100g;
  if (typeof sugars !== "number" || !(sugars >= 0 && sugars <= 100)) return null;
  const drink = Array.isArray(p.categories_tags) && p.categories_tags.includes("en:beverages");
  const basis = drink ? "100ml" : "100g";
  const amount = Number(p.serving_quantity);
  const unit = String(p.serving_quantity_unit ?? (drink ? "ml" : "g")).toLowerCase();
  const serving = amount > 0 && amount <= 5000 && unit === basis.slice(3)
    ? { amount, unit: /** @type {"g" | "ml"} */ (unit) }
    : undefined;
  return { basis, sugars_g: sugars, ...(serving ? { serving } : {}) };
}

/** @param {unknown} v */
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** @param {unknown} v */
const tags = (v) => (Array.isArray(v) ? v.filter((t) => typeof t === "string") : []);

/**
 * @param {Record<string, unknown>} p  the `product` object of an OFF v2 product response
 */
export function toProduct(p) {
  const main = str(p.lang);
  /** @type {{ lang: string; text: string; supported: boolean }[]} */
  const texts = [];
  /** @type {readonly string[]} */
  const langs = LANGS;
  const order = main && langs.includes(main) ? [main, ...langs.filter((l) => l !== main)] : [...langs];
  for (const l of order) {
    const t = str(p[`ingredients_text_${l}`]) ?? (main === l ? str(p.ingredients_text) : null);
    if (t) texts.push({ lang: l, text: offEmphasisToCaps(t), supported: true });
  }
  const fallback = str(p.ingredients_text);
  if (fallback && !texts.some((t) => t.text === offEmphasisToCaps(fallback))) {
    texts.push({ lang: main ?? "?", text: offEmphasisToCaps(fallback), supported: false });
  }
  // Contributors sometimes leave a fragment in one language (Nutella's English: "sugar, palm oil", German
  // complete). A supported text with under half the items of the fullest one goes after it.
  /** @param {string} t */
  const count = (t) => t.split(/[,;]/).length;
  const fullest = Math.max(0, ...texts.filter((t) => t.supported).map((t) => count(t.text)));
  /** @param {{ text: string; supported: boolean }} t */
  const rank = (t) => (!t.supported ? 2 : count(t.text) * 2 < fullest ? 1 : 0);
  texts.sort((a, b) => rank(a) - rank(b));
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
    off_allergens: tags(p.allergens_tags),
    off_traces: tags(p.traces_tags),
    off_additives: tags(p.additives_tags),
    categories: str(p.categories),
    nutrition: toNutrition(p),
    texts,
    off_url: `https://world.openfoodfacts.org/product/${encodeURIComponent(code)}`,
  };
}

/**
 * Reads an OFF v2 product response: the product, `null` when OFF does not have it, or throws.
 * @param {number} status
 * @param {any} body
 */
export function readProductResponse(status, body) {
  if (body?.status === 1 && body.product) return toProduct(body.product);
  if (status === 404 || body?.status === 0) return null;
  throw new Error(`Open Food Facts answered ${status}.`);
}

/** @param {string} ean */
export const productUrl = (ean) =>
  `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(ean)}?fields=${PRODUCT_FIELDS}`;
