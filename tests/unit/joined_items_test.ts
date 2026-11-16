// Dash and full-stop separators on real Polish labels (issue #6), against the real knowledge base: whether a
// dash heads, lists or belongs to a word is a question about names, so a fixture KB cannot answer it.
import { assert, assertEquals } from "@std/assert";
import { analyze, type ItemResult, nameOracle } from "../../src/core/analyze.ts";
import { KbIndex } from "../../src/core/kb-index.ts";
import { parseLabel, walk } from "../../src/core/parse.ts";
import { readKb } from "../../src/kb/read.ts";
import { AnalysisResponse } from "../../src/http/schemas.ts";
import { KB_DIR } from "../helpers.ts";

const { bundle } = await readKb(KB_DIR);
const index = new KbIndex(bundle!);
const run = (text: string, lang: "pl" | "en" = "pl") => {
  const r = analyze(index, text, { lang });
  AnalysisResponse.parse(r);
  return r;
};
const ids = (items: ItemResult[]) => items.map((i) => [i.path, i.match?.ingredient_id, i.match?.match_type]);
const paths = (items: { path: string; children: unknown[] }[]): string[] =>
  [...walk(items as never)].map((i) => i.path);

// Each was one item matched only as a sub-phrase (most below 0.8), so the additive went undetected.
const CLASS_LED: [label: string, item: string, fn: string, id: string][] = [
  ["regulator kwasowości - kwas cytrynowy", "kwas cytrynowy", "acidity-regulator", "citric-acid"],
  [
    "wzmacniacz smaku - glutaminian monosodowy",
    "glutaminian monosodowy",
    "flavour-enhancer",
    "monosodium-glutamate",
  ],
  ["substancja słodząca - sukraloza", "sukraloza", "sweetener", "sucralose"],
  ["stabilizator - trifosforany", "trifosforany", "stabiliser", "triphosphates"],
  ["substancja żelująca - pektyny", "pektyny", "gelling-agent", "pectins"],
  ["substancja zagęszczająca - guma guar", "guma guar", "thickener", "guar-gum"],
  ["emulgator. lecytyny", "lecytyny", "emulsifier", "lecithins"],
  ["stabilizatory. mączka chleba świętojańskiego", "mączka chleba świętojańskiego", "stabiliser", "e410"],
  [
    "emulgator. mono - i diglicerydy kwasów tluszczowych",
    "mono - i diglicerydy kwasów tluszczowych",
    "emulsifier",
    "mono-and-diglycerides",
  ],
];

Deno.test("a class written with a dash or a full stop becomes the item's header, as with a colon", () => {
  for (const [label, item, fn, id] of CLASS_LED) {
    const r = run(`Skład: pomidory, ${label}, sól`);
    assertEquals(r.items.length, 3, label);
    const it = r.items[1];
    assertEquals([it.path, it.name, it.text, it.function?.id], ["2", item, label, fn], label);
    assertEquals([it.match?.ingredient_id, it.match?.match_type], [id, "exact"], label);
    // Salt, after the comma, gets no function from it (a dash heads one item; salt is no stabiliser either).
    assertEquals(r.items[2].function, undefined, label);
  }
});

Deno.test("citric acid behind a dashed class raises the same flags as the colon form", () => {
  const dash = run("Skład: pomidory, cukier, regulator kwasowości - kwas cytrynowy");
  const colon = run("Skład: pomidory, cukier, regulator kwasowości: kwas cytrynowy");
  const fermentation = dash.flags.find((f) => f.code === "origin.microbial_fermentation");
  assertEquals(fermentation?.triggers.map((t) => [t.path, t.ingredient_id, t.basis, t.certainty]), [
    ["3", "citric-acid", "ingredient", "yes"],
  ]);
  assertEquals(dash.flags, colon.flags);
  assertEquals(dash.coverage, colon.coverage);
});

