// A variant that a sub-phrase names keeps the match only when one of its tells fires on the item: the tells carry the
// KB's negation guards, so an exclusion that names a variant ("without using partially hydrogenated rapeseed oil")
// does not select it. Such a denied name reads like a claim: nothing that starts inside it is read, so the plain food
// inside it is not asserted either (#15).
import { assertEquals } from "@std/assert";
import { type DeniedName, KbIndex } from "../../src/core/kb-index.ts";
import { analyze } from "../../src/core/analyze.ts";
import type { KbBundle } from "../../src/kb/schema.ts";

// A tell that a negator earlier in the item blocks, as b2's hydrogenation tells do.
const PH = "^(?!.*\\b(?:without|no|bez|nie)\\b).*\\bpartially hydrogenated\\b";

function index(tells = [PH]): KbIndex {
  return new KbIndex({
    version: "t",
    counts: {},
    implications: [],
    sources: [],
    classes: [],
    ingredients: [
      {
        id: "rapeseed-oil",
        names: { en: ["rapeseed oil"] },
        variants: [
          {
            id: "partially-hydrogenated",
            names: { en: ["partially hydrogenated rapeseed oil"] },
            process: { en: "p" },
            tells,
          },
          { id: "cold-pressed", names: { en: ["cold pressed rapeseed oil"] }, process: { en: "p" } },
        ],
      },
      { id: "sugar", names: { en: ["sugar"] } },
    ],
  } as unknown as KbBundle);
}

Deno.test("a negated variant name does not select the variant (Sol 6.1 on #10 at 24baa76)", () => {
  for (
    const text of [
      "without using partially hydrogenated rapeseed oil",
      "without added partially hydrogenated rapeseed oil",
      "without the addition of partially hydrogenated rapeseed oil",
    ]
  ) {
    // neither the variant nor the plain oil inside its name: with no claim name to reach, nothing
    assertEquals(index().match(text), null, text);
  }
  // as a bracket child too: not the hydrogenated variant, and not a second rapeseed oil
  const r = analyze(
    index(),
    "Ingredients: rapeseed oil (without using partially hydrogenated rapeseed oil), sugar",
    {
      lang: "en",
    },
  );
  const child = r.items[0].children?.[0];
  assertEquals(child?.match, null);
  assertEquals(r.flags.some((f) => f.code === "processing.hydrogenated"), false);
});

Deno.test("an affirmative variant name still selects the variant", () => {
  const m = index().match("bio partially hydrogenated rapeseed oil");
  assertEquals([m?.variantId, m?.matchType], ["partially-hydrogenated", "sub_phrase"]);
  // the whole item is the name: exact, as before
  const e = index().match("partially hydrogenated rapeseed oil");
  assertEquals([e?.variantId, e?.matchType], ["partially-hydrogenated", "variant"]);
  // a variant with no tells keeps the name's variant
  assertEquals(index().match("organic cold pressed rapeseed oil")?.variantId, "cold-pressed");
  // and an item longer than any real one keeps it too (tells are not read past TELL_TEXT_MAX)
  const long = `${"x ".repeat(260)}without partially hydrogenated rapeseed oil`;
  assertEquals(index().match(long)?.variantId, "partially-hydrogenated");
});

Deno.test("a variant whose drop would lose an allergen or turn a diet keeps its id (pc-opus on #14)", () => {
  const guarded = "^(?!.*\\b(?:without|no|bez|nie)\\b).*\\bsoy\\b";
  const idx = new KbIndex({
    version: "t",
    counts: {},
    implications: [],
    sources: [],
    classes: [],
    ingredients: [{
      id: "lecithins",
      names: { en: ["lecithin"] },
      variants: [
        { id: "soy", names: { en: ["soy lecithin"] }, process: { en: "p" }, tells: [guarded] },
        {
          id: "sunflower",
          names: { en: ["sunflower lecithin"] },
          process: { en: "p" },
          tells: [guarded.replace("soy", "sunflower")],
        },
      ],
      assertions: [{ code: "allergen.soybeans", certainty: "yes", variant: "soy" }],
    }],
  } as unknown as KbBundle);
  // the soy variant carries an allergen the entry does not: even where its tell does not fire, it is kept
  assertEquals(idx.match("without any soy lecithin")?.variantId, "soy");
  // a variant that asserts nothing of its own is denied where its tell does not fire: its name is read like a claim
  const ex: DeniedName[] = [];
  assertEquals(idx.match("without any sunflower lecithin", ex), null);
  assertEquals(ex, [{ ingredientId: "lecithins", matched: "sunflower lecithin" }]);
});

// Implications, so that a flag can fire at all.
const impl = (code: string, group: string) => ({
  code,
  group,
  severity: "info",
  concern: "info",
  kind: "fact",
  label: { en: code },
  definition: { en: code },
  evidence_required: "t",
});
const IMPL = [
  impl("allergen.soybeans", "allergen"),
  impl("origin.animal", "origin"),
  impl("origin.plant", "origin"),
];
const says = (code: string, variant?: string) => ({
  code,
  ...(variant ? { variant } : {}),
  certainty: "yes",
  kind: "fact",
  grade: "A",
  note: { en: "n" },
  sources: [{ id: "s" }],
});

