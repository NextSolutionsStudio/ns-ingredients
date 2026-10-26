import { assert, assertEquals, assertFalse } from "@std/assert";
import { analyze, ingredientDietStatus } from "../../src/core/analyze.ts";
import { distinctivePartsAgree } from "../../src/core/kb-index.ts";
import type { IngredientT } from "../../src/kb/schema.ts";
import { AnalysisResponse } from "../../src/http/schemas.ts";
import { fixtureIndex } from "../helpers.ts";

const idx = await fixtureIndex();
const run = (text: string, opts: Parameters<typeof analyze>[2] = {}) => {
  const r = analyze(idx, text, opts);
  AnalysisResponse.parse(r); // every analysis satisfies the published contract
  return r;
};
const flag = (r: ReturnType<typeof run>, code: string) => r.flags.find((f) => f.code === code);

Deno.test("silent label → malic acid variant comes from the prior, flagged as an estimate", () => {
  const r = run("Skład: cukier, kwas jabłkowy");
  const item = r.items[1];
  assertEquals(item.match?.ingredient_id, "malic-acid");
  assertEquals(item.variant?.basis, "prior");
  assertEquals(item.variant?.candidates?.[0], { id: "dl", probability: 0.8 });
  const f = flag(r, "origin.petrochemical_synthetic")!;
  assertEquals(f.certainty, "maybe");
  assertEquals(f.kind, "estimate");
  assertEquals(f.triggers[0].basis, "prior_variant");
  assertEquals(f.triggers[0].probability, 0.8);
  // The minority variant (p = 0.2) raises nothing.
  assertEquals(flag(r, "origin.microbial_fermentation"), undefined);
});

Deno.test("label tell 'L-' selects the variant: no petrochemical flag", () => {
  const r = run("Skład: kwas L-jabłkowy");
  assertEquals(r.items[0].variant, { basis: "label", id: "l", name: "kwas L-jabłkowy" }); // Polish label → Polish name
  assertEquals(flag(r, "origin.petrochemical_synthetic"), undefined);
  assertEquals(flag(r, "origin.microbial_fermentation")?.triggers[0].basis, "label_variant");
});

Deno.test("label tell 'DL-' makes the petrochemical origin a fact", () => {
  const r = run("Ingredients: DL-malic acid");
  assertEquals(r.items[0].variant?.id, "dl");
  const f = flag(r, "origin.petrochemical_synthetic")!;
  assertEquals([f.certainty, f.kind, f.grade], ["yes", "fact", "A"]);
});

Deno.test("E-number alone resolves the additive", () => {
  const r = run("Skład: woda, E296, E 322");
  assertEquals(r.items[1].match?.ingredient_id, "malic-acid");
  assertEquals(r.items[1].match?.match_type, "e_number");
  assertEquals(r.items[2].match?.ingredient_id, "lecithins");
});

Deno.test("an E-number inside a compound is analysed as its own ingredient, not as the compound", () => {
  const r = run("Skład: czekolada (cukier, E955, E471), sól");
  const choc = r.items[0];
  const e955 = choc.children[1];
  assertEquals(choc.match, null);
  assertEquals([e955.role, e955.match?.ingredient_id], ["ingredient", "sucralose"]);
  // Sucralose's own facts reach the analysis, attributed to the part and not to the chocolate.
  assertEquals(flag(r, "origin.chemical_synthesis")?.triggers.map((t) => t.path), [e955.path]);
  // …and an E-number part's diet status counts: E471 of undisclosed source keeps "vegan" at maybe.
  const e471 = choc.children[2];
  assertEquals(r.diets.vegan.because.find((b) => b.path === e471.path), {
    path: e471.path,
    ingredient_id: "mono-and-diglycerides",
    status: "maybe",
  });
});

Deno.test("source qualifier '(z soi)' picks the soy lecithin variant and adds the soy allergen", () => {
  const r = run("Skład: kakao, emulgator: lecytyny (z soi)");
  const lec = r.items[1];
  assertEquals(lec.function?.id, "emulsifier");
  assertEquals(lec.variant, { basis: "label", id: "soy", name: "lecytyna sojowa" });
  const soy = flag(r, "allergen.soybeans")!;
  assertEquals(soy.certainty, "yes");
  assert(soy.triggers.some((t) => t.basis === "label_variant"));
  assert(soy.triggers.some((t) => t.basis === "qualifier"));
});

