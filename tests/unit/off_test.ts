// The Open Food Facts product mapping the browser and the /off proxy share (web/off-product.js).
import { assert, assertEquals, assertThrows } from "@std/assert";
import { productUrl, readProductResponse, toNutrition, toProduct } from "../../web/off-product.js";
import { createOffClient } from "../../src/off/off.ts";
import { analyze } from "../../src/core/analyze.ts";
import { fixtureIndex } from "../helpers.ts";

Deno.test("toProduct keeps OFF's _allergen_ marks; the parser reads them, also on an all-caps label", async () => {
  const p = toProduct({
    code: "5900000000002",
    lang: "pl",
    ingredients_text_pl: "SKŁAD: CUKIER, _PSZENNA_, SÓL",
  });
  assertEquals(p.texts[0].text, "SKŁAD: CUKIER, _PSZENNA_, SÓL");
  // Turned into capitals, the mark would vanish under the all-caps rule; read as a mark, it stays.
  const r = analyze(await fixtureIndex(), p.texts[0].text, { lang: "pl" });
  assertEquals(r.items[1].emphasized, ["PSZENNA"]);
  assert(r.flags.some((f) => f.code === "allergen.unrecognised_emphasis"));
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
  assertEquals(p.texts[0].text, "Zucker, _Milch_");
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

Deno.test("toNutrition: OFF sugars become the API's nutrition input; drinks read per 100 ml", () => {
  assertEquals(
    toNutrition({ nutriments: { sugars_100g: 56.3 }, serving_quantity: 15, serving_quantity_unit: "g" }),
    {
      basis: "100g",
      sugars_g: 56.3,
      serving: { amount: 15, unit: "g" },
    },
  );
  assertEquals(
    toNutrition({
      nutriments: { sugars_100g: 10.6 },
      categories_tags: ["en:beverages"],
      serving_quantity: 330,
    }),
    { basis: "100ml", sugars_g: 10.6, serving: { amount: 330, unit: "ml" } },
  );
  // A serving in the wrong unit is dropped rather than converted; missing or junk sugars give null.
  assertEquals(
    toNutrition({ nutriments: { sugars_100g: 5 }, serving_quantity: 250, serving_quantity_unit: "ml" }),
    {
      basis: "100g",
      sugars_g: 5,
    },
  );
  assertEquals(toNutrition({ nutriments: {} }), null);
  assertEquals(toNutrition({ nutriments: { sugars_100g: "12" } }), null);
});

Deno.test("toNutrition: carbohydrate, polyols and fibre pass through; a carbohydrate below sugars is dropped", () => {
  assertEquals(
    toNutrition({ nutriments: { sugars_100g: 20, carbohydrates_100g: 60, polyols_100g: 5, fiber_100g: 3 } }),
    {
      basis: "100g",
      sugars_g: 20,
      carbohydrate_g: 60,
      polyols_g: 5,
      fibre_g: 3,
    },
  );
  assertEquals(toNutrition({ nutriments: { sugars_100g: 20, carbohydrates_100g: 12 } }), {
    basis: "100g",
    sugars_g: 20,
  });
});
