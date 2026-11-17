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
  assertEquals(ex, [{
    ingredientId: "lecithins",
    matched: "sunflower lecithin",
    start: 2,
    end: 4,
    variantId: "sunflower",
  }]);
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
        // "refined" is a word of a name, as on b2's KB: a negation that reaches it denies that word (#18)
        names: { en: ["soybean oil", "refined soybean oil"] },
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
  for (const text of ["not hydrogenated soybean oil", "without using hydrogenated soybean oil"]) {
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
  // the food named affirmatively beside its denied variant keeps "yes", in a qualifier or the item's own source (Sol 6.1
  // on #18 at 165ecbd, P2 2)
  for (
    const label of [
      "Ingredients: olive oil (from soybean oil without using hydrogenated soybean oil)",
      "Ingredients: olive oil without using hydrogenated soybean oil (soybean oil)",
    ]
  ) {
    const soy = analyze(idx, label, { lang: "en" }).flags.find((f) => f.code === "allergen.soybeans");
    assertEquals(soy?.certainty, "yes", label);
  }
  // a negator that reaches another word first ("not completely refined") denies nothing: the plain oil, as #14 reads it
  const ex: DeniedName[] = [];
  const plain = idx.match("not completely refined hydrogenated soybean oil", ex);
  assertEquals([plain?.ingredientId, plain?.variantId, ex.length], ["soybean-oil", undefined, 0]);
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
      // the denial is the item's reading: no fuzzy guess beside it, claim name or not (#18)
      assertEquals(child?.match ?? null, null, `${text} ${withClaim}`);
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

Deno.test("a negator that denies something else leaves the food (Sol 6.1 on #15 at b71a92d, 8dc421e, 2a6349f)", () => {
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
    }, { id: "sugar", names: { en: ["sugar"] } }],
  } as unknown as KbBundle);
  for (
    const text of [
      // the negator comes after the name
      "partially hydrogenated poultry fat without added sugar",
      // another food lies between the negator and the name, known to the KB or not (Sol 6.1 on #15 at 2a6349f)
      "without added sugar with partially hydrogenated poultry fat",
      "without added sugars with partially hydrogenated poultry fat",
      "without artificial colours with partially hydrogenated poultry fat",
      // words that are no filler lie between them
      "without any added flavour and with partially hydrogenated poultry fat",
    ]
  ) {
    const r = analyze(idx, `Ingredients: ${text}`, { lang: "en" });
    const own = r.items.find((x) => x.match?.ingredient_id === "poultry-fat");
    assertEquals(own?.match?.ingredient_id, "poultry-fat", text);
    assertEquals(r.flags.some((x) => x.code === "origin.animal"), true, text);
    assertEquals(r.diets.vegan.status, "no", text);
  }
  // a negator right before it, through a short filler, still denies it
  assertEquals(idx.match("without the addition of partially hydrogenated poultry fat"), null);
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
  // capitals outside a denial still name the allergen, beside one too (Sol 6.1 on #15 at 8dc421e, P2 2)
  assertEquals(soyFlag("Ingredients: olive oil, SOY")?.certainty, "yes");
  for (
    const label of [
      "Ingredients: olive oil with SOY (without using hydrogenated soy oil)",
      "Ingredients: SOY oil, olive oil (without using hydrogenated SOY oil)",
    ]
  ) {
    const soy = soyFlag(label);
    assertEquals([soy?.certainty, soy?.kind], ["yes", "fact"], label);
  }
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