Deno.test("a denied variant name of an allergen food keeps the allergen at maybe and nothing else (policy B)", () => {
  // the b2 policy B reading of a claim that excludes a process on an allergen food: "allergen.X maybe", and never the
  // food, its origin or a diet effect
  const idx = new KbIndex({
    version: "t",
    counts: {},
    implications: IMPL,
    sources: [],
    classes: [],
    ingredients: [
      {
        id: "soybean-oil",
        names: { en: ["soybean oil"] },
        variants: [{
          id: "hydrogenated",
          names: { en: ["hydrogenated soybean oil"] },
          process: { en: "p" },
          tells: ["^(?!.*\\b(?:not|without)\\b).*\\bhydrogenated\\b"],
        }],
        assertions: [says("allergen.soybeans"), says("origin.plant")],
      },
      { id: "olive-oil", names: { en: ["olive oil"] } },
    ],
  } as unknown as KbBundle);
  for (
    const text of [
      "not completely refined hydrogenated soybean oil",
      "without using hydrogenated soybean oil",
    ]
  ) {
    const ex: DeniedName[] = [];
    assertEquals(idx.match(text, ex), null, text);
    assertEquals(ex.map((x) => x.ingredientId), ["soybean-oil"], text);
    for (const label of [`Ingredients: ${text}`, `Ingredients: olive oil (${text})`]) {
      const r = analyze(idx, label, { lang: "en" });
      const soy = r.flags.find((f) => f.code === "allergen.soybeans");
      assertEquals([soy?.certainty, soy?.kind], ["maybe", "estimate"], label);
      assertEquals(r.flags.some((f) => f.code === "origin.plant"), false, label);
    }
  }
  // the food named affirmatively keeps both, as before
  const r = analyze(idx, "Ingredients: hydrogenated soybean oil", { lang: "en" });
  assertEquals(r.flags.find((f) => f.code === "allergen.soybeans")?.certainty, "yes");
  assertEquals(r.flags.some((f) => f.code === "origin.plant"), true);
});

Deno.test("a misspelt variant name keeps its fuzzy match: only a name the item denies is blocked", () => {
  // the tell cannot fire on a misspelling, which is no negation: the fuzzy match stands, as on main
  const idx = new KbIndex({
    version: "t",
    counts: {},
    implications: [],
    sources: [],
    classes: [],
    ingredients: [{
      id: "glucose-syrup",
      names: { en: ["glucose syrup"] },
      variants: [{
        id: "maize",
        names: { en: ["maize glucose syrup"] },
        process: { en: "p" },
        tells: ["\\bmaize\\b"],
      }],
    }],
  } as unknown as KbBundle);
  const m = idx.match("maise glucos syrup");
  assertEquals([m?.ingredientId, m?.variantId, m?.matchType], ["glucose-syrup", "maize", "fuzzy"]);
});

Deno.test("a denied variant name does not assert the plain food (Sol 6.1 on #10 at 39859dc)", () => {
  const guarded = PH;
  const bundle = (withClaim: boolean) =>
    ({
      version: "t",
      counts: {},
      implications: IMPL,
      sources: [],
      classes: [],
      ingredients: [
        {
          id: "poultry-fat",
          names: { en: ["poultry fat"] },
          variants: [{
            id: "partially-hydrogenated",
            names: { en: ["partially hydrogenated poultry fat"] },
            process: { en: "p" },
            tells: [guarded],
          }],
          assertions: [says("origin.animal"), { ...says("diet.vegan"), certainty: "no" }],
        },
        { id: "olive-oil", names: { en: ["olive oil"] } },
        ...(withClaim
          ? [{
            id: "claim",
            names: { en: ["a claim"] },
            exact_names: { en: ["without partially hydrogenated poultry fat"] },
          }]
          : []),
      ],
    }) as unknown as KbBundle;
  for (const f of ["using", "added", "the addition of"]) {
    const text = `Ingredients: olive oil (without ${f} partially hydrogenated poultry fat)`;
    for (const withClaim of [false, true]) {
      const r = analyze(new KbIndex(bundle(withClaim)), text, { lang: "en" });
      const child = r.items[0].children?.[0];
      assertEquals(child?.match?.ingredient_id === "poultry-fat", false, `${text} ${withClaim}`);
      assertEquals(r.flags.some((x) => x.code === "origin.animal"), false, `${text} ${withClaim}`);
      assertEquals(r.diets.vegan.status === "no", false, `${text} ${withClaim}`);
      // with a claim name to reach, the fuzzy match finds the claim
      if (withClaim) assertEquals(child?.match?.ingredient_id, "claim", text);
    }
  }
  // the plain food named affirmatively is still the food, with its origin and diet
  const r = analyze(new KbIndex(bundle(false)), "Ingredients: olive oil, poultry fat", { lang: "en" });
  assertEquals(r.items[1].match?.ingredient_id, "poultry-fat");
  assertEquals(r.flags.some((x) => x.code === "origin.animal"), true);
  assertEquals(r.diets.vegan.status, "no");
});

