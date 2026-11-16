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
const run = (text: string) => {
  const r = analyze(index, text, { lang: "pl" });
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