// pc-opus's masked-form check on #15: claims and long names that hid an allergen food's denied name.
const NEG = String.raw`^(?!.*\b(?:not|non|no|without|bez)\b).*\b`;
function nutIndex(): KbIndex {
  return new KbIndex({
    version: "t",
    counts: {},
    implications: [...IMPL, impl("allergen.nuts", "allergen"), impl("processing.hydrogenated", "processing")],
    sources: [],
    classes: [],
    ingredients: [
      {
        id: "almond-oil",
        names: { en: ["almond oil", "vegetable oil from almonds"] },
        variants: [{
          id: "partially-hydrogenated",
          names: {
            en: ["partially hydrogenated almond oil", "partially hydrogenated vegetable oil from almonds"],
          },
          process: { en: "p" },
          tells: [`${NEG}partially hydrogenated`],
        }],
        assertions: [says("allergen.nuts")],
      },
      {
        id: "brazil-nut-oil",
        names: { en: ["brazil nut oil"] },
        variants: [{
          id: "fully-hydrogenated",
          names: { en: ["fully hydrogenated vegetable fat made from brazil nut kernels"] },
          process: { en: "p" },
          tells: [`${NEG}fully hydrogenated`],
        }],
        assertions: [says("allergen.nuts")],
      },
      {
        id: "hydrogenated-vegetable-fat",
        names: { en: ["hydrogenated vegetable oil", "fully hydrogenated vegetable fat"] },
        assertions: [says("processing.hydrogenated")],
      },
      { id: "vegetable-fat", names: { en: ["vegetable oil", "not partially hydrogenated vegetable oil"] } },
      {
        id: "unhydrogenated-fat",
        names: { en: ["unhydrogenated fat"] },
        exact_names: { en: ["not partially hydrogenated", "contains no partially hydrogenated"] },
      },
      {
        id: "hydrogenation-claim-nuts",
        names: { en: ["nut claim"] },
        exact_names: { en: ["no partially hydrogenated almond oil"] },
        assertions: [{ ...says("allergen.nuts"), certainty: "maybe" }],
      },
    ],
  } as unknown as KbBundle);
}
// Sol 6.1 on #16 at 0fab984: the most complete name says which food.
function specificIndex(): KbIndex {
  return new KbIndex({
    version: "t",
    counts: {},
    implications: [...IMPL, impl("allergen.nuts", "allergen"), impl("allergen.peanuts", "allergen")],
    sources: [],
    classes: [],
    ingredients: [
      {
        id: "soybean-oil",
        names: { en: ["soybean oil"] },
        variants: [
          { id: "unrefined", names: { en: ["unrefined soybean oil"] }, process: { en: "p" }, prior: 0.5 },
          {
            id: "fully-refined",
            names: { en: ["fully refined soybean oil"] },
            process: { en: "p" },
            prior: 0.45,
          },
        ],
        assertions: [
          says("allergen.soybeans", "unrefined"),
          { ...says("allergen.soybeans", "fully-refined"), certainty: "no" },
        ],
      },
      {
        id: "peanut-oil",
        names: { en: ["peanut oil"] },
        variants: [{
          id: "partially-hydrogenated",
          names: { en: ["partially hydrogenated nut oil from peanuts"] },
          process: { en: "p" },
          tells: [`${NEG}partially hydrogenated`],
        }],
        assertions: [says("allergen.peanuts")],
      },
      {
        id: "unhydrogenated-fat",
        names: { en: ["unhydrogenated fat"] },
        exact_names: { en: ["no hydrogenated fully refined soybean oil"] },
      },
      {
        id: "hydrogenation-claim-nuts-peanuts",
        names: { en: ["nut claim"] },
        exact_names: { en: ["no partially hydrogenated nut oil"] },
        assertions: [
          { ...says("allergen.nuts"), certainty: "maybe" },
          { ...says("allergen.peanuts"), certainty: "maybe" },
        ],
      },
      { id: "olive-oil", names: { en: ["olive oil"] } },
    ],
  } as unknown as KbBundle);
}