Deno.test("sunflower lecithin by tell: no soy allergen", () => {
  const r = run("Skład: lecytyna słonecznikowa");
  assertEquals(r.items[0].variant?.id, "sunflower");
  assertEquals(flag(r, "allergen.soybeans"), undefined);
});

Deno.test("CAPS emphasis carries the allergen even when the ingredient is unknown", () => {
  const r = run("Skład: serwatka w proszku (z MLEKA)");
  assertEquals(r.items[0].match, null);
  const milk = flag(r, "allergen.milk")!;
  assert(milk.triggers.some((t) => t.basis === "qualifier" || t.basis === "emphasis"));
});

Deno.test("four-state diets: E471 undisclosed → vegan maybe; plant tell → yes; carmine → no", () => {
  assertEquals(run("Skład: cukier, mono- i diglicerydy kwasów tłuszczowych").diets.vegan.status, "maybe");
  assertEquals(
    run("Skład: cukier, mono- i diglicerydy kwasów tłuszczowych (pochodzenia roślinnego)").diets.vegan.status,
    "yes",
  );
  const carmine = run("Skład: cukier, barwnik: karmin");
  assertEquals(carmine.diets.vegan.status, "no");
  assertEquals(carmine.diets.vegetarian.status, "no");
  assertEquals(carmine.diets.vegan.because[0], { path: "2", ingredient_id: "carmine", status: "no" });
});

Deno.test("dairy is vegetarian but not vegan; unknown ingredient → unknown", () => {
  const r = run("Skład: koncentrat białka serwatkowego, cukier");
  assertEquals(r.diets.vegan.status, "no");
  assertEquals(r.diets.vegetarian.status, "yes");
  assertEquals(r.diets.lactose_free.status, "no");
  assertEquals(r.diets.gluten_free.status, "yes");
  const u = run("Skład: cukier, tajemniczy składnik xyz");
  assertEquals(u.diets.vegan.status, "unknown");
  assertEquals(u.diets.gluten_free.status, "unknown");
});

Deno.test("class header applies only to items that have that function", () => {
  const r = run("Skład: emulgatory: lecytyny, E471, cukier");
  assertEquals(r.items[0].function?.id, "emulsifier");
  assertEquals(r.items[1].function?.id, "emulsifier"); // E471 inherits
  assertEquals(r.items[2].function, undefined); // sugar does not
});

Deno.test("'barwnik (E120)': a class name with the additive inside the brackets", () => {
  const r = run("Skład: cukier, barwnik (E120)");
  assertEquals(r.items[1].role, "class");
  assertEquals(r.items[1].match?.ingredient_id, "carmine");
  assertEquals(r.items[1].function?.id, "colour");
  assertEquals(r.diets.vegan.status, "no");
});

Deno.test("precautionary allergens are traces, not ingredients", () => {
  const r = run("Skład: cukier. Może zawierać orzechy laskowe i soję.");
  assertEquals(r.may_contain.map((m) => m.ingredient_id), ["hazelnuts", "soybeans"]);
  assertEquals(r.may_contain[0].allergens, ["allergen.nuts"]);
  assertEquals(flag(r, "allergen.nuts"), undefined);
});

Deno.test("profile is evaluated statelessly: flags, traces and diets", () => {
  const r = run("Skład: koncentrat białka serwatkowego, olej palmowy. Może zawierać orzechy laskowe.", {
    profile: { avoid: ["allergen.*", "ethics.palm_oil"], diets: ["vegan", "gluten_free"] },
  });
  const hits = Object.fromEntries(r.profile!.hits.map((h) => [h.code, h]));
  assertEquals(hits["allergen.milk"].trace, false);
  assertEquals(hits["allergen.milk"].paths, ["1"]);
  assertEquals(hits["ethics.palm_oil"].certainty, "yes");
  assertEquals(hits["allergen.nuts"].trace, true);
  assertEquals(r.profile!.diets, [{ diet: "vegan", status: "no" }]); // gluten_free is yes → not listed
});