Deno.test("a dash between known ingredients is a list: siblings, each matched on its own", () => {
  const leaveners = run(
    "Skład: mąka pszenna, substancje spulchniające: węglany amonu - węglany sodu - difosforany, sól",
  );
  assertEquals(ids(leaveners.items), [
    ["1", "wheat", "exact"],
    ["2", "ammonium-carbonates", "exact"],
    ["3", "sodium-carbonates", "exact"],
    ["4", "diphosphates", "exact"],
    ["5", "salt", "exact"],
  ]);
  // The colon header covers the whole dashed list, as it would a comma list.
  assertEquals(leaveners.items.slice(1, 4).map((i) => i.function?.id), Array(3).fill("raising-agent"));
  assertEquals(leaveners.coverage, { ingredients: 5, matched: 5, low_confidence: 0, ratio: 1 });

  assertEquals(ids(run("Skład: cytryniany sodu - węglany potasu - węglany amonu").items), [
    ["1", "sodium-citrates", "exact"],
    ["2", "e501", "exact"],
    ["3", "ammonium-carbonates", "exact"],
  ]);
  assertEquals(ids(run("Skład: difosforany - węglany sodu - węglany amonu").items), [
    ["1", "diphosphates", "exact"],
    ["2", "sodium-carbonates", "exact"],
    ["3", "ammonium-carbonates", "exact"],
  ]);
});

Deno.test("two ingredients joined by a full stop become two items", () => {
  assertEquals(ids(run("Skład: ocet. cukier").items), [["1", "vinegar", "exact"], ["2", "sugar", "exact"]]);
  assertEquals(ids(run("Skład: syrop glukozowo - fruktozowy. drożdże").items), [
    ["1", "glucose-fructose-syrup", "exact"],
    ["2", "yeast", "exact"],
  ]);
  assertEquals(ids(run("Skład: woda, dwutlenek węgla. barwnik E150d").items), [
    ["1", "water", "exact"],
    ["2", "e290", "exact"],
    ["3", "e150d", "e_number"],
  ]);
  // Before, "barwnik E 150d. kwas" read as the header of phosphoric acid and the colour was lost.
  const cola = run("Skład: dwutlenek węgla, barwnik E 150d. kwas: kwas fosforowy");
  assertEquals(ids(cola.items), [["1", "e290", "exact"], ["2", "e150d", "e_number"], ["3", "e338", "exact"]]);
  assertEquals(cola.items[2].function?.id, "acid");
});

Deno.test("items after a split are renumbered, and their place on the label counts from the split", () => {
  const r = run("Skład: mąka pszenna, substancje spulchniające: węglany amonu - węglany sodu, cukier (2%)");
  assertEquals(r.items.map((i) => [i.path, i.name, i.percent?.value]), [
    ["1", "mąka pszenna", undefined],
    ["2", "węglany amonu", undefined],
    ["3", "węglany sodu", undefined],
    ["4", "cukier", 2],
  ]);
  const sugar = r.flags.find((f) => f.code === "health.added_sugar")!;
  assert(sugar.triggers[0].note.includes("Na 4. miejscu z 4."), sugar.triggers[0].note);
});

Deno.test("re-parsing with nameOracle gives the analysis's own paths", () => {
  const text =
    "Skład: woda, cukier, dwutlenek węgla. barwnik E150d, kwas: kwas fosforowy, naturalne aromaty, " +
    "kiełki (woda, regulator kwasowości - kwas cytrynowy), substancje spulchniające: węglany amonu - węglany sodu";
  const a = run(text);
  const reparsed = parseLabel(text, { lang: "pl", kb: nameOracle(index) });
  assertEquals(paths(reparsed.items), paths(a.items));
  assertEquals(reparsed.items.length, 9);
});

// Hyphenated words, Latin names, qualifiers and forms from real labels: unchanged by the KB-aware split.
const UNCHANGED = [
  "mono - i diglicerydy kwasów tłuszczowych",
  "Mono - und Diglyceride von Speisefettsäuren",
  "syrop glukozowo - fruktozowy",
  "aro - mat",
  "jęcz - mień pełnoziarnisty",
  "liofilizowane czerwone owoce w zmiennych pro - porcjach",
  "Ryba - Katsuwonus pelamis",
  "mięso z ryby - w surimi",
  "miazga kakaowa - w polewie kakaowej",
  "kakao w proszku o obniżonej zawartości tłuszczu - w polewie kakaowej",
  "papryczka chilli - płatki",
  "A - Mintaj",
  "Gatunek i pochodzenie ryb - patrz nadruk",
  "serwatka w proszku - z mleka",
  "E330 - kwas cytrynowy",
  "żywe kultury bakterii jogurtowych oraz L. acidophilus i Bifidobacterium lactis",
];