Deno.test("the most complete name inside a claim says which food (Sol 6.1 on #16 at 0fab984)", () => {
  const idx = specificIndex();
  const flag = (label: string, code: string) =>
    analyze(idx, label, { lang: "en" }).flags.find((f) => f.code === code)?.certainty;
  // the refined-soy claim carries no soy, standalone or embedded: the refined oil inside it adds none (Annex II 6(a))
  for (
    const label of [
      "Ingredients: no hydrogenated fully refined soybean oil",
      "Ingredients: olive oil (no hydrogenated fully refined soybean oil)",
      "Ingredients: olive oil (contains no hydrogenated fully refined soybean oil)",
    ]
  ) {
    assertEquals(flag(label, "allergen.soybeans"), undefined, label);
  }
  // the peanut source rules out the tree nuts an ambiguous claim would add
  for (
    const label of [
      "Ingredients: contains no partially hydrogenated nut oil from peanuts",
      "Ingredients: olive oil (contains no partially hydrogenated nut oil from peanuts)",
    ]
  ) {
    assertEquals(flag(label, "allergen.peanuts"), "maybe", label);
    assertEquals(flag(label, "allergen.nuts"), undefined, label);
  }
  // the ambiguous claim on its own still carries both
  assertEquals(
    flag("Ingredients: olive oil (contains no partially hydrogenated nut oil)", "allergen.nuts"),
    "maybe",
  );
});

const nuts = (label: string) =>
  analyze(nutIndex(), label, { lang: "en" }).flags.find((f) => f.code === "allergen.nuts")?.certainty;

Deno.test("a claim inside a longer item denies what it names (pc-opus on #15)", () => {
  for (
    const text of [
      // the per-allergen claim, inside "contains …"
      "contains no partially hydrogenated almond oil",
      // a generic claim before the allergen food's variant name, which a generic negated name would win
      "not partially hydrogenated vegetable oil from almonds",
    ]
  ) {
    for (const label of [`Ingredients: ${text}`, `Ingredients: rapeseed oil (${text})`]) {
      assertEquals(nuts(label), "maybe", label);
    }
  }
});

Deno.test("a denied variant name past the sub-phrase window is found (pc-opus on #15)", () => {
  const label = "Ingredients: without fully hydrogenated vegetable fat made from brazil nut kernels";
  const r = analyze(nutIndex(), label, { lang: "en" });
  assertEquals(r.flags.find((f) => f.code === "allergen.nuts")?.certainty, "maybe");
  // the generic hydrogenated fat inside the denied name is not the match
  assertEquals(r.flags.some((f) => f.code === "processing.hydrogenated"), false);
});

Deno.test("a denied name blocks its words after a claim and through a longer filler (Sol 6.1 on #10 at 7da39cb, P2 2)", () => {
  const idx = new KbIndex({
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
          tells: [String.raw`^(?!.*\b(?:without|free)\b).*\bpartially hydrogenated\b`],
        }],
        assertions: [says("origin.animal"), { ...says("diet.vegan"), certainty: "no" }],
      },
      { id: "olive-oil", names: { en: ["olive oil"] } },
      {
        id: "claim",
        names: { en: ["a claim"] },
        exact_names: { en: ["without the use of partially hydrogenated"] },
      },
    ],
  } as unknown as KbBundle);
  for (
    const text of [
      // the name starts inside a claim: the plain food it ends in, after the claim, is not read either
      "without the use of partially hydrogenated poultry fat",
      // four and five fillers between the negator and the name
      "free of the use of partially hydrogenated poultry fat",
      "free from the addition of any partially hydrogenated poultry fat",
    ]
  ) {
    const ex: DeniedName[] = [];
    assertEquals(idx.match(text, ex)?.ingredientId === "poultry-fat", false, text);
    assertEquals(idx.match(text)?.ingredientId === "poultry-fat", false, text);
    assertEquals(ex.map((x) => x.ingredientId), ["poultry-fat"], text);
    const r = analyze(idx, `Ingredients: olive oil (${text})`, { lang: "en" });
    assertEquals(r.items[0].children?.[0]?.match?.ingredient_id === "poultry-fat", false, text);
    assertEquals(r.flags.some((x) => x.code === "origin.animal"), false, text);
    assertEquals(r.diets.vegan.status === "no", false, text);
  }
  // the food named affirmatively after the claim's words is still the food
  const r = analyze(idx, "Ingredients: olive oil, partially hydrogenated poultry fat", { lang: "en" });
  assertEquals(r.items[1].match?.ingredient_id, "poultry-fat");
  assertEquals(r.flags.some((x) => x.code === "origin.animal"), true);
});

