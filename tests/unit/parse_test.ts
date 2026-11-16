import { assert, assertEquals } from "@std/assert";
import { normName } from "../../src/core/normalize.ts";
import { type NameOracle, type ParsedItem, parseLabel, splitTopLevel, walk } from "../../src/core/parse.ts";

const names = (text: string, lang?: string) => parseLabel(text, { lang }).items.map((i) => i.name);

Deno.test("header is stripped in PL, EN and DE", () => {
  assertEquals(names("Skład: cukier, sól"), ["cukier", "sól"]);
  assertEquals(names("BATON PROTEINOWY. Składniki: cukier, sól"), ["cukier", "sól"]);
  assertEquals(names("Ingredients: sugar, salt"), ["sugar", "salt"]);
  assertEquals(names("Zutaten: Zucker, Salz"), ["Zucker", "Salz"]);
  assertEquals(names("cukier, sól"), ["cukier", "sól"]); // no header at all
});

Deno.test("multi-language pack: the block in the requested language wins", () => {
  const label = "Skład: cukier, sól. Ingredients: sugar, salt. Zutaten: Zucker, Salz.";
  assertEquals(names(label), ["cukier", "sól"]);
  assertEquals(names(label, "en"), ["sugar", "salt"]);
  assertEquals(names(label, "de"), ["Zucker", "Salz"]);
  assertEquals(parseLabel(label, { lang: "de" }).lang, "de");
});

Deno.test("decimal commas never split an item", () => {
  assertEquals(splitTopLevel("kakao 12,5%, cukier"), ["kakao 12,5%", "cukier"]);
  const [kakao] = parseLabel("kakao 12,5%, cukier").items;
  assertEquals(kakao.percent, { value: 12.5, min: 12.5, max: 12.5, raw: "12,5%" });
  assertEquals(kakao.name, "kakao");
});

Deno.test("QUID forms: plain, bracketed, min./max., less-than clause", () => {
  const items = parseLabel("mleko (35%), orzechy min. 20%, sól max 1%, woda").items;
  assertEquals(items[0].percent?.value, 35);
  assertEquals(items[0].children.length, 0);
  assertEquals(items[1].percent, { min: 20, raw: "min. 20%" });
  assertEquals(items[2].percent, { max: 1, raw: "max 1%" });
  const us = parseLabel("Ingredients: water, sugar, contains 2% or less of: salt, citric acid").items;
  assertEquals(us.map((i) => i.name), ["water", "sugar", "salt", "citric acid"]);
  assertEquals(us[2].percent?.max, 2);
  assertEquals(us[0].percent, undefined);
});

Deno.test("nested brackets build a tree; [] and {} count as brackets", () => {
  const [choc] = parseLabel(
    "czekolada mleczna 20% (cukier, masa kakaowa, mleko w proszku [odtłuszczone], emulgator: lecytyny (soja))",
  ).items;
  assertEquals(choc.name, "czekolada mleczna");
  assertEquals(choc.percent?.value, 20);
  assertEquals(choc.children.map((c) => c.name), ["cukier", "masa kakaowa", "mleko w proszku", "lecytyny"]);
  assertEquals(choc.children[2].children.map((c) => c.name), ["odtłuszczone"]);
  assertEquals(choc.children[3].header, "emulgator");
  assertEquals(choc.children[3].children[0].name, "soja");
  const paths = [...walk([choc])].map((i) => i.path);
  assertEquals(paths, ["1", "1.1", "1.2", "1.3", "1.3.1", "1.4", "1.4.1"]);
});

Deno.test("class headers are recorded and inherited by the following items", () => {
  const items = parseLabel("cukier, emulgatory: lecytyny, E471, sól").items;
  assertEquals(items[1].header, "emulgatory");
  assertEquals(items[1].name, "lecytyny");
  assertEquals(items[2].inheritedHeader, "emulgatory");
  assertEquals(items[3].inheritedHeader, "emulgatory"); // the analyser drops it: salt is no emulsifier
  assertEquals(items[0].inheritedHeader, undefined);
});

Deno.test("source qualifiers and bare E-numbers get their own roles", () => {
  const [lec, acid, ol] =
    parseLabel("lecytyna (z soi), kwas cytrynowy (E330), olej (pochodzenia roślinnego)").items;
  assertEquals(lec.children[0].role, "qualifier");
  assertEquals(lec.children[0].name, "z soi");
  assertEquals(acid.children[0].role, "e_number");
  assertEquals(ol.children[0].role, "qualifier");
  const [whey] = parseLabel("whey protein (from milk)").items;
  assertEquals(whey.children[0].role, "qualifier");
  const [sub] = parseLabel("nadzienie (cukier, olej)").items;
  assert(sub.children.every((c) => c.role === "ingredient"));
});