Deno.test("a variant whose tells a neutral item cannot meet is never denied", () => {
  // an anchored tell fires on the whole name only: inside a longer item it would deny every mention, so the variant
  // keeps today's behaviour
  const idx = new KbIndex({
    version: "t",
    counts: {},
    implications: [],
    sources: [],
    classes: [],
    ingredients: [{
      id: "sugar",
      names: { en: ["sugar"] },
      variants: [{
        id: "cane",
        names: { en: ["cane sugar"] },
        process: { en: "p" },
        tells: ["^cane sugar$"],
      }],
    }],
  } as unknown as KbBundle);
  assertEquals(idx.match("organic cane sugar")?.variantId, "cane");
});

// Sol 6.1 on #15 at b71a92d: a soybean oil whose hydrogenated variant a negator denies, an emphasised soy source, and
// a longer olive-oil name.
const SOY_TELL = String.raw`^(?!.*\b(?:not|without)\b).*\bhydrogenated\b`;
function soyIndex(provenance?: string): KbIndex {
  return new KbIndex({
    version: "t",
    counts: {},
    implications: IMPL,
    sources: [],
    classes: [],
    ingredients: [
      {
        id: "soybean-oil",
        names: { en: ["soybean oil"] },
        variants: [{
          id: "hydrogenated",
          names: { en: ["hydrogenated soybean oil", "hydrogenated soy oil"] },
          process: { en: "p" },
          tells: [SOY_TELL],
        }],
        assertions: [says("allergen.soybeans"), says("origin.plant")],
        ...(provenance ? { provenance } : {}),
      },
      { id: "soy", names: { en: ["soy"] }, assertions: [says("allergen.soybeans")] },
      { id: "olive-oil", names: { en: ["olive oil", "extra virgin olive oil"] } },
    ],
  } as unknown as KbBundle);
}
const soyFlag = (label: string, idx = soyIndex()) =>
  analyze(idx, label, { lang: "en" }).flags.find((f) => f.code === "allergen.soybeans");

Deno.test("a negator after the name does not deny it (Sol 6.1 on #15 at b71a92d, P2 1)", () => {
  const idx = new KbIndex({
    version: "t",
    counts: {},
    implications: IMPL,
    sources: [],
    classes: [],
    ingredients: [{
      id: "poultry-fat",
      names: { en: ["poultry fat"] },
      variants: [{
        id: "partially-hydrogenated",
        names: { en: ["partially hydrogenated poultry fat"] },
        process: { en: "p" },
        tells: [PH],
      }],
      assertions: [says("origin.animal"), { ...says("diet.vegan"), certainty: "no" }],
    }],
  } as unknown as KbBundle);
  const r = analyze(idx, "Ingredients: partially hydrogenated poultry fat without added sugar", {
    lang: "en",
  });
  assertEquals(r.items[0].match?.ingredient_id, "poultry-fat");
  assertEquals(r.flags.some((x) => x.code === "origin.animal"), true);
  assertEquals(r.diets.vegan.status, "no");
});

Deno.test("a denied name is read whatever else wins the match (Sol 6.1 on #15 at b71a92d, P2 2)", () => {
  for (const host of ["olive oil", "extra virgin olive oil"]) {
    const label = `Ingredients: ${host} without using hydrogenated soybean oil`;
    const r = analyze(soyIndex(), label, { lang: "en" });
    assertEquals(r.items[0].match?.ingredient_id, "olive-oil", label);
    const soy = r.flags.find((f) => f.code === "allergen.soybeans");
    assertEquals([soy?.certainty, soy?.kind], ["maybe", "estimate"], label);
  }
});

Deno.test("capitals inside a denied name do not reassert its allergen (Sol 6.1 on #15 at b71a92d, P2 3)", () => {
  for (
    const label of [
      "Ingredients: olive oil (without using hydrogenated SOY oil)",
      "Ingredients: without using hydrogenated SOY oil",
    ]
  ) {
    const soy = soyFlag(label);
    assertEquals([soy?.certainty, soy?.kind], ["maybe", "estimate"], label);
  }
  // capitals outside a denial still name the allergen
  assertEquals(soyFlag("Ingredients: olive oil, SOY")?.certainty, "yes");
});

Deno.test("a denied name's AI-drafted entry is disclosed (Sol 6.1 on #15 at b71a92d, P3 1)", () => {
  const r = analyze(soyIndex("ai-drafted"), "Ingredients: without using hydrogenated soybean oil", {
    lang: "en",
  });
  assertEquals(r.ai_generated_content, true);
  assertEquals(
    analyze(soyIndex(), "Ingredients: without using hydrogenated soybean oil", { lang: "en" })
      .ai_generated_content,
    false,
  );
});