Deno.test("a variant name inside a food's own negated name does not block the food (#17 sweep)", () => {
  // "not partially hydrogenated rapeseed oil" is the plain oil's own name; after "gluten-free", a food before the
  // claim, it is not the match, but the oil it names still is, and "gluten" inside "gluten-free" is not
  const idx = new KbIndex({
    version: "t",
    counts: {},
    implications: [...IMPL, impl("allergen.gluten", "allergen")],
    sources: [],
    classes: [],
    ingredients: [
      {
        id: "rapeseed-oil",
        names: { en: ["rapeseed oil", "not partially hydrogenated rapeseed oil"] },
        variants: [{
          id: "partially-hydrogenated",
          names: { en: ["partially hydrogenated rapeseed oil"] },
          process: { en: "p" },
          tells: [PH.replace("without|", "without|not|")],
        }],
      },
      { id: "gluten", names: { en: ["gluten"] }, assertions: [says("allergen.gluten")] },
      { id: "claim", names: { en: ["a claim"] }, exact_names: { en: ["not partially hydrogenated"] } },
    ],
  } as unknown as KbBundle);
  for (
    const label of [
      "Ingredients: gluten-free not partially hydrogenated rapeseed oil",
      "Ingredients: olive oil, gluten-free not partially hydrogenated rapeseed oil",
    ]
  ) {
    const r = analyze(idx, label, { lang: "en" });
    assertEquals(r.items.at(-1)?.match?.ingredient_id, "rapeseed-oil", label);
    assertEquals(r.flags.some((x) => x.code === "allergen.gluten"), false, label);
  }
});

// Sol 6.1 on #10 at 7da39cb and f1a6e25, P2 3; pc-opus's policy (B): a stated full refining earns Annex II 6(a) on a
// hydrogenated oil, in either word order, affirmative and denied; plain "refined" does not.
function refinedSoyIndex(): KbIndex {
  return new KbIndex({
    version: "t",
    counts: {},
    implications: [...IMPL, impl("processing.hydrogenated", "processing")],
    sources: [],
    classes: [],
    ingredients: [
      {
        id: "soybean-oil",
        names: { en: ["soybean oil"] },
        variants: [
          { id: "unrefined", names: { en: ["unrefined soybean oil"] }, process: { en: "p" }, prior: 0.5 },
          {
            id: "fully-refined",
            process: { en: "p" },
            prior: 0.45,
            tells: ["^(?:fully )?refined soybean oil$"],
          },
          {
            id: "hydrogenated",
            names: {
              en: [
                "hydrogenated soybean oil",
                "refined hydrogenated soybean oil",
                "hydrogenated refined soybean oil",
              ],
            },
            process: { en: "p" },
            tells: [SOY_TELL],
          },
          {
            id: "hydrogenated-fully-refined",
            names: {
              en: ["hydrogenated fully refined soybean oil", "fully refined hydrogenated soybean oil"],
            },
            process: { en: "p" },
            tells: [SOY_TELL],
          },
        ],
        assertions: [
          says("allergen.soybeans", "unrefined"),
          { ...says("allergen.soybeans", "fully-refined"), certainty: "no" },
          { ...says("allergen.soybeans", "hydrogenated"), certainty: "maybe" },
          { ...says("allergen.soybeans", "hydrogenated-fully-refined"), certainty: "no" },
          says("processing.hydrogenated", "hydrogenated"),
          says("processing.hydrogenated", "hydrogenated-fully-refined"),
        ],
      },
      { id: "rapeseed-oil", names: { en: ["rapeseed oil"] } },
    ],
  } as unknown as KbBundle);
}

