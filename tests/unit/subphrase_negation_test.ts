// The sub-phrase pass must not let a presence claim ("bez ...", "free from ...", "does not contain ..."), or a name
// inside it, outrank the food the item names.
import { assertEquals } from "@std/assert";
import { KbIndex } from "../../src/core/kb-index.ts";
import { analyze } from "../../src/core/analyze.ts";
import type { KbBundle } from "../../src/kb/schema.ts";

/** One entry per name; a name list in brackets ("a|b") is one entry with both names. */
function tinyIndex(list: string[]): KbIndex {
  return new KbIndex({
    version: "t",
    counts: {},
    implications: [],
    sources: [],
    classes: [],
    ingredients: list.map((n, k) => ({ id: `t${k}`, names: { en: n.split("|") } })),
  } as unknown as KbBundle);
}

/** The name the item resolves to, and how. */
function hit(names: string[], text: string): string {
  const m = tinyIndex(names).match(text);
  return m ? `${names[Number(m.ingredientId.slice(1))]} ${m.matchType}` : "-";
}

Deno.test("a presence claim after a food does not outrank the food", () => {
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
    assertEquals(hit(names, text), `${want} sub_phrase`, text);
  }
});

Deno.test("a name inside the claim does not outrank the food either", () => {
  for (
    const [names, text, want] of [
      [
        ["sesame oil", "partially hydrogenated oil"],
        "sesame oil no partially hydrogenated oil",
        "sesame oil",
      ],
      [["peanut oil", "fully hydrogenated fat"], "peanut oil free from fully hydrogenated fat", "peanut oil"],
      [
        ["sesame oil", "partially hydrogenated oil"],
        "sesame oil without any partially hydrogenated oil",
        "sesame oil",
      ],
    ] as [string[], string, string][]
  ) {
    assertEquals(hit(names, text), `${want} sub_phrase`, text);
  }
});

Deno.test("an item that opens with a presence claim does not take the name it denies", () => {
  const names = ["rapeseed oil", "partially hydrogenated rapeseed oil"];
  for (
    const text of [
      "without any partially hydrogenated rapeseed oil",
      "bez dodatku partially hydrogenated rapeseed oil",
    ]
  ) {
    const m = tinyIndex(names).match(text);
    assertEquals(m?.matchType === "sub_phrase", false, `${text}: ${m?.matched}`);
  }
  // a GMO claim denies nothing about the food
  assertEquals(
    hit(names, "bez GMO partially hydrogenated rapeseed oil"),
    "partially hydrogenated rapeseed oil sub_phrase",
  );
});

Deno.test("the words after what a claim denies are still read (Sol 6.1 on #13, P2 2)", () => {
  assertEquals(
    hit(["lactose", "whey protein isolate"], "free from lactose whey protein isolate"),
    "whey protein isolate sub_phrase",
  );
  assertEquals(hit(["mleko"], "bez laktozy mleko"), "mleko sub_phrase");
  assertEquals(hit(["maka ryzowa"], "bez glutenu mąka ryżowa"), "maka ryzowa sub_phrase");
  assertEquals(hit(["sugar", "apple juice"], "no added sugar apple juice"), "apple juice sub_phrase");
  // a claim at the start is still read whole
  assertEquals(
    hit(["bez utwardzonych tluszczow"], "bez utwardzonych tłuszczów i konserwantów"),
    "bez utwardzonych tluszczow sub_phrase",
  );
  // a span from the first word may reach the claim
  assertEquals(hit(["mleko bez laktozy", "mleko"], "mleko bez laktozy UHT"), "mleko bez laktozy sub_phrase");
});

Deno.test("property negators and name words are not claims (Sol 6.1 on #13, P2 1 and P2 3)", () => {
  // "non" in a name: the creamer, not gluten
  assertEquals(
    hit(["gluten", "non dairy creamer"], "gluten-free non-dairy creamer"),
    "non dairy creamer sub_phrase",
  );
  // "bez" as elder: an opener with nothing after it is a word of a name, and a name before an opener is still read
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
  // a known name that starts with a property negator is a name, not a claim
  assertEquals(
    hit(["olej sojowy", "nie uwodorniony olej sojowy"], "nie uwodorniony olej sojowy rafinowany"),
    "nie uwodorniony olej sojowy sub_phrase",
  );
  // a property negation at the start denies a property: the food after it is read
  assertEquals(hit(["soybean oil"], "not completely refined soybean oil"), "soybean oil sub_phrase");
  // "free" and "wolny" open a claim only before "from"/"of" and "od"
  assertEquals(
    hit(["gluten", "gluten free wheat fibre"], "BIO gluten free wheat fibre"),
    "gluten free wheat fibre sub_phrase",
  );
  assertEquals(
    hit(["jaja", "jaja z wolnego wybiegu"], "świeże jaja z wolnego wybiegu"),
    "jaja z wolnego wybiegu sub_phrase",
  );
  assertEquals(hit(["woda"], "zawiera nie zaleca się stosowania u dzieci woda"), "woda sub_phrase");
});