Deno.test("a bare E-number is an annotation only when it is alone in the brackets besides qualifiers", () => {
  const [lec] = parseLabel("lecytyny (z soi) (E322)").items;
  assertEquals(lec.children.map((c) => c.role), ["qualifier", "e_number"]);
  // Real label (Open Food Facts 5900617013064): E492 is one of the chocolate's ingredients.
  const [choc] =
    parseLabel("czekolada 25% (miazga kakaowa, cukier, emulgatory: lecytyny (z soi), E492)").items;
  assertEquals(choc.children.map((c) => c.role), ["ingredient", "ingredient", "ingredient", "ingredient"]);
  const [colours] = parseLabel("barwniki (E120, E110)").items;
  assertEquals(colours.children.map((c) => c.role), ["ingredient", "ingredient"]);
});

Deno.test("CAPS emphasis is captured, but not on an all-caps label", () => {
  const [whey] = parseLabel("koncentrat białka serwatkowego (z MLEKA), cukier").items;
  assertEquals(whey.emphasized, ["MLEKA"]);
  const caps = parseLabel("SKŁAD: CUKIER, MLEKO W PROSZKU, SÓL").items;
  assert(caps.every((i) => i.emphasized.length === 0));
  const [e] = parseLabel("barwnik E120, DL-malic acid").items;
  assertEquals(e.emphasized, []);
});

Deno.test("OFF underscore emphasis is captured and stripped from the name, also on an all-caps label", () => {
  const items = parseLabel("_Śmietanka_, _ser twarogowy_ ziarnisty, białka _mleka_, sól").items;
  assertEquals(items.map((i) => i.name), ["Śmietanka", "ser twarogowy ziarnisty", "białka mleka", "sól"]);
  assertEquals(items.map((i) => i.emphasized), [["Śmietanka"], ["ser twarogowy"], ["mleka"], []]);
  // The raw text stays as printed.
  assertEquals(items[0].raw, "_Śmietanka_");
  // Explicit marks count where capitals cannot: "_MLEKO_" is one emphasis, not two.
  const caps = parseLabel("SKŁAD: CUKIER, _MLEKO_ W PROSZKU, SÓL").items;
  assertEquals(caps.map((i) => i.emphasized), [[], ["MLEKO"], []]);
  // A bracketed part carries its marks to the item, as CAPS emphasis does.
  const [wsad] = parseLabel("wsad (cukier, _mleko_)").items;
  assertEquals([wsad.emphasized, wsad.children[1].name], [["mleko"], "mleko"]);
  // Underscores that are not marks are left alone.
  assertEquals(parseLabel("aromat_naturalny, _ ").items.map((i) => [i.name, i.emphasized]), [[
    "aromat_naturalny",
    [],
  ], [
    "_",
    [],
  ]]);
  // Capitals inside a marked span are that span's emphasis, not extra words; capitals outside still count.
  const [powder, nuts] = parseLabel("_MLEKO W PROSZKU_ (ORZECHY), cukier").items;
  assertEquals(powder.emphasized, ["MLEKO W PROSZKU", "ORZECHY"]);
  assertEquals(nuts.name, "cukier");
});

Deno.test("an unclosed underscore costs linear time", () => {
  // Two lazy runs around one letter backtracked quadratically: 12k characters took 73–115 ms, 50k 1.2 s.
  const text = "_" + "a".repeat(50_000);
  const t = performance.now();
  const [item] = parseLabel(text).items;
  const ms = performance.now() - t;
  assertEquals([item.name.length, item.emphasized], [50_001, []]);
  assert(ms < 500, `took ${ms.toFixed(0)} ms`);
});

Deno.test("precautionary clause is split off in PL, EN and DE", () => {
  const pl = parseLabel("Skład: cukier, kakao. Może zawierać orzechy laskowe i sezam.");
  assertEquals(pl.items.map((i) => i.name), ["cukier", "kakao"]);
  assertEquals(pl.mayContain, "Może zawierać orzechy laskowe i sezam");
  const en = parseLabel("Ingredients: sugar, cocoa. May contain traces of peanuts.");
  assertEquals(en.items.map((i) => i.name), ["sugar", "cocoa"]);
  assert(en.mayContain?.startsWith("May contain"));
  const de = parseLabel("Zutaten: Zucker, Kakao. Kann Spuren von Soja enthalten.");
  assertEquals(de.items.map((i) => i.name), ["Zucker", "Kakao"]);
  assert(de.mayContain?.includes("Soja"));
});