Deno.test("a stated full refining keeps the soy exemption on a hydrogenated oil, either order (Sol 6.1 on #10 at f1a6e25, P2 3)", () => {
  const idx = refinedSoyIndex();
  const hydrogenated = (label: string) =>
    analyze(idx, label, { lang: "en" }).flags.some((x) => x.code === "processing.hydrogenated");
  for (const oil of ["hydrogenated fully refined soybean oil", "fully refined hydrogenated soybean oil"]) {
    // named: the exemption and the hydrogenation both stand
    for (const label of [`Ingredients: ${oil}`, `Ingredients: rapeseed oil (${oil})`]) {
      assertEquals(soyFlag(label, idx), undefined, label);
      assertEquals(hydrogenated(label), true, label);
    }
    // denied, with or without a filler: no soy, and no hydrogenation
    for (const f of ["", "added ", "using ", "ever using "]) {
      const label = `Ingredients: rapeseed oil (without ${f}${oil})`;
      assertEquals(soyFlag(label, idx), undefined, label);
      assertEquals(hydrogenated(label), false, label);
    }
  }
  // plain "refined" states no full refining: soy maybe, named or denied (round 26)
  for (
    const oil of [
      "hydrogenated soybean oil",
      "refined hydrogenated soybean oil",
      "hydrogenated refined soybean oil",
    ]
  ) {
    assertEquals(soyFlag(`Ingredients: ${oil}`, idx)?.certainty, "maybe", oil);
    for (const f of ["", "added ", "using "]) {
      const label = `Ingredients: rapeseed oil (without ${f}${oil})`;
      assertEquals(soyFlag(label, idx)?.certainty, "maybe", label);
    }
  }
  // a "not" before the name negates its full refining, through any adverb: soy maybe, never the exemption (#18
  // battery, oil matrix; Sol 6.1 on #18 at 029b6bc)
  for (
    const oil of ["not quite", "not at all", "not entirely"].map((n) =>
      `${n} fully refined hydrogenated soybean oil`
    )
  ) {
    for (const label of [`Ingredients: ${oil}`, `Ingredients: rapeseed oil (${oil})`]) {
      assertEquals(soyFlag(label, idx)?.certainty, "maybe", label);
    }
  }
  // "not containing" is an exclusion verb, after an adverb too: the denial keeps the exemption (Sol 6.1 on #18 at
  // 2668948)
  for (const ex of ["not containing", "not ever containing", "not intentionally using"]) {
    for (
      const label of [
        `Ingredients: ${ex} fully refined hydrogenated soybean oil`,
        `Ingredients: rapeseed oil (${ex} fully refined hydrogenated soybean oil)`,
      ]
    ) {
      assertEquals(soyFlag(label, idx), undefined, label);
    }
  }
  // "not" before an exclusion verb with an unknown word between them is still the exclusion: the exemption stands
  // (Sol 6.1 on #10 at 69045ab)
  for (
    const label of [
      "Ingredients: not actually containing fully refined hydrogenated soybean oil",
      "Ingredients: rapeseed oil (without actually using fully refined hydrogenated soybean oil)",
    ]
  ) {
    assertEquals(soyFlag(label, idx), undefined, label);
  }
  // an adverb phrase may hold an article: without the verb it negates the full refining (soy maybe), with it it is
  // the exclusion (no soy) (Sol 6.1 on #18 at 165ecbd)
  for (const adv of ["not in any way", "not at any point", "not at all"]) {
    for (
      const host of [(x: string) => `Ingredients: ${x}`, (x: string) => `Ingredients: rapeseed oil (${x})`]
    ) {
      const negated = host(`${adv} fully refined hydrogenated soybean oil`);
      assertEquals(soyFlag(negated, idx)?.certainty, "maybe", negated);
      const excluded = host(`${adv} containing fully refined hydrogenated soybean oil`);
      assertEquals(soyFlag(excluded, idx), undefined, excluded);
    }
  }
  // two sources of one food: the explicit one's "yes" stands, in either order (Sol 6.1 on #18 at 0e08a29)
  for (
    const label of [
      "Ingredients: rapeseed oil (from soybean oil, from unrefined soybean oil)",
      "Ingredients: rapeseed oil (from unrefined soybean oil, from soybean oil)",
    ]
  ) {
    assertEquals(soyFlag(label, idx)?.certainty, "yes", label);
  }
  // a qualifier's denied name is read as an item's: the food's own allergens at maybe (Sol 6.1 on #18 at 2668948)
  assertEquals(
    soyFlag("Ingredients: rapeseed oil (from not fully refined hydrogenated soybean oil)", idx)?.certainty,
    "maybe",
  );
  // a "not" right before the name negates its full refining: soy maybe, never the exemption (#18 battery, oil matrix)
  for (
    const label of [
      "Ingredients: not fully refined hydrogenated soybean oil",
      "Ingredients: rapeseed oil (not fully refined hydrogenated soybean oil)",
    ]
  ) {
    assertEquals(soyFlag(label, idx)?.certainty, "maybe", label);
  }
  // an exclusion of something else leaves the variant as named: exempt and hydrogenated (Sol 6.1 on #18 at 0547db1,
  // P2 2), not the food's own reading
  for (
    const label of [
      "Ingredients: without rapeseed oil fully refined hydrogenated soybean oil",
      "Ingredients: without preservatives fully refined hydrogenated soybean oil",
      "Ingredients: olive oil (without preservatives fully refined hydrogenated soybean oil)",
    ]
  ) {
    assertEquals(soyFlag(label, idx), undefined, label);
    assertEquals(hydrogenated(label), true, label);
  }
});