Deno.test("hyphenated words, Latin names, qualifiers and forms stay one item", () => {
  for (const text of UNCHANGED) {
    const label = `Skład: ${text}, sól`;
    const a = run(label);
    assertEquals(a.items.map((i) => [i.path, i.name]), [["1", text], ["2", "sól"]], text);
    // Exactly what the syntax-only parse gives.
    assertEquals(
      parseLabel(label, { lang: "pl", kb: nameOracle(index) }),
      parseLabel(label, { lang: "pl" }),
      text,
    );
  }
  // The two that were confident before keep their match.
  assertEquals(run(`Skład: ${UNCHANGED[0]}`).items[0].match?.match_type, "exact");
  assertEquals(run(`Skład: ${UNCHANGED[2]}`).items[0].match?.ingredient_id, "glucose-fructose-syrup");
});

// ---------------------------------------------------------------- review of PR #9
Deno.test("a name the KB knows whole is never cut, however well its parts match", () => {
  // "glucose" is dextrose and "fructose syrup" a sub-phrase of fructose, but together they are the syrup's own
  // name: that dash is a hyphen, and cutting it lost the syrup's claims.
  assertEquals(ids(run("Ingredients: glucose - fructose syrup", "en").items), [
    ["1", "glucose-fructose-syrup", "exact"],
  ]);
  // A variant's name too: cut, "gluten" made the label not gluten-free.
  const fibre = run("Ingredients: gluten - free wheat fibre", "en");
  assertEquals(ids(fibre.items), [["1", "wheat-fibre", "variant"]]);
  assertEquals(fibre.items[0].variant?.id, "gluten-free");
  assertEquals(fibre.diets.gluten_free.status, "yes");
  // The Polish forms were one exact item on main, and stay one.
  for (const t of ["syrop glukozowo - fruktozowy", "syrop fruktozowo - glukozowy"]) {
    assertEquals(ids(run(`Skład: ${t}`).items), [["1", "glucose-fructose-syrup", "exact"]], t);
  }
  // Inside a longer dash list, only the cuts around the known name are made.
  assertEquals(ids(run("Ingredients: sugar - glucose - fructose syrup - salt", "en").items), [
    ["1", "sugar", "exact"],
    ["2", "glucose-fructose-syrup", "exact"],
    ["3", "salt", "exact"],
  ]);
  // A whole match that is only a sub-phrase proves nothing: the class still heads its additive.
  assertEquals(
    run("Skład: wzmacniacz smaku - glutaminian monosodowy").items[0].function?.id,
    "flavour-enhancer",
  );
});

Deno.test("every hyphenated KB name, printed with a spaced dash, is read as the syntax alone reads it", () => {
  let checked = 0;
  for (const ing of bundle!.ingredients) {
    const sets = [ing.names, ...(ing.variants ?? []).map((v) => v.names ?? {})];
    for (const name of sets.flatMap((ns) => Object.values(ns).flat() as string[])) {
      // One segment as printed: names with commas, colons or brackets are cut by the syntax before the KB is asked.
      if (!/\p{L}-\p{L}/u.test(name) || /[,;:()]/.test(name)) continue;
      const spaced = name.replace(/(\p{L})-(\p{L})/gu, "$1 - $2");
      const m = index.match(spaced);
      if (m?.matchType !== "exact" && m?.matchType !== "variant") continue;
      checked++;
      const label = `Skład: ${spaced}, sól`;
      assertEquals(parseLabel(label, { kb: nameOracle(index) }), parseLabel(label), spaced);
    }
  }
  assert(checked > 250, `only ${checked} names checked`);
});

Deno.test("a colon header after a dashed one opens its own list", () => {
  // The dashed class headed only lecithin; the colon after the full stop must still cover pectin.
  const r = run("Skład: emulgator - lecytyny. stabilizator: guma guar, pektyny");
  assertEquals(r.items.map((i) => [i.path, i.match?.ingredient_id, i.function?.id]), [
    ["1", "lecithins", "emulsifier"],
    ["2", "guar-gum", "stabiliser"],
    ["3", "pectins", "stabiliser"],
  ]);
  // The other way round, the dashed class replaces the colon list and ends at its comma.
  const back = run("Skład: stabilizator: guma guar, emulgator - lecytyny, pektyny");
  assertEquals(back.items.map((i) => i.function?.id), ["stabiliser", "emulsifier", undefined]);
});

