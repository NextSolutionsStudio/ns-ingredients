// Property tests: the parser and analyser must never throw, and structural invariants hold for
// arbitrary input — including hostile unicode, unbalanced brackets and huge nesting.
import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import { analyze } from "../../src/core/analyze.ts";
import { canonicalENumber, findENumbers, normName } from "../../src/core/normalize.ts";
import { parseLabel, prepare, walk } from "../../src/core/parse.ts";
import { AnalysisResponse } from "../../src/http/schemas.ts";
import { fixtureIndex } from "../helpers.ts";

const idx = await fixtureIndex();
const labelish = fc.array(
  fc.oneof(
    fc.constantFrom(
      "cukier",
      "mleko",
      "lecytyny",
      "(",
      ")",
      "[",
      "]",
      ",",
      ";",
      ".",
      ":",
      "%",
      " ",
      "12,5",
      "E296",
      "z soi",
      "Skład:",
      "Może zawierać",
      "MLEKA",
      "emulgator:",
      "\n",
      "kwas L-jabłkowy",
      "min.",
      "Przechowywać",
    ),
    fc.string({ maxLength: 8 }),
    fc.fullUnicodeString({ maxLength: 4 }),
  ),
  { maxLength: 60 },
).map((parts) => parts.join(" "));

Deno.test("parser never throws and every item comes from the input", () => {
  fc.assert(
    fc.property(labelish, (text) => {
      const r = parseLabel(text);
      const source = normName(prepare(text));
      for (const it of walk(r.items)) {
        assert(it.path.split(".").every((n) => /^\d+$/.test(n)));
        for (const word of normName(it.name).split(" ").filter(Boolean)) {
          assert(source.includes(word), `${word} not in input`);
        }
      }
    }),
    { numRuns: 400 },
  );
});

Deno.test("analyser never throws and always satisfies the response contract", () => {
  fc.assert(
    fc.property(labelish, (text) => {
      const r = analyze(idx, text, { profile: { avoid: ["allergen.*"], diets: ["vegan"] } });
      AnalysisResponse.parse(r);
      assert(r.coverage.matched <= r.coverage.ingredients);
      assert(r.coverage.ratio >= 0 && r.coverage.ratio <= 1);
    }),
    { numRuns: 300 },
  );
});

Deno.test("deep nesting and very long input stay fast", () => {
  const deep = "a (".repeat(2000) + "b" + ")".repeat(2000);
  let t = performance.now();
  parseLabel(deep);
  assert(performance.now() - t < 1000, "2000-deep nesting parses in < 1 s");
  const long = Array.from({ length: 400 }, (_, i) => `składnik${i} (${i % 7}%)`).join(", ");
  t = performance.now();
  analyze(idx, long);
  assert(performance.now() - t < 2000, "400-item label analyses in < 2 s");
});

Deno.test("normName is idempotent; canonical E-numbers round-trip", () => {
  fc.assert(fc.property(fc.string(), (s) => normName(normName(s)) === normName(s)), { numRuns: 500 });
  fc.assert(
    fc.property(
      fc.integer({ min: 100, max: 1599 }),
      fc.constantFrom("", "a", "b"),
      fc.constantFrom("", "(i)", "(ii)"),
      (n, l, r) => {
        const code = `E${n}${l}${r}`;
        assertEquals(canonicalENumber(code), code);
        assertEquals(canonicalENumber(code.toLowerCase().replace("e", "e ")), code);
        assertEquals(findENumbers(`x, ${code}, y`).map((f) => f.code), [code]);
      },
    ),
  );
});
