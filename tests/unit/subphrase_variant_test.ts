// A variant that a sub-phrase names keeps the match only when one of its tells fires on the item: the tells carry the
// KB's negation guards, so an exclusion that names a variant ("without using partially hydrogenated rapeseed oil")
// does not select it.
import { assertEquals } from "@std/assert";
import { KbIndex } from "../../src/core/kb-index.ts";
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
    const m = index().match(text);
    assertEquals(
      [m?.ingredientId, m?.variantId, m?.matchType],
      ["rapeseed-oil", undefined, "sub_phrase"],
      text,
    );
  }
  // as a bracket child too: the child is the plain oil, not the hydrogenated variant
  const r = analyze(
    index(),
    "Ingredients: rapeseed oil (without using partially hydrogenated rapeseed oil), sugar",
    {
      lang: "en",
    },
  );
  const child = r.items[0].children?.[0];
  assertEquals(child?.match?.ingredient_id, "rapeseed-oil");
  assertEquals(child?.variant?.basis === "label" && child.variant.id === "partially-hydrogenated", false);
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
  // a variant that asserts nothing of its own is dropped where its tell does not fire
  assertEquals(idx.match("without any sunflower lecithin")?.variantId, undefined);
});