Deno.test("in brackets, the parts of one dashed list share its class", () => {
  const dough = run("Skład: ciasto (substancje spulchniające - węglany amonu - węglany sodu)").items[0];
  assertEquals(dough.children.map((c) => [c.path, c.match?.ingredient_id, c.function?.id]), [
    ["1.1", "ammonium-carbonates", "raising-agent"],
    ["1.2", "sodium-carbonates", "raising-agent"],
  ]);
  // In brackets no header passes a comma, however it is printed (a colon never did).
  for (const sep of [" - ", ": ", ". "]) {
    const kids =
      run(`Skład: ciasto (substancje spulchniające${sep}węglany amonu, węglany sodu)`).items[0].children;
    assertEquals(
      kids.map((c) => [c.match?.ingredient_id, c.function?.id]),
      [["ammonium-carbonates", "raising-agent"], ["sodium-carbonates", undefined]],
      sep,
    );
  }
  // Why: in a compound's list, what follows a class is mostly not of that class. Run on to the bracket's end,
  // "emulgator: lecytyny" put the vanilla flavouring under it, and airon skład withheld the score.
  const chips = "Skład: wiórki czekolady (cukier, emulgator: lecytyny, naturalny aromat waniliowy), sól";
  const reparsed = parseLabel(chips, { lang: "pl", kb: nameOracle(index) }).items[0].children;
  assertEquals(reparsed.map((c) => [c.name, c.header ?? c.inheritedHeader]), [
    ["cukier", undefined],
    ["lecytyny", "emulgator"],
    ["naturalny aromat waniliowy", undefined],
  ]);
});

// ---------------------------------------------------------------- second review of PR #9
Deno.test("a KB name inside a segment keeps its dash, though the words around it would split", () => {
  // "gluten - free wheat fibre" is a variant's name inside a longer segment. Cut at its dash, "BIO gluten"
  // and "free wheat fibre" both matched, and the label stopped being gluten-free. On main d533da5 it was one
  // item, the variant by sub-phrase at 0.9; it still is.
  const fibre = run("Ingredients: BIO gluten - free wheat fibre", "en");
  assertEquals(ids(fibre.items), [["1", "wheat-fibre", "sub_phrase"]]);
  assertEquals([fibre.items[0].variant?.id, fibre.items[0].match?.confidence], ["gluten-free", 0.9]);
  assertEquals(fibre.diets.gluten_free.status, "yes");
  // "coconut - milk" is the coconut's own name: cut after "coconut", "milk powder" was dairy milk, a false
  // allergen. On main it was one item, coconut by sub-phrase; it still is, and nothing says milk.
  const coconut = run("Ingredients: coconut - milk powder", "en");
  assertEquals(ids(coconut.items), [["1", "coconut", "sub_phrase"]]);
  assertEquals(coconut.flags.filter((f) => f.code === "allergen.milk"), []);
  assertEquals([coconut.diets.vegan.status, coconut.diets.lactose_free.status], ["yes", "yes"]);
  // The same for a whole name with a word before it: it was dextrose and fructose, and is the syrup, as on main.
  assertEquals(ids(run("Ingredients: BIO glucose - fructose syrup", "en").items), [
    ["1", "glucose-fructose-syrup", "sub_phrase"],
  ]);
  // A separator outside the name is still cut.
  assertEquals(ids(run("Ingredients: sugar - coconut - milk", "en").items), [
    ["1", "sugar", "exact"],
    ["2", "coconut", "exact"],
  ]);
});

Deno.test("a variant tell spanning a dash keeps it: the declared variant survives", () => {
  // "gluten ?free" is the gluten-free-oats tell. Cut at the dash, "gluten" matched exactly and the label lost
  // its gluten-free oats (gluten_free went from maybe to no). On main it is one item, oats, that variant.
  const oats = run("Ingredients: gluten - free rolled oats", "en");
  assertEquals(oats.items.map((i) => [i.path, i.match?.ingredient_id, i.variant?.id]), [
    ["1", "oats", "gluten-free-oats"],
  ]);
  assertEquals(oats.diets.gluten_free.status, "maybe");
  // A tell inside one part does not hold the list together: the sugar is still cut off.
  assertEquals(
    run("Ingredients: sugar - gluten-free oats", "en").items.map((
      i,
    ) => [i.match?.ingredient_id, i.variant?.id]),
    [["sugar", undefined], ["oats", "gluten-free-oats"]],
  );
});