Deno.test("the words of an exclusion keep the negation on the name, whatever they are (Sol 6.1 on #10 at f1a6e25, P2 2)", () => {
  const idx = new KbIndex({
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
          tells: [PH],
        }],
        assertions: [says("origin.animal"), { ...says("diet.vegan"), certainty: "no" }],
      },
      { id: "olive-oil", names: { en: ["olive oil"] } },
      { id: "sugar", names: { en: ["sugar"] } },
    ],
  } as unknown as KbBundle);
  for (const f of ["ever using", "ever adding", "in any way using", "at any point adding"]) {
    const label = `Ingredients: olive oil (without ${f} partially hydrogenated poultry fat)`;
    const r = analyze(idx, label, { lang: "en" });
    assertEquals(r.items[0].children?.[0]?.match?.ingredient_id === "poultry-fat", false, label);
    assertEquals(r.flags.some((x) => x.code === "origin.animal"), false, label);
    assertEquals(r.diets.vegan.status === "no", false, label);
  }
  // an exclusion verb that takes the name as its object carries the negation over any word before it, inside the
  // window (Sol 6.1 on #10 at 69045ab, P2 2)
  for (
    const f of [
      "actually using",
      "really adding",
      "additionally the use of",
      "actually and truly using any",
      "preservatives or using",
    ]
  ) {
    const label = `Ingredients: olive oil (without ${f} partially hydrogenated poultry fat)`;
    const r = analyze(idx, label, { lang: "en" });
    assertEquals(r.items[0].children?.[0]?.match?.ingredient_id === "poultry-fat", false, label);
    assertEquals(r.flags.some((x) => x.code === "origin.animal"), false, label);
    assertEquals(r.diets.vegan.status === "no", false, label);
  }
  // a participle after its noun closes an exclusion of that noun: the food after it is the food
  for (const text of ["without sugar added partially hydrogenated poultry fat"]) {
    const r = analyze(idx, `Ingredients: ${text}`, { lang: "en" });
    assertEquals(r.items[0].match?.ingredient_id, "poultry-fat", text);
    assertEquals(r.flags.some((x) => x.code === "origin.animal"), true, text);
  }
  // a negator more than DENIAL_GAP_MAX (5) words before the name does not reach it (pc-opus: keep it in the window)
  const far = analyze(
    idx,
    "Ingredients: without ever in any way at all using partially hydrogenated poultry fat",
    {
      lang: "en",
    },
  );
  assertEquals(far.items[0].match?.ingredient_id, "poultry-fat");
  // any other word ends the negation, a food the KB knows or not (Sol 6.1 on #18 at c16374b, P2 1): the food after
  // it is the food
  for (
    const label of [
      "Ingredients: without preservatives partially hydrogenated poultry fat",
      "Ingredients: rapeseed oil (without preservatives partially hydrogenated poultry fat)",
    ]
  ) {
    const r = analyze(idx, label, { lang: "en" });
    assertEquals(r.flags.some((x) => x.code === "origin.animal"), true, label);
    assertEquals(r.diets.vegan.status, "no", label);
  }
  // a food the KB knows, or a break, between them ends the negation: the food after it is the food
  for (
    const text of [
      "without sugar partially hydrogenated poultry fat",
      "without colours and partially hydrogenated poultry fat",
    ]
  ) {
    const r = analyze(idx, `Ingredients: ${text}`, { lang: "en" });
    assertEquals(r.items[0].match?.ingredient_id, "poultry-fat", text);
    assertEquals(r.flags.some((x) => x.code === "origin.animal"), true, text);
  }
});

