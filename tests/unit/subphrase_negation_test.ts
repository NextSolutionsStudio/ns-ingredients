// A claim name (`exact_names`: "bez utwardzonych tłuszczów", "free from hydrogenated oil") resolves only a whole
// item. Inside a longer one, neither it nor a name that starts inside it outranks the food the item names; an item
// with no claim name in it reads exactly as before.
import { assertEquals } from "@std/assert";
import { KbIndex } from "../../src/core/kb-index.ts";
import { analyze } from "../../src/core/analyze.ts";
import { exactNameClashes } from "../../src/kb/read.ts";
import type { IngredientT } from "../../src/kb/schema.ts";
import type { KbBundle } from "../../src/kb/schema.ts";

/** One entry per string; "a|b" is one entry with both names, and a name written "!x" is that entry's exact name. */
function tinyIndex(list: string[]): KbIndex {
  return new KbIndex({
    version: "t",
    counts: {},
    implications: [],
    sources: [],
    classes: [],
    ingredients: list.map((n, k) => {
      const all = n.split("|");
      const names = all.filter((x) => !x.startsWith("!"));
      const exact = all.filter((x) => x.startsWith("!")).map((x) => x.slice(1));
      return { id: `t${k}`, names: { en: names }, exact_names: { en: exact } };
    }),
  } as unknown as KbBundle);
}

/** The first name of the entry the item resolves to, and how. */
function hit(names: string[], text: string): string {
  const m = tinyIndex(names).match(text);
  return m ? `${names[Number(m.ingredientId.slice(1))].split("|")[0].replace(/^!/, "")} ${m.matchType}` : "-";
}

Deno.test("a claim name after a food does not outrank the food", () => {
  for (
    const [names, text, want] of [
      [
        ["olej sezamowy", "!bez utwardzonych tluszczow"],
        "olej sezamowy bez utwardzonych tłuszczów",
        "olej sezamowy",
      ],
      [
        ["olej sezamowy", "!wolny od uwodornionego oleju"],
        "olej sezamowy wolny od uwodornionego oleju",
        "olej sezamowy",
      ],
      [
        ["olej arachidowy", "!nie zawiera tluszczow utwardzonych"],
        "olej arachidowy nie zawiera tłuszczów utwardzonych",
        "olej arachidowy",
      ],
      [["sesame oil", "!free from hydrogenated oil"], "sesame oil free from hydrogenated oil", "sesame oil"],
      [
        ["sesame oil", "!does not contain hydrogenated fat"],
        "sesame oil does not contain hydrogenated fat",
        "sesame oil",
      ],
      [
        ["peanut oil", "!made without hydrogenated oils"],
        "peanut oil made without hydrogenated oils",
        "peanut oil",
      ],
    ] as [string[], string, string][]
  ) {
    assertEquals(hit(names, text), `${want} sub_phrase`, text);
  }
  // as a plain name, the longer claim would win: why claims are exact names
  assertEquals(
    hit(["olej sezamowy", "bez utwardzonych tluszczow"], "olej sezamowy bez utwardzonych tłuszczów"),
    "bez utwardzonych tluszczow sub_phrase",
  );
});

Deno.test("a name inside the claim does not outrank the food either", () => {
  for (
    const [names, text, want] of [
      [
        ["sesame oil", "partially hydrogenated oil", "!no partially hydrogenated oil"],
        "sesame oil no partially hydrogenated oil",
        "sesame oil",
      ],
      [
        ["peanut oil", "fully hydrogenated fat", "!free from fully hydrogenated fat"],
        "peanut oil free from fully hydrogenated fat",
        "peanut oil",
      ],
      [
        ["sesame oil", "partially hydrogenated oil", "!without any partially hydrogenated oil"],
        "sesame oil without any partially hydrogenated oil",
        "sesame oil",
      ],
    ] as [string[], string, string][]
  ) {
    assertEquals(hit(names, text), `${want} sub_phrase`, text);
  }
});