Deno.test("a property negation after a food does not outrank the food", () => {
  assertEquals(
    hit(["sesame oil", "partially hydrogenated oil"], "sesame oil not partially hydrogenated oil"),
    "sesame oil sub_phrase",
  );
  assertEquals(
    hit(["olej sezamowy", "czesciowo uwodorniony"], "olej sezamowy nie częściowo uwodorniony"),
    "olej sezamowy sub_phrase",
  );
});

Deno.test("a property claim that negates a name is a claim, though it has a name of its own", () => {
  // "not partially hydrogenated oil" is "not" and the name "partially hydrogenated oil": after a food it is a claim
  const names = ["sesame oil", "partially hydrogenated oil", "not partially hydrogenated oil"];
  assertEquals(hit(names, "sesame oil not partially hydrogenated oil"), "sesame oil sub_phrase");
  // alone, it is still its own name
  assertEquals(hit(names, "not partially hydrogenated oil"), "not partially hydrogenated oil exact");
});

Deno.test("one claim, then a named food: the food is read (pc-opus)", () => {
  assertEquals(
    hit(["cukier", "mleko w proszku"], "bez dodatku cukru mleko w proszku"),
    "mleko w proszku sub_phrase",
  );
  assertEquals(hit(["sugar", "peanut butter"], "no added sugar peanut butter"), "peanut butter sub_phrase");
  assertEquals(
    hit(["gluten", "platki owsiane"], "nie zawiera glutenu płatki owsiane"),
    "platki owsiane sub_phrase",
  );
  // postposed "free" is not an opener: the name before it and after it are read as before
  assertEquals(hit(["lactose free milk", "milk"], "lactose-free milk UHT"), "lactose free milk sub_phrase");
});

Deno.test("a food's own negated name after a modifier is the food (Sol 6.1 on d8f26e4)", () => {
  // the plain oil's name negates its own variant's name: one entry, so it is a name, not a claim
  const names = ["non hydrogenated sesame oil|hydrogenated sesame oil|sesame oil", "sugar"];
  const m = tinyIndex(names).match("bio non hydrogenated sesame oil");
  assertEquals([m?.ingredientId, m?.matchType, m?.matched], [
    "t0",
    "sub_phrase",
    "non hydrogenated sesame oil",
  ]);
  // and the dash between it and the next item still splits them (Sol's second case)
  const r = analyze(tinyIndex(names), "Ingredients: bio non hydrogenated sesame oil - sugar", { lang: "en" });
  assertEquals(r.items.map((i) => i.match?.ingredient_id), ["t0", "t1"]);
  // a name that "free" follows is excluded, not a food before the negator (Sol 6.1 on a2bde18)
  for (
    const [ex, text] of [["gluten", "gluten-free non-hydrogenated sesame oil"], [
      "lactose",
      "lactose-free non-hydrogenated sesame oil",
    ]]
  ) {
    const m = tinyIndex([ex, ...names]).match(text);
    assertEquals([m?.ingredientId, m?.matched], ["t1", "non hydrogenated sesame oil"], text);
  }
  // so are multiword exclusions: every word before a postposed "free" (Sol 6.1 on 3eb5f6b)
  for (
    const [ex, text] of [
      ["milk|milk protein concentrate", "milk-protein-free non-hydrogenated sesame oil"],
      ["wheat gluten|wheat", "wheat-gluten-free non-hydrogenated sesame oil"],
      ["gluten|lactose", "gluten- and lactose-free non-hydrogenated sesame oil"],
    ]
  ) {
    const m = tinyIndex([ex, ...names]).match(text);
    assertEquals([m?.ingredientId, m?.matched], ["t1", "non hydrogenated sesame oil"], text);
  }
  // an exclusion does not erase a food named before it (Sol 6.1 on 271aa26)
  const three = [
    "sesame oil",
    "gluten",
    "not partially hydrogenated rapeseed oil|partially hydrogenated rapeseed oil|rapeseed oil",
  ];
  assertEquals(
    hit(three, "sesame oil gluten-free not partially hydrogenated rapeseed oil"),
    "sesame oil sub_phrase",
  );
  // and coordination without hyphens is one exclusion
  const m2 = tinyIndex(["soy|dairy", ...names]).match("soy and dairy free non-hydrogenated sesame oil");
  assertEquals([m2?.ingredientId, m2?.matched], ["t1", "non hydrogenated sesame oil"]);
  // after a food, even a food's own negated name is a claim (Sol 6.1 on 3d20ab7)
  const two = [
    "sesame oil",
    "not partially hydrogenated rapeseed oil|partially hydrogenated rapeseed oil|rapeseed oil",
  ];
  assertEquals(hit(two, "sesame oil not partially hydrogenated rapeseed oil"), "sesame oil sub_phrase");
  // another entry's name after the negator is still a claim after a food
  const other = ["sesame oil", "partially hydrogenated oil", "not partially hydrogenated oil"];
  assertEquals(hit(other, "sesame oil not partially hydrogenated oil"), "sesame oil sub_phrase");
});

Deno.test("with no claim, the longest sub-phrase still wins", () => {
  assertEquals(
    hit(["sesame oil", "partially hydrogenated oil"], "sesame oil partially hydrogenated oil"),
    "partially hydrogenated oil sub_phrase",
  );
});