Deno.test("trailing storage/nutrition text is not parsed as ingredients", () => {
  const r = parseLabel(
    "Skład: cukier, sól. Przechowywać w suchym miejscu. Wartość odżywcza w 100 g: energia 1500 kJ",
  );
  assertEquals(r.items.map((i) => i.name), ["cukier", "sól"]);
  assert(r.trailing?.startsWith("Przechowywać"));
  const en = parseLabel("Ingredients: sugar, salt.\nStore in a cool dry place.");
  assertEquals(en.items.map((i) => i.name), ["sugar", "salt"]);
});

Deno.test("mandatory statements are recorded", () => {
  const r = parseLabel(
    "Skład: substancje słodzące: aspartam. Zawiera źródło fenyloalaniny. Nadmierne spożycie może mieć efekt przeczyszczający.",
  );
  assertEquals(r.statements.sort(), ["laxative", "phenylalanine"]);
  assertEquals(r.items.map((i) => i.name), ["aspartam"]);
  const s = parseLabel(
    "Ingredients: sugar, sunset yellow. May have an adverse effect on activity and attention in children.",
  );
  assert(s.statements.includes("southampton"));
});

Deno.test("newlines, bullets and stray punctuation", () => {
  assertEquals(names("Skład:\ncukier\nsól\n"), ["cukier", "sól"]);
  assertEquals(names("cukier • sól · woda"), ["cukier", "sól", "woda"]);
  assertEquals(names("cukier,, , sól ;"), ["cukier", "sól"]);
  assertEquals(names("  "), []);
});

Deno.test("unbalanced brackets do not lose text", () => {
  const [a] = parseLabel("czekolada (cukier, kakao").items;
  assertEquals(a.children.map((c) => c.name), ["cukier", "kakao"]);
  const r = parseLabel("cukier), sól");
  assertEquals(r.items.map((i) => i.name), ["cukier", "sól"]);
});

// ---------------------------------------------------------------- dash and full-stop separators (issue #6)
// A stand-in for the KB: the parser only asks whether a text is a class, or which ingredient a name is.
const CLASSES: Record<string, string> = {
  "regulator kwasowosci": "acidity-regulator",
  "emulgator": "emulsifier",
  "substancje spulchniajace": "raising-agent",
};
const KNOWN: Record<string, string> = {
  "kwas cytrynowy": "citric-acid",
  "e330": "citric-acid",
  "lecytyny": "lecithins",
  "mono i diglicerydy kwasow tluszczowych": "mono-and-diglycerides",
  "weglany amonu": "ammonium-carbonates",
  "weglany sodu": "sodium-carbonates",
  "difosforany": "diphosphates",
  "syrop glukozowo fruktozowy": "glucose-fructose-syrup",
  "drozdze": "yeast",
  "ocet": "vinegar",
  "cukier": "sugar",
  "aromat": "flavouring",
  "ryba": "fish",
  "mintaj": "pollock",
  "miazga kakaowa": "cocoa-mass",
  "papryczka chilli": "capsicum",
  "serwatka w proszku": "whey-powder",
  "z mleka": "milk",
  "zywe kultury bakterii oraz l": "bacterial-cultures",
  "acidophilus": "lactobacillus-acidophilus",
};
const kb: NameOracle = { classOf: (t) => CLASSES[normName(t)], confident: (n) => KNOWN[normName(n)] };
const shape = (items: ParsedItem[]) => items.map((i) => [i.path, i.name, i.header, i.inheritedHeader]);

