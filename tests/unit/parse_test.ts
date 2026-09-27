import { assert, assertEquals } from "@std/assert";
import { parseLabel, splitTopLevel, walk } from "../../src/core/parse.ts";

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

Deno.test("CAPS emphasis is captured, but not on an all-caps label", () => {
  const [whey] = parseLabel("koncentrat białka serwatkowego (z MLEKA), cukier").items;
  assertEquals(whey.emphasized, ["MLEKA"]);
  const caps = parseLabel("SKŁAD: CUKIER, MLEKO W PROSZKU, SÓL").items;
  assert(caps.every((i) => i.emphasized.length === 0));
  const [e] = parseLabel("barwnik E120, DL-malic acid").items;
  assertEquals(e.emphasized, []);
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