Deno.test("health flags keep population qualifiers and regulatory statements", () => {
  const r = run("Ingredients: sugar, sunset yellow FCF, aspartame. Contains a source of phenylalanine.");
  assertEquals(flag(r, "health.southampton_colour")!.triggers[0].population, ["children"]);
  assertEquals(flag(r, "health.phenylalanine_source")!.triggers[0].population, ["pku"]);
  assertEquals(r.label_statements, ["phenylalanine"]);
  assertEquals(r.summary.caution, 2);
  assertEquals(r.summary.highest, "caution");
});

Deno.test("flags are ordered by severity then certainty; sources are resolved", () => {
  const r = run("Skład: mleko, olej palmowy, sukraloza");
  const sev = r.flags.map((f) => f.severity);
  const rank = { info: 0, notice: 1, caution: 2, warning: 3 };
  for (let i = 1; i < sev.length; i++) assert(rank[sev[i - 1]] >= rank[sev[i]]);
  assertEquals(r.flags[0].code, "allergen.milk");
  for (const f of r.flags) {
    for (const t of f.triggers) for (const s of t.sources) assert(r.sources[s.id], s.id);
  }
});

Deno.test("fuzzy match tolerates OCR typos; nonsense stays unmatched", () => {
  const r = run("Skład: sukralosa, qqqqzzzz");
  assertEquals(r.items[0].match?.ingredient_id, "sucralose");
  assertEquals(r.items[0].match?.match_type, "fuzzy");
  assert(r.items[0].match!.confidence < 1);
  assertEquals(r.items[1].match, null);
  assertEquals(r.coverage, { ingredients: 2, matched: 1, low_confidence: 1, ratio: 0.5 });
});

Deno.test("longest known sub-phrase wins inside a longer description", () => {
  const r = run("Skład: koncentrat białka serwatkowego instantyzowany");
  assertEquals(r.items[0].match?.ingredient_id, "whey-protein-concentrate");
  assertEquals(r.items[0].match?.match_type, "sub_phrase");
});

Deno.test("AI-drafted content is disclosed; language follows the label", () => {
  assert(run("Skład: kwas jabłkowy").ai_generated_content);
  assertFalse(run("Skład: cukier").ai_generated_content);
  assertEquals(run("Zutaten: Zucker").lang, "de");
  assertEquals(run("Zutaten: Zucker", { lang: "pl" }).lang, "pl");
  assert(run("Skład: cukier").disclaimer.startsWith("Wyłącznie informacyjnie"));
});

Deno.test("empty or junk input returns an empty, valid analysis", () => {
  for (const text of ["", "   ", "Skład:", "!!!", "Przechowywać w suchym miejscu."]) {
    const r = run(text);
    assertEquals(r.flags, []);
    assertEquals(r.coverage.ratio, 0);
  }
});

Deno.test("fuzzy guard: names that agree only on a counter-ion or 'acid' are not similar", () => {
  assertFalse(distinctivePartsAgree("kazeinian sodu", "jablczany sodu")); // sodium caseinate ≠ sodium malates
  assertFalse(distinctivePartsAgree("kwas cytrynowy", "kwas jablkowy"));
  assert(distinctivePartsAgree("kwas askorbinowy", "kwas l askorbinowy"));
  assert(distinctivePartsAgree("dipotassium phosphate", "potassium phosphates")); // no shared generic token
  assert(distinctivePartsAgree("sukralosa", "sukraloza"));
});

Deno.test("a compound item is described by its parts, never fuzzy-matched by its header", () => {
  const r = run("Ingredients: Sugars (sugar, wheat)");
  assertEquals(r.items[0].match, null); // "sugars" is one letter from "sugar"
  assertEquals(r.items[0].children.map((c) => c.match?.ingredient_id), ["sugar", "wheat"]);
});

Deno.test("bracketed parts lean on the parent noun: 'Vegetable oils (palm)' is palm oil", () => {
  for (
    const text of [
      "Ingredients: Vegetable oils (palm, rapeseed)",
      "Skład: oleje roślinne (palmowy)",
      "Zutaten: Pflanzenöle (Palm)",
    ]
  ) {
    const r = run(text);
    assertEquals(r.items[0].children[0].match?.ingredient_id, "palm-oil", text);
    assertEquals(flag(r, "ethics.palm_oil")?.certainty, "yes", text);
  }
  // Without an oil parent the bare word stays unmatched.
  assertEquals(run("Ingredients: Fruits (palm)").items[0].children[0].match, null);
});