Deno.test("a class header printed with a dash or a full stop heads its item like the colon form", () => {
  const colon = parseLabel("cukier, regulator kwasowości: kwas cytrynowy").items;
  for (const sep of [" - ", ". "]) {
    const items = parseLabel(`cukier, regulator kwasowości${sep}kwas cytrynowy, sól`, { kb }).items;
    assertEquals(shape(items.slice(0, 2)), shape(colon));
    assertEquals(items[1].header, "regulator kwasowości");
    assertEquals(items[1].raw, `regulator kwasowości${sep}kwas cytrynowy`); // the text stays as printed
    // A full stop is a colon mistyped and opens a list; a dash heads only its own item.
    const scope = sep === ". " ? "regulator kwasowości" : undefined;
    assertEquals(shape([items[2]]), [["3", "sól", undefined, scope]]);
  }
  // Several dashed parts after the class are all under it, and only they are.
  assertEquals(shape(parseLabel("emulgator - lecytyny - E330, sól", { kb }).items), [
    ["1", "lecytyny", "emulgator", undefined],
    ["2", "E330", undefined, "emulgator"],
    ["3", "sól", undefined, undefined],
  ]);
  // A colon list before it ends there too: a new class was named.
  assertEquals(
    shape(parseLabel("emulgator: lecytyny, regulator kwasowości - kwas cytrynowy, ocet", { kb }).items),
    [
      ["1", "lecytyny", "emulgator", undefined],
      ["2", "kwas cytrynowy", "regulator kwasowości", undefined],
      ["3", "ocet", undefined, undefined],
    ],
  );
  // Without the KB the parser cannot know, and leaves the item alone.
  assertEquals(shape(parseLabel("regulator kwasowości - kwas cytrynowy").items), [
    ["1", "regulator kwasowości - kwas cytrynowy", undefined, undefined],
  ]);
});

Deno.test("a spaced dash between known names is a list: sibling items, numbered in order", () => {
  const items =
    parseLabel("mąka, substancje spulchniające: węglany amonu - węglany sodu - difosforany, sól", { kb })
      .items;
  const h = "substancje spulchniające";
  assertEquals(shape(items), [
    ["1", "mąka", undefined, undefined],
    ["2", "węglany amonu", h, undefined],
    ["3", "węglany sodu", undefined, h],
    ["4", "difosforany", undefined, h],
    ["5", "sól", undefined, h],
  ]);
  assertEquals(items.map((i) => i.raw), [
    `mąka`,
    `${h}: węglany amonu`,
    "węglany sodu",
    "difosforany",
    "sól",
  ]);
  // Inside brackets: the parts are children in order, each keeping its own brackets; percent stays on the parent.
  const [dough, sugar] =
    parseLabel("ciasto 40% (mąka, węglany amonu - węglany sodu (E500)), cukier", { kb }).items;
  assertEquals(dough.percent?.value, 40);
  assertEquals([...walk([dough])].map((i) => [i.path, i.name, i.role]), [
    ["1", "ciasto", "ingredient"],
    ["1.1", "mąka", "ingredient"],
    ["1.2", "węglany amonu", "ingredient"],
    ["1.3", "węglany sodu", "ingredient"],
    ["1.3.1", "E500", "e_number"],
  ]);
  assertEquals(sugar.path, "2");
});

Deno.test("full stops are cut before dashes, so a hyphenated word inside a part stays whole", () => {
  assertEquals(shape(parseLabel("emulgator. mono - i diglicerydy kwasów tłuszczowych", { kb }).items), [
    ["1", "mono - i diglicerydy kwasów tłuszczowych", "emulgator", undefined],
  ]);
  const named = (t: string) => parseLabel(t, { kb }).items.map((i) => i.name);
  assertEquals(named("syrop glukozowo - fruktozowy. drożdże"), ["syrop glukozowo - fruktozowy", "drożdże"]);
  assertEquals(named("ocet. cukier"), ["ocet", "cukier"]);
});

Deno.test("a dash or a full stop the KB cannot vouch for leaves the item exactly as printed", () => {
  for (
    const text of [
      "mono - i diglicerydy kwasów tłuszczowych", // "mono" alone is no ingredient
      "syrop glukozowo - fruktozowy", // a hyphenated word
      "aro - mat", // a word broken across lines
      "Ryba - Katsuwonus pelamis", // a species gloss
      "A - Mintaj", // a key letter
      "miazga kakaowa - w polewie kakaowej", // where it is used
      "papryczka chilli - płatki", // its form
      "Gatunek i pochodzenie ryb - patrz nadruk",
      "serwatka w proszku - z mleka", // a source qualifier, though both halves are known
      "E330 - kwas cytrynowy", // one ingredient named twice
      "żywe kultury bakterii oraz L. acidophilus", // a genus initial, though both halves are known
      "tzw. aromat",
      "regulator kwasowości - nowy składnik", // a class, then nothing the KB knows
    ]
  ) {
    assertEquals(parseLabel(text, { kb }), parseLabel(text), text);
  }
});
