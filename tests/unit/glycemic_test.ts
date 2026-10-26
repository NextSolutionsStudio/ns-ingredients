import { assert, assertEquals } from "@std/assert";
import { analyze } from "../../src/core/analyze.ts";
import { estimateGlycemicLoad, type GiCarrier } from "../../src/core/nutrition.ts";
import { AnalysisResponse } from "../../src/http/schemas.ts";
import { fixtureIndex } from "../helpers.ts";

const idx = await fixtureIndex();
const src = "gi-dodd-2011";
const sucrose: GiCarrier = {
  ingredient_id: "sugar",
  glycemic: [{ range: [65, 65], fraction: "sugars", method: "iso", source: src }],
};
const maltodextrin: GiCarrier = {
  ingredient_id: "maltodextrin",
  glycemic: [{ range: [85, 105], fraction: "starch", method: "non_iso", source: src }],
};

Deno.test("GL is grams × GI / 100 per fraction, summed, as a range; bands per serving", () => {
  // Per 40 g serving: 20 g sugars at GI 65, 16 g starch at GI 85–105.
  const gl = estimateGlycemicLoad(
    { basis: "100g", sugars_g: 50, carbohydrate_g: 90, serving: { amount: 40, unit: "g" } },
    [sucrose, maltodextrin],
    "en",
  )!;
  assertEquals([gl.status, gl.per, gl.range, gl.band, gl.coverage], ["estimated", "serving", [26.6, 29.8], [
    "high",
    "high",
  ], 1]);
  assertEquals(gl.fractions.map((f) => [f.fraction, f.grams, f.gi, f.from]), [
    ["sugars", 20, [65, 65], ["sugar"]],
    ["starch", 16, [85, 105], ["maltodextrin"]],
  ]);
  assertEquals([gl.kind, gl.grade, gl.method], ["estimate", "D", "gl-weighted-range/1"]);
});

Deno.test("a fraction with no GI source widens the range as GI 0–100 and lowers coverage", () => {
  // 4 g of starch per serving has no source: coverage 50/60, range 13 → 13 + 4.
  const gl = estimateGlycemicLoad(
    { basis: "100g", sugars_g: 50, carbohydrate_g: 60, serving: { amount: 40, unit: "g" } },
    [sucrose],
    "en",
  )!;
  assertEquals([gl.range, gl.band, gl.coverage], [[13, 17], ["medium", "medium"], 0.83]);
  assert(gl.assumptions.some((a) => a.startsWith("17% of the carbohydrate has no GI source")));
});

Deno.test("below 70% coverage, or total carbohydrate without fibre, the estimate is unknown", () => {
  const low = estimateGlycemicLoad({ basis: "100g", sugars_g: 50, carbohydrate_g: 90 }, [sucrose], "en")!;
  assertEquals([low.status, low.reason, low.range, low.coverage], ["unknown", "low_coverage", null, 0.56]);
  const us = estimateGlycemicLoad(
    { basis: "100g", sugars_g: 10, carbohydrate_g: 60, carbohydrate_definition: "total" },
    [sucrose],
    "en",
  )!;
  assertEquals([us.status, us.reason], ["unknown", "fibre_needed"]);
  // With fibre, total carbohydrate becomes available carbohydrate.
  const usOk = estimateGlycemicLoad(
    { basis: "100g", sugars_g: 10, carbohydrate_g: 20, fibre_g: 10, carbohydrate_definition: "total" },
    [sucrose],
    "en",
  )!;
  assertEquals([usOk.status, usOk.coverage, usOk.per, usOk.band], ["estimated", 1, "100g", null]);
});

Deno.test("no carbohydrate declared: no GL block", () => {
  assertEquals(estimateGlycemicLoad({ basis: "100g", sugars_g: 10 }, [sucrose], "en"), null);
});

Deno.test("a high GL flags as a sensitivity: it heads the danger summary only when the profile asks", () => {
  const text = "Skład: syrop glukozowy, cukier";
  const nutrition = {
    basis: "100g" as const,
    sugars_g: 60,
    carbohydrate_g: 95,
    serving: { amount: 50, unit: "g" as const },
  };
  const plain = analyze(idx, text, { nutrition });
  AnalysisResponse.parse(plain);
  const f = plain.flags.find((x) => x.code === "health.high_glycemic_load")!;
  assertEquals([f.concern, f.kind, f.grade, f.triggers[0].path], [
    "sensitivity",
    "estimate",
    "D",
    "nutrition.carbohydrate_g",
  ]);
  assertEquals(plain.nutrition?.glycemic_load?.fractions.map((x) => x.from), [["glucose-syrup", "sugar"], [
    "glucose-syrup",
  ]]);
  // high_sugar (a hazard) is what sets the headline here; GL alone is personal.
  assertEquals(plain.summary.danger, "caution");
  const lowSugar = { ...nutrition, sugars_g: 4 };
  assertEquals(analyze(idx, text, { nutrition: lowSugar }).summary.danger, null);
  const mine = analyze(idx, text, { nutrition: lowSugar, profile: { avoid: ["health.high_glycemic_load"] } });
  assertEquals(mine.summary.danger, "notice");
  assert(mine.profile?.hits.some((h) => h.code === "health.high_glycemic_load"));
  assert(mine.sources["gi-dodd-2011"]);
});

Deno.test("an uncertain range never raises the flag", () => {
  // 15 g of sugars per 30 g serving at GI 61–69: GL 9.2–10.4, nowhere near wholly high.
  const r = analyze(idx, "Skład: cukier", {
    nutrition: { basis: "100g", sugars_g: 50, carbohydrate_g: 50, serving: { amount: 30, unit: "g" } },
  });
  assertEquals(r.nutrition?.glycemic_load?.status, "estimated");
  assertEquals(r.flags.some((x) => x.code === "health.high_glycemic_load"), false);
});
