// The Open Food Facts product mapping the browser and the /off proxy share (web/off-product.js).
import { assertEquals, assertThrows } from "@std/assert";
import { offEmphasisToCaps, productUrl, readProductResponse, toProduct } from "../../web/off-product.js";
import { createOffClient } from "../../src/off/off.ts";

Deno.test("offEmphasisToCaps: OFF's _allergen_ marks become the CAPS the parser reads as emphasis", () => {
  assertEquals(offEmphasisToCaps("mąka _pszenna_, _mleko_ w proszku"), "mąka PSZENNA, MLEKO w proszku");
  assertEquals(offEmphasisToCaps("snake_case_name"), "snakeCASEname", "only paired marks within a line");
});

Deno.test("toProduct: the product's own language first, then pl/en/de; another language is kept as unsupported", () => {
  const p = toProduct({
    code: "5900000000001",
    lang: "de",
    product_name: "Riegel",
    ingredients_text: "Zucker, _Milch_",
    ingredients_text_pl: "cukier, _mleko_",
    allergens_tags: ["en:milk", 7],
  });
  assertEquals(p.texts.map((t) => t.lang), ["de", "pl"]);
  assertEquals(p.texts[0].text, "Zucker, MILCH");
  assertEquals(p.off_allergens, ["en:milk"], "non-string tags dropped");

  const nutella = toProduct({
    code: "3017620422003",
    lang: "en",
    ingredients_text: "sugar, palm oil",
    ingredients_text_en: "sugar, palm oil",
    ingredients_text_de: "Zucker, Palmöl, HASELNÜSSE 13 %, MAGERMILCHPULVER 8,7 %, fettarmer Kakao, Vanillin",
  });
  assertEquals(nutella.texts.map((t) => t.lang), ["de", "en"], "a fragment goes after the fullest text");

  const fr = toProduct({ code: "1", lang: "fr", ingredients_text: "sucre, lait" });
  assertEquals(fr.texts, [{ lang: "fr", text: "sucre, lait", supported: false }]);
  assertEquals(fr.name, null);
});

Deno.test("readProductResponse: found, not found (404 or status 0), anything else throws", () => {
  assertEquals(readProductResponse(200, { status: 1, product: { code: "42" } })?.ean, "42");
  assertEquals(readProductResponse(404, { status: 0 }), null);
  assertEquals(readProductResponse(200, { status: 0 }), null);
  assertThrows(() => readProductResponse(503, null), Error, "answered 503");
  assertEquals(
    productUrl("5449000000996"),
    `https://world.openfoodfacts.org/api/v2/product/5449000000996?fields=${
      new URL(productUrl("1")).searchParams.get("fields")
    }`,
  );
});

Deno.test("the /off/product proxy answers with the same mapping the browser uses", async () => {
  const realFetch = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push(url);
    const body = url.includes("/5449000000996")
      ? { status: 1, product: { code: "5449000000996", lang: "en", ingredients_text_en: "water, sugar" } }
      : { status: 0 };
    return Promise.resolve(new Response(JSON.stringify(body), { status: body.status ? 200 : 404 }));
  };
  try {
    const off = createOffClient("test");
    const hit = await (await off.product("5449000000996")).json();
    assertEquals(hit.found, true);
    assertEquals(hit.product.texts, [{ lang: "en", text: "water, sugar", supported: true }]);
    assertEquals(seen[0], productUrl("5449000000996"));
    assertEquals(await (await off.product("4000000000000")).json(), { found: false, ean: "4000000000000" });
    assertEquals((await off.product("12ab")).status, 400);
  } finally {
    globalThis.fetch = realFetch;
  }
});