Deno.test("a blend the label spells out applies every named variant as a fact", () => {
  const r = run("Skład: emulgator: lecytyny (soja, słonecznik)");
  const v = r.items[0].variant!;
  assertEquals(v.basis, "label");
  assertEquals(v.candidates?.map((c) => c.id).sort(), ["soy", "sunflower"]);
  const soy = flag(r, "allergen.soybeans")!;
  assertEquals(soy.certainty, "yes");
  assert(soy.triggers.some((t) => t.basis === "label_variant" && t.variant_id === "soy"));
  // "słonecznik" names the lecithin's source; it is not an unknown ingredient.
  assertEquals(r.items[0].children[1].role, "qualifier");
  assert(!r.diets.vegan.because.some((b) => b.path === "1.2"));
});

Deno.test("diets: only the top prior (≥ 0.5) speaks for a silent label, and only as doubt", () => {
  const n = { en: "x" };
  const s = [{ id: "reg-1169-2011" }];
  const ing: IngredientT = {
    id: "test-syrup",
    type: "ingredient",
    names: { en: ["test syrup"] },
    variants: [
      { id: "common", process: n, prior: 0.9, prior_rationale: n },
      { id: "rare", process: n, prior: 0.1, prior_rationale: n },
    ],
    assertions: [
      {
        code: "diet.gluten_free",
        variant: "rare",
        certainty: "maybe",
        kind: "estimate",
        grade: "C",
        note: n,
        sources: s,
      },
      {
        code: "diet.vegan",
        variant: "common",
        certainty: "no",
        kind: "fact",
        grade: "A",
        note: n,
        sources: s,
      },
      { code: "origin.plant", certainty: "yes", kind: "fact", grade: "A", note: n, sources: s },
    ],
    review_status: "draft",
    provenance: "human",
  };
  // The 10% variant's doubt does not reach a silent label…
  assertEquals(ingredientDietStatus("gluten_free", ing, "prior", ["common"]), "yes");
  // …but a label that names it does.
  assertEquals(ingredientDietStatus("gluten_free", ing, "label", ["rare"]), "maybe");
  // The top prior's "no" is only doubt until the label confirms it.
  assertEquals(ingredientDietStatus("vegan", ing, "prior", ["common"]), "maybe");
  assertEquals(ingredientDietStatus("vegan", ing, "label", ["common"]), "no");
});

Deno.test("diets: vegan implies vegetarian, not vegetarian implies not vegan", () => {
  const n = { en: "x" };
  const s = [{ id: "reg-1169-2011" }];
  const base = {
    type: "ingredient" as const,
    names: { en: ["x"] },
    review_status: "draft" as const,
    provenance: "human" as const,
  };
  const vegan: IngredientT = {
    ...base,
    id: "a",
    assertions: [{ code: "diet.vegan", certainty: "yes", kind: "fact", grade: "A", note: n, sources: s }],
  };
  const meat: IngredientT = {
    ...base,
    id: "b",
    assertions: [{ code: "diet.vegetarian", certainty: "no", kind: "fact", grade: "A", note: n, sources: s }],
  };
  assertEquals(ingredientDietStatus("vegetarian", vegan), "yes");
  assertEquals(ingredientDietStatus("vegan", meat), "no");
});

Deno.test("fuzzy guard in the matcher: 'kazeinian sodu' is not E350", () => {
  assertEquals(run("Skład: kazeinian sodu").items[0].match, null);
  assertEquals(run("Skład: maleinian sodu").items[0].match?.ingredient_id, "e350");
});

Deno.test("a silent label below the prior threshold raises nothing; the label naming it does", () => {
  assertEquals(flag(run("Skład: tłuszcz roślinny w proszku"), "ethics.palm_oil"), undefined);
  assertEquals(
    flag(run("Skład: tłuszcz roślinny w proszku (olej palmowy)"), "ethics.palm_oil")?.certainty,
    "yes",
  );
});

Deno.test("a minority prior's diet doubt stays off a silent label (exempt wheat glucose syrup)", () => {
  assertEquals(run("Skład: syrop glukozowy").diets.gluten_free.status, "yes");
  assertEquals(run("Skład: syrop glukozowy pszenny").diets.gluten_free.status, "maybe");
});
