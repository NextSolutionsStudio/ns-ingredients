import { assertEquals } from "@std/assert";
import {
  baseENumber,
  canonicalENumber,
  escapeLike,
  findENumbers,
  fold,
  guessLang,
  normName,
  trigrams,
  trigramSimilarity,
} from "../../src/core/normalize.ts";

Deno.test("fold strips diacritics and folds the letters NFKD leaves alone", () => {
  assertEquals(fold("Kwas L-Jabłkowy"), "kwas l-jablkowy");
  assertEquals(fold("Äpfelsäure"), "apfelsaure");
  assertEquals(fold("Süßungsmittel"), "sussungsmittel");
  assertEquals(fold("ŻÓŁĆ ĘĄŚŹŃ"), "zolc easzn");
  assertEquals(fold("dl-α-tokoferol"), "dl-alpha-tokoferol");
  assertEquals(fold("œ æ ø"), "oe ae o");
});

Deno.test("normName collapses punctuation to single spaces", () => {
  assertEquals(
    normName("  Mono- i diglicerydy kwasów tłuszczowych "),
    "mono i diglicerydy kwasow tluszczowych",
  );
  assertEquals(normName("kwas L-jabłkowy"), "kwas l jablkowy");
  assertEquals(normName("E-296"), "e 296");
  assertEquals(normName("..."), "");
});

Deno.test("E-numbers are found in every printed form", () => {
  const cases: [string, string[]][] = [
    ["E296", ["E296"]],
    ["e 296", ["E296"]],
    ["E-296", ["E296"]],
    ["E–296", ["E296"]],
    ["INS 296", ["E296"]],
    ["E160a(ii)", ["E160a(ii)"]],
    ["E 160 a (ii)", ["E160a(ii)"]],
    ["E331i", ["E331(i)"]],
    ["E472e", ["E472e"]],
    ["emulgator: E471, E322", ["E471", "E322"]],
    ["E12", []],
    ["E4711", []],
    ["BE296", []],
    ["E171x", []],
    ["E099", []],
    ["E1600", []],
  ];
  for (const [input, expected] of cases) {
    assertEquals(findENumbers(input).map((f) => f.code), expected, input);
  }
});

Deno.test("canonicalENumber accepts only a whole E-number", () => {
  assertEquals(canonicalENumber(" e 330 "), "E330");
  assertEquals(canonicalENumber("E330 citric"), null);
  assertEquals(canonicalENumber("citric acid"), null);
  assertEquals(baseENumber("E160a(ii)"), "E160a");
  assertEquals(baseENumber("E296"), "E296");
});

Deno.test("trigram similarity matches pg_trgm semantics", () => {
  assertEquals(trigramSimilarity(trigrams("abc"), trigrams("abc")), 1);
  assertEquals(trigramSimilarity(trigrams("abc"), trigrams("xyz")), 0);
  assertEquals(trigramSimilarity(trigrams(""), trigrams("abc")), 0);
  // Diacritics do not matter because trigrams are built on the normalised name.
  assertEquals(trigramSimilarity(trigrams("jabłkowy"), trigrams("jablkowy")), 1);
  const sim = trigramSimilarity(trigrams("sukraloza"), trigrams("sukralosa"));
  if (sim < 0.5 || sim >= 1) throw new Error(`OCR-typo similarity out of range: ${sim}`);
});

Deno.test("escapeLike neutralises LIKE metacharacters", () => {
  assertEquals(escapeLike("50%_off\\"), "50\\%\\_off\\\\");
});

Deno.test("guessLang uses headers and letters", () => {
  assertEquals(guessLang("Skład: cukier"), "pl");
  assertEquals(guessLang("Zutaten: Zucker"), "de");
  assertEquals(guessLang("Ingredients: sugar"), "en");
});