Deno.test("an item that opens with a claim does not take the name it denies (Sol 6.1 on #10 at 8b46114)", () => {
  const names = [
    "rapeseed oil",
    "partially hydrogenated rapeseed oil",
    "!without any partially hydrogenated",
  ];
  for (
    const text of [
      "without any partially hydrogenated rapeseed oil",
      "rapeseed oil without any partially hydrogenated",
    ]
  ) {
    assertEquals(hit(names, text), "rapeseed oil sub_phrase", text);
  }
  // the claim alone is still its own name
  assertEquals(hit(names, "without any partially hydrogenated"), "without any partially hydrogenated exact");
  // no claim name, no change: a GMO claim denies nothing about the food
  assertEquals(
    hit(names, "bez GMO partially hydrogenated rapeseed oil"),
    "partially hydrogenated rapeseed oil sub_phrase",
  );
});

Deno.test("a claim name matches only a whole item, exactly or by fuzzy match, and is never a search hit", () => {
  const names = ["!bez utwardzonych tluszczow", "konserwanty|konserwantow"];
  assertEquals(hit(names, "bez utwardzonych tłuszczów"), "bez utwardzonych tluszczow exact");
  assertEquals(hit(names, "bez utwardzonych tłuszczów i konserwantów"), "konserwanty sub_phrase");
  assertEquals(
    hit(["!bez utwardzonych tluszczow"], "bez utwardzonych tłuszczw"),
    "bez utwardzonych tluszczow fuzzy",
  );
  assertEquals(tinyIndex(["!bez utwardzonych tluszczow"]).search("bez utwardz").length, 0);
});

Deno.test("an item with no claim name reads as before (controls from Sol 6.1 and pc-opus on #13)", () => {
  // the words after a denied name, and a food after a claim, are read as they always were
  assertEquals(
    hit(["lactose", "whey protein isolate"], "free from lactose whey protein isolate"),
    "whey protein isolate sub_phrase",
  );
  assertEquals(hit(["mleko"], "bez laktozy mleko"), "mleko sub_phrase");
  assertEquals(hit(["maka ryzowa"], "bez glutenu mąka ryżowa"), "maka ryzowa sub_phrase");
  assertEquals(hit(["sugar", "apple juice"], "no added sugar apple juice"), "apple juice sub_phrase");
  assertEquals(hit(["mleko bez laktozy", "mleko"], "mleko bez laktozy UHT"), "mleko bez laktozy sub_phrase");
  assertEquals(
    hit(["cukier", "mleko w proszku"], "bez dodatku cukru mleko w proszku"),
    "mleko w proszku sub_phrase",
  );
  assertEquals(hit(["sugar", "peanut butter"], "no added sugar peanut butter"), "peanut butter sub_phrase");
  assertEquals(
    hit(["gluten", "platki owsiane"], "nie zawiera glutenu płatki owsiane"),
    "platki owsiane sub_phrase",
  );
  // names that hold a negator word
  assertEquals(
    hit(["gluten", "non dairy creamer"], "gluten-free non-dairy creamer"),
    "non dairy creamer sub_phrase",
  );
  for (
    const text of [
      "bio czarny bez",
      "suszony czarny bez",
      "czarny bez suszony",
      "bio czarny bez liofilizowany",
    ]
  ) {
    assertEquals(hit(["czarny bez"], text), "czarny bez sub_phrase", text);
  }
  assertEquals(
    hit(["olej sojowy", "nie uwodorniony olej sojowy"], "nie uwodorniony olej sojowy rafinowany"),
    "nie uwodorniony olej sojowy sub_phrase",
  );
  assertEquals(hit(["soybean oil"], "not completely refined soybean oil"), "soybean oil sub_phrase");
  assertEquals(
    hit(["gluten", "gluten free wheat fibre"], "BIO gluten free wheat fibre"),
    "gluten free wheat fibre sub_phrase",
  );
  assertEquals(
    hit(["jaja", "jaja z wolnego wybiegu"], "świeże jaja z wolnego wybiegu"),
    "jaja z wolnego wybiegu sub_phrase",
  );
  assertEquals(hit(["woda"], "zawiera nie zaleca się stosowania u dzieci woda"), "woda sub_phrase");
  assertEquals(hit(["lactose free milk", "milk"], "lactose-free milk UHT"), "lactose free milk sub_phrase");
  // with no claim, the longest sub-phrase still wins
  assertEquals(
    hit(["sesame oil", "partially hydrogenated oil"], "sesame oil partially hydrogenated oil"),
    "partially hydrogenated oil sub_phrase",
  );
});