Deno.test("a qualifier that names a food carries its likely variant's allergens at maybe (pc-opus on #18)", () => {
  // "(bez GMO olej sojowy)" reads as a qualifier; the oil's soy sits on its likely (unrefined) variant, as on b2's KB
  const idx = new KbIndex({
    version: "t",
    counts: {},
    implications: IMPL,
    sources: [],
    classes: [],
    ingredients: [
      {
        id: "soybean-oil",
        // as on b2's KB, "fully refined soybean oil" is the food's own name and its tell selects the exempt variant
        names: { en: ["soybean oil", "fully refined soybean oil"], pl: ["olej sojowy"] },
        variants: [
          { id: "unrefined", names: { en: ["unrefined soybean oil"] }, process: { en: "p" }, prior: 0.5 },
          {
            id: "fully-refined",
            process: { en: "p" },
            prior: 0.45,
            tells: ["^(?:fully )?refined soybean oil$"],
          },
          {
            id: "hydrogenated-fully-refined",
            names: { en: ["fully refined hydrogenated soybean oil"] },
            process: { en: "p" },
            tells: [SOY_TELL],
          },
        ],
        assertions: [
          says("allergen.soybeans", "unrefined"),
          { ...says("allergen.soybeans", "fully-refined"), certainty: "no" },
          { ...says("allergen.soybeans", "hydrogenated-fully-refined"), certainty: "no" },
        ],
      },
      { id: "soy", names: { en: ["soy"], pl: ["soja", "soi"] }, assertions: [says("allergen.soybeans")] },
    ],
  } as unknown as KbBundle);
  for (
    const label of [
      "Składniki: czekolada (bez GMO olej sojowy)",
      "Ingredients: chocolate (non-GMO soybean oil)",
    ]
  ) {
    const soy = analyze(idx, label, { lang: "pl" }).flags.find((f) => f.code === "allergen.soybeans");
    assertEquals(soy?.certainty, "maybe", label);
  }
  // a qualifier that names an exempt variant keeps the exemption, not the prior (Sol 6.1 on #18 at c16374b, P2 2)
  const exempt = analyze(idx, "Ingredients: rapeseed oil (from fully refined hydrogenated soybean oil)", {
    lang: "en",
  });
  assertEquals(exempt.flags.find((f) => f.code === "allergen.soybeans"), undefined);
  // and one that names the food, whose tell selects the exempt variant (Sol 6.1 on #18 at 0547db1, P2 1)
  const told = analyze(idx, "Ingredients: rapeseed oil (from fully refined soybean oil)", { lang: "en" });
  assertEquals(told.flags.find((f) => f.code === "allergen.soybeans"), undefined);
  // a source the food asserts outright keeps "yes"
  assertEquals(
    analyze(idx, "Składniki: lecytyna (z soi)", { lang: "pl" }).flags.find((f) =>
      f.code === "allergen.soybeans"
    )
      ?.certainty,
    "yes",
  );
});