/** analyze() with the number of calls it made to the matcher, and its time (best of three). */
function costOf(text: string, lang: "pl" | "en" = "en") {
  const match = index.match;
  let calls = 0;
  index.match = (t: string) => (calls++, match.call(index, t));
  try {
    let ms = Infinity;
    let r = analyze(index, text, { lang });
    for (let i = 0; i < 3; i++) {
      calls = 0;
      const t = performance.now();
      r = analyze(index, text, { lang });
      ms = Math.min(ms, performance.now() - t);
    }
    return { r, calls, ms };
  } finally {
    index.match = match;
  }
}

/**
 * Up to 12,000 characters of distinct ingredients' plain English names ("sugar", "wheat flour"), joined by
 * `sep`. Each name splits from the one before it: no qualifier ("vegetable carbon"), no name across the join
 * ("oat gum - tragacanth" prints "gum tragacanth"), no genus initial ("vitamin e. walnut oil").
 */
function knownList(sep: string) {
  const kb = nameOracle(index);
  const names: string[] = [];
  let length = "Ingredients: ".length;
  for (const ing of bundle!.ingredients) {
    const name = ing.names.en?.[0];
    if (!name || !/^\p{Ll}{2,}(?: \p{Ll}{2,})*$/u.test(name) || index.classOf(name)) continue;
    if (index.match(name)?.ingredientId !== ing.id) continue;
    if (names.length && parseLabel(`${names.at(-1)}${sep}${name}`, { kb }).items.length !== 2) continue;
    if ((length += name.length + sep.length) > 12_000) break;
    names.push(name);
  }
  return { text: `Ingredients: ${names.join(sep)}`, parts: names.length };
}

Deno.test("a long dash or full-stop list costs a few matcher calls per part, never one per run of parts", () => {
  // 240 sugars (1,930 characters): looking for whole names among every run of parts made 29,160 matcher calls
  // and took ~5 s; main took ~1 ms. The limits below are far above the linear cost and far below that.
  const unknown = Array.from({ length: 460 }, (_, i) => `nieznany skladnik ${i.toString(36)}qx`);
  const cases: { what: string; text: string; parts: number }[] = [
    { what: "240 × sugar", text: `Ingredients: ${Array(240).fill("sugar").join(" - ")}`, parts: 240 },
    { what: "known names, dashes", ...knownList(" - ") },
    { what: "known names, full stops", ...knownList(". ") },
    { what: "unknown words, dashes", text: `Ingredients: ${unknown.join(" - ")}`, parts: unknown.length },
    // Repeated, a name is one ingredient named twice and nothing is cut: finding that out must be as cheap.
    ...[" - ", ". "].map((sep) => {
      const names = ["sugar", "salt", "glucose - fructose syrup", "wheat flour", "citric acid", "palm oil"];
      let text = "Ingredients: sugar";
      for (let i = 1; text.length < 11_950; i++) text += sep + names[i % names.length];
      return { what: `repeated names to 12,000 characters, "${sep}"`, text, parts: text.split(sep).length };
    }),
  ];
  for (const { what, text, parts } of cases) {
    assert(text.length <= 12_000 && parts >= 240, `${what}: ${text.length} characters, ${parts} parts`);
    const { r, calls, ms } = costOf(text);
    assert(calls <= 4 * parts, `${what}: ${calls} matcher calls for ${parts} parts`);
    assert(ms < 1_000, `${what}: ${ms.toFixed(0)} ms`);
    // The known names do become their own items: the cost is not saved by giving up the split.
    if (what.startsWith("known")) assertEquals(r.items.length, parts, what);
  }
});

Deno.test("variant tells across a separator read a few words, never a whole long part", () => {
  // Cocoa's tell "kakao.*obniz.*tluszcz" over 991 × "kakao obniz " backtracked for ~6.7 s (main: ~11 ms).
  // One long word ("kakaoobniz" × 1190) passed a word limit alone and took ~9 s: characters are capped too.
  for (
    const text of [
      "Ingredients: sugar - " + "kakao obniz ".repeat(991),
      "Ingredients: sugar - " + "kakaoobniz".repeat(1190),
    ]
  ) {
    assert(text.length <= 12_000);
    const { ms } = costOf(text);
    assert(ms < 1_000, `${text.slice(21, 40)}…: ${ms.toFixed(0)} ms`);
  }
});