Deno.test("a property claim after a food does not outrank the food (Sol 6.1 on 3d20ab7)", () => {
  const ph = "!not partially hydrogenated";
  assertEquals(
    hit(["sesame oil", "partially hydrogenated oil", ph], "sesame oil not partially hydrogenated oil"),
    "sesame oil sub_phrase",
  );
  assertEquals(
    hit(
      ["olej sezamowy", "czesciowo uwodorniony", "!nie czesciowo uwodorniony"],
      "olej sezamowy nie częściowo uwodorniony",
    ),
    "olej sezamowy sub_phrase",
  );
  // another oil's own negated name after a food
  const rape = "not partially hydrogenated rapeseed oil|partially hydrogenated rapeseed oil|rapeseed oil";
  assertEquals(
    hit(["sesame oil", rape, ph], "sesame oil not partially hydrogenated rapeseed oil"),
    "sesame oil sub_phrase",
  );
  // the claim as a whole name, after a food and alone
  const own = ["sesame oil", "partially hydrogenated oil", "!not partially hydrogenated oil"];
  assertEquals(hit(own, "sesame oil not partially hydrogenated oil"), "sesame oil sub_phrase");
  assertEquals(hit(own, "not partially hydrogenated oil"), "not partially hydrogenated oil exact");
});

Deno.test("a food's own negated name is the food, wherever an exclusion stands (Sol 6.1 on d8f26e4 to 930d5c5)", () => {
  // the oil's own negated name is a plain name, so it is read as before
  const names = ["non hydrogenated sesame oil|hydrogenated sesame oil|sesame oil", "sugar"];
  const m = tinyIndex(names).match("bio non hydrogenated sesame oil");
  assertEquals([m?.ingredientId, m?.matchType, m?.matched], [
    "t0",
    "sub_phrase",
    "non hydrogenated sesame oil",
  ]);
  const r = analyze(tinyIndex(names), "Ingredients: bio non hydrogenated sesame oil - sugar", { lang: "en" });
  assertEquals(r.items.map((i) => i.match?.ingredient_id), ["t0", "t1"]);
  for (
    const [ex, text] of [
      ["gluten", "gluten-free non-hydrogenated sesame oil"],
      ["lactose", "lactose-free non-hydrogenated sesame oil"],
      ["milk|milk protein concentrate", "milk-protein-free non-hydrogenated sesame oil"],
      ["milk|milk protein concentrate", "milk protein-free non-hydrogenated sesame oil"],
      ["milk|milk protein concentrate", "milk protein free non-hydrogenated sesame oil"],
      ["wheat gluten|wheat", "wheat-gluten-free non-hydrogenated sesame oil"],
      ["gluten|lactose", "gluten- and lactose-free non-hydrogenated sesame oil"],
      ["soy|dairy", "soy and dairy free non-hydrogenated sesame oil"],
    ]
  ) {
    const m = tinyIndex([ex, ...names]).match(text);
    assertEquals([m?.ingredientId, m?.matched], ["t1", "non hydrogenated sesame oil"], text);
  }
  // an exclusion between two foods: the claim name, not the exclusion, decides (Sol 6.1 on 271aa26 and 930d5c5)
  const rape = "not partially hydrogenated rapeseed oil|partially hydrogenated rapeseed oil|rapeseed oil";
  for (
    const ex of [
      "gluten-free",
      "milk-protein-free",
      "milk protein-free",
      "milk protein free",
      "soy and dairy free",
    ]
  ) {
    const list = [
      "sesame oil",
      "gluten|milk|milk protein concentrate|soy|dairy",
      rape,
      "!not partially hydrogenated",
    ];
    assertEquals(
      hit(list, `sesame oil ${ex} not partially hydrogenated rapeseed oil`),
      "sesame oil sub_phrase",
      ex,
    );
  }
});

