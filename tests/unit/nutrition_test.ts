import { assert, assertEquals, assertFalse } from "@std/assert";
import { analyze } from "../../src/core/analyze.ts";
import { assessNutrition } from "../../src/core/nutrition.ts";
import { AnalysisResponse, AnalyzeRequest } from "../../src/http/schemas.ts";
import { fixtureIndex } from "../helpers.ts";

const idx = await fixtureIndex();

Deno.test("sugar bands follow the UK front-of-pack tables, edges included", () => {
  const band = (basis: "100g" | "100ml", sugars_g: number) =>
    assessNutrition({ basis, sugars_g }).sugars.band;
  assertEquals([band("100g", 5), band("100g", 5.1), band("100g", 22.5), band("100g", 22.6)], [
    "low",
    "medium",
    "medium",
    "high",
  ]);
  assertEquals([band("100ml", 2.5), band("100ml", 11.25), band("100ml", 11.3)], ["low", "medium", "high"]);
});

Deno.test("the portion rule applies only to large portions, and RI is 90 g", () => {
  // 12 g/100 g is medium per 100 g; a 250 g portion holds 30 g, over the 27 g portion threshold.
  const big = assessNutrition({ basis: "100g", sugars_g: 12, serving: { amount: 250, unit: "g" } }).sugars;
  assertEquals([big.band, big.band_by, big.per_serving, big.ri_percent_per_serving], [
    "high",
    "per_portion",
    30,
    33,
  ]);
  // The same 30 g in a 100 g portion: the rule does not apply (portions over 100 g only).
  const small = assessNutrition({ basis: "100g", sugars_g: 30, serving: { amount: 100, unit: "g" } }).sugars;
  assertEquals([small.band, small.band_by], ["high", "per_100"]);
  const drink = assessNutrition({ basis: "100ml", sugars_g: 6, serving: { amount: 330, unit: "ml" } }).sugars;
  assertEquals([drink.band, drink.per_serving], ["high", 19.8]);
});

Deno.test("declared nutrition raises health.high_sugar, which heads the danger summary without ranking a label item", () => {
  const r = analyze(idx, "Skład: mleko w proszku, cukier", {
    nutrition: { basis: "100g", sugars_g: 48 },
  });
  AnalysisResponse.parse(r);
  const f = r.flags.find((x) => x.code === "health.high_sugar")!;
  assertEquals([f.severity, f.concern, f.kind], ["caution", "hazard", "fact"]);
  assertEquals(f.triggers[0].basis, "nutrition");
  assertEquals(f.triggers[0].ingredient_id, undefined);
  assert(f.triggers[0].note.includes("22,5 g"), f.triggers[0].note); // Polish number format
  assertEquals(r.summary.danger, "caution");
  assertFalse(r.ranking.some((x) => x.path.startsWith("nutrition")));
  assertEquals(r.nutrition?.sugars.band, "high");
  assert(r.sources["nut-uk-fop-2016"]);
});

Deno.test("no nutrition sent: no block, no flag; medium sugars: block, no flag", () => {
  const none = analyze(idx, "Ingredients: sugar");
  assertEquals(none.nutrition, null);
  const medium = analyze(idx, "Ingredients: sugar", { nutrition: { basis: "100ml", sugars_g: 4 } });
  assertEquals(medium.nutrition?.sugars.band, "medium");
  assertFalse(medium.flags.some((x) => x.code === "health.high_sugar"));
});

Deno.test("a serving unit that contradicts the basis is rejected", () => {
  const bad = AnalyzeRequest.safeParse({
    text: "x",
    nutrition: { basis: "100g", sugars_g: 10, serving: { amount: 250, unit: "ml" } },
  });
  assertFalse(bad.success);
  assert(AnalyzeRequest.safeParse({ text: "x", nutrition: { basis: "100ml", sugars_g: 10 } }).success);
  assertFalse(AnalyzeRequest.safeParse({ text: "x", nutrition: { basis: "100g", sugars_g: 120 } }).success);
});
