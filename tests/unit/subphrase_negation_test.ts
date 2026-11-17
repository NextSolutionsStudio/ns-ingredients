// The sub-phrase pass must not let a negated claim, or a name inside it, outrank the food named before it.
import { assertEquals } from "@std/assert";
import { KbIndex } from "../../src/core/kb-index.ts";
import type { KbBundle } from "../../src/kb/schema.ts";

function tinyIndex(list: string[]): KbIndex {
  return new KbIndex({
    version: "t",
    counts: {},
    implications: [],
    sources: [],
    classes: [],
    ingredients: list.map((n, k) => ({ id: `t${k}`, names: { en: [n] } })),
  } as unknown as KbBundle);
}

/** The name the item resolves to, and how. */
function hit(index: KbIndex, list: string[], text: string): string {
  const m = index.match(text);
  return m ? `${list[Number(m.ingredientId.slice(1))]} ${m.matchType}` : "-";
}

Deno.test("a negated claim after a named food does not outrank the food", () => {
  for (
    const [names, text, want] of [
      [
        ["olej sezamowy", "bez utwardzonych tluszczow"],
        "olej sezamowy bez utwardzonych tłuszczów",
        "olej sezamowy",
      ],
      [
        ["olej sezamowy", "wolny od uwodornionego oleju"],
        "olej sezamowy wolny od uwodornionego oleju",
        "olej sezamowy",
      ],
      [
        ["olej arachidowy", "nie zawiera tluszczow utwardzonych"],
        "olej arachidowy nie zawiera tłuszczów utwardzonych",
        "olej arachidowy",
      ],
      [["sesame oil", "free from hydrogenated oil"], "sesame oil free from hydrogenated oil", "sesame oil"],
      [
        ["sesame oil", "does not contain hydrogenated fat"],
        "sesame oil does not contain hydrogenated fat",
        "sesame oil",
      ],
      [
        ["peanut oil", "made without hydrogenated oils"],
        "peanut oil made without hydrogenated oils",
        "peanut oil",
      ],
    ] as [string[], string, string][]
  ) {
    assertEquals(hit(tinyIndex(names), names, text), `${want} sub_phrase`, text);
  }
});

Deno.test("a name inside the negated words does not outrank the food either", () => {
  for (
    const [names, text, want] of [
      [
        ["sesame oil", "partially hydrogenated oil"],
        "sesame oil no partially hydrogenated oil",
        "sesame oil",
      ],
      [["peanut oil", "fully hydrogenated fat"], "peanut oil free from fully hydrogenated fat", "peanut oil"],
      [
        ["olej sojowy", "czesciowo uwodornionych olejow"],
        "olej sojowy bez częściowo uwodornionych olejów",
        "olej sojowy",
      ],
    ] as [string[], string, string][]
  ) {
    assertEquals(hit(tinyIndex(names), names, text), `${want} sub_phrase`, text);
  }
});

Deno.test("a claim still matches a whole item, and a sub-phrase from the first word is still read", () => {
  const names = ["bez utwardzonych tluszczow", "mleko bez laktozy", "mleko", "olej sezamowy"];
  const index = tinyIndex(names);
  assertEquals(hit(index, names, "bez utwardzonych tłuszczów"), "bez utwardzonych tluszczow exact");
  // the negator is the first word: the guard does not apply
  assertEquals(
    hit(index, names, "bez utwardzonych tłuszczów i konserwantów"),
    "bez utwardzonych tluszczow sub_phrase",
  );
  // a span from the first word may reach the negator
  assertEquals(hit(index, names, "mleko bez laktozy UHT"), "mleko bez laktozy sub_phrase");
  // words before the negator are still read
  assertEquals(hit(index, names, "rafinowany olej sezamowy bez konserwantów"), "olej sezamowy sub_phrase");
});

Deno.test("with no negator after the first word, the longest sub-phrase still wins", () => {
  const names = ["sesame oil", "partially hydrogenated oil"];
  assertEquals(
    hit(tinyIndex(names), names, "sesame oil partially hydrogenated oil"),
    "partially hydrogenated oil sub_phrase",
  );
});

Deno.test("free and wolny negate only before from / of and od", () => {
  // "gluten free" follows its object: the variant name across it still matches (joined_items_test has the dash form)
  const fibre = ["gluten", "gluten free wheat fibre"];
  assertEquals(
    hit(tinyIndex(fibre), fibre, "BIO gluten free wheat fibre"),
    "gluten free wheat fibre sub_phrase",
  );
  const eggs = ["jaja", "jaja z wolnego wybiegu"];
  assertEquals(
    hit(tinyIndex(eggs), eggs, "świeże jaja z wolnego wybiegu"),
    "jaja z wolnego wybiegu sub_phrase",
  );
  const oil = ["sesame oil", "free from hydrogenated oil"];
  assertEquals(hit(tinyIndex(oil), oil, "sesame oil free from hydrogenated oil"), "sesame oil sub_phrase");
});

Deno.test("after a food, a presence claim is never read as a sub-phrase; a property one only as a fallback", () => {
  // "nie zawiera" denies presence: with no name before it, the claim is reached by the fuzzy pass, not by a name inside it
  const claim = ["nie zawiera tluszczow utwardzonych", "tluszczow utwardzonych"];
  const m = tinyIndex(claim).match("produkt nie zawiera tłuszczów utwardzonych");
  assertEquals([m?.ingredientId, m?.matchType], ["t0", "fuzzy"]);
  const oil = ["partially hydrogenated oil"];
  assertEquals(
    tinyIndex(oil).match("contains no partially hydrogenated oil")?.matchType === "sub_phrase",
    false,
  );
  // "nie zaleca" denies a property: with nothing before it, the old pass still runs
  const water = ["woda"];
  assertEquals(
    hit(tinyIndex(water), water, "zawiera nie zaleca się stosowania u dzieci woda"),
    "woda sub_phrase",
  );
});

Deno.test("an item that opens with a presence negation never takes a name inside it", () => {
  const names = ["rapeseed oil", "partially hydrogenated rapeseed oil"];
  const index = tinyIndex(names);
  for (
    const text of [
      "without any partially hydrogenated rapeseed oil",
      "bez dodatku partially hydrogenated rapeseed oil",
    ]
  ) {
    const m = index.match(text);
    assertEquals(m?.matchType === "sub_phrase", false, `${text}: ${m?.matched}`);
  }
  // a GMO claim negates nothing about the food
  assertEquals(
    hit(index, names, "non-GMO partially hydrogenated rapeseed oil"),
    "partially hydrogenated rapeseed oil sub_phrase",
  );
  assertEquals(
    hit(index, names, "bez GMO partially hydrogenated rapeseed oil"),
    "partially hydrogenated rapeseed oil sub_phrase",
  );
});

Deno.test("an item that opens with a property negation is left to the names", () => {
  // the food is there; only its property is denied ("not completely refined"), so the food's sub-phrase is read
  const soy = ["soybean oil"];
  assertEquals(hit(tinyIndex(soy), soy, "not completely refined soybean oil"), "soybean oil sub_phrase");
  // a negated variant name needs its own plain name in the KB ("non partially hydrogenated rapeseed oil")
  const names = [
    "rapeseed oil",
    "partially hydrogenated rapeseed oil",
    "non partially hydrogenated rapeseed oil",
  ];
  assertEquals(
    hit(tinyIndex(names), names, "non partially hydrogenated rapeseed oil x"),
    "non partially hydrogenated rapeseed oil sub_phrase",
  );
});