Deno.test("an item that opens with a claim reads the food after it, not a word of the claim (pc-opus)", () => {
  const claim = "!bez utwardzonych tluszczow";
  assertEquals(
    hit(["bez|czarny bez", "olej rzepakowy", claim], "bez utwardzonych tłuszczów olej rzepakowy"),
    "olej rzepakowy sub_phrase",
  );
  assertEquals(hit(["bez|czarny bez", "olej", claim], "bez utwardzonych tłuszczów olej"), "olej sub_phrase");
  assertEquals(
    hit(
      ["no|without", "peanut oil", "hydrogenated fat", "!no hydrogenated fat"],
      "no hydrogenated fat peanut oil",
    ),
    "peanut oil sub_phrase",
  );
  assertEquals(
    hit(["mleko", "bez", "laktoza|laktozy", "!bez laktozy"], "bez laktozy mleko"),
    "mleko sub_phrase",
  );
  // a name that opens the item and runs past the claim is read: a food's own negated name
  assertEquals(
    hit(
      ["nie uwodorniony olej sojowy|olej sojowy", "!nie uwodorniony"],
      "nie uwodorniony olej sojowy rafinowany",
    ),
    "nie uwodorniony olej sojowy sub_phrase",
  );
});

Deno.test("claims back to back, a claim then a food, a food running into a claim (pc-opus)", () => {
  const two = [
    "olej sezamowy",
    "!bez utwardzonych tluszczow",
    "!bez konserwantow",
    "konserwanty|konserwantow",
  ];
  assertEquals(
    hit(two, "olej sezamowy bez utwardzonych tłuszczów bez konserwantów"),
    "olej sezamowy sub_phrase",
  );
  assertEquals(
    hit(two, "bez utwardzonych tłuszczów bez konserwantów olej sezamowy"),
    "olej sezamowy sub_phrase",
  );
  // overlapping claims
  const lap = ["olej sojowy", "!nie zawiera utwardzonych", "!utwardzonych tluszczow", "tluszcze|tluszczow"];
  assertEquals(hit(lap, "olej sojowy nie zawiera utwardzonych tłuszczów"), "olej sojowy sub_phrase");
  // a claim, then a food: the food, not the name the claim denies
  assertEquals(
    hit(
      ["olej palmowy|oleju palmowego", "olej rzepakowy", "!bez oleju palmowego"],
      "bez oleju palmowego olej rzepakowy",
    ),
    "olej rzepakowy sub_phrase",
  );
  // a food whose name runs into a claim starts before it, so it is read
  assertEquals(
    hit(["czarny bez", "!bez utwardzonych tluszczow"], "czarny bez utwardzonych tłuszczów"),
    "czarny bez sub_phrase",
  );
});

Deno.test("an exact name may be no other name anywhere (validator)", () => {
  const ing = (id: string, names: string[], exact: string[] = [], variant: string[] = []) =>
    ({
      id,
      names: { en: names },
      exact_names: exact.length ? { en: exact } : undefined,
      variants: variant.length ? [{ id: "v", names: { en: variant } }] : undefined,
    }) as unknown as IngredientT;
  assertEquals(exactNameClashes([ing("a", ["x"], ["no x"]), ing("b", ["y"])]), []);
  assertEquals(exactNameClashes([ing("a", ["x"], ["no x"]), ing("b", ["No X"])]), [
    'name "no x" of b is also an exact name of a',
  ]);
  assertEquals(exactNameClashes([ing("a", ["x"], ["no x"]), ing("b", ["y"], [], ["no-x"])]), [
    'name "no x" of b is also an exact name of a',
  ]);
  assertEquals(exactNameClashes([ing("a", ["x", "no x"], ["no x"])]), [
    'name "no x" of a is also an exact name of a',
  ]);
  assertEquals(exactNameClashes([ing("a", ["x"], ["no x"]), ing("b", ["y"], ["no x"])]), [
    'exact name "no x" is claimed by both a and b',
  ]);
});
