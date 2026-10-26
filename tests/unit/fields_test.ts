import { assert, assertEquals } from "@std/assert";
import { parseFields, pick, schemaPaths } from "../../src/http/fields.ts";
import { AnalysisResponse } from "../../src/http/schemas.ts";
import { analyze } from "../../src/core/analyze.ts";
import { fixtureIndex } from "../helpers.ts";

const PATHS = schemaPaths(AnalysisResponse);
const idx = await fixtureIndex();

Deno.test("valid paths come from the response schema, through arrays, nullables and the recursive item tree", () => {
  for (
    const p of [
      "summary",
      "summary.danger",
      "flags.triggers.note",
      "ranking.reasons.label",
      "items.children.name",
    ]
  ) {
    assert(PATHS.includes(p), p);
  }
  for (const p of ["nutrition.glycemic_load.range", "profile.hits.code", "sources"]) {
    assert(PATHS.includes(p), p);
  }
  assert(!PATHS.some((p) => p.startsWith("sources.")), "a record's keys are data, not fields");
});

Deno.test("selection keeps the chosen keys; arrays are implicit; a whole parent beats its parts", () => {
  const r = analyze(idx, "Skład: cukier, mleko w proszku");
  const sel = parseFields("summary.danger, flags.code,ranking", PATHS);
  assert("tree" in sel);
  const out = pick(r, sel.tree) as Record<string, unknown>;
  assertEquals(Object.keys(out).sort(), ["flags", "ranking", "summary"]);
  assertEquals(out.summary, { danger: r.summary.danger });
  assertEquals(out.flags, r.flags.map((f) => ({ code: f.code })));
  assertEquals(out.ranking, r.ranking);
  const both = parseFields("flags.code,flags", PATHS);
  assert("tree" in both);
  assertEquals((pick(r, both.tree) as { flags: unknown }).flags, r.flags);
});

Deno.test("unknown, malformed, empty or too many paths are rejected with the offenders", () => {
  assertEquals(parseFields("summary,flagz,Flags.code,a..b", PATHS), {
    invalid: ["flagz", "Flags.code", "a..b"],
  });
  assertEquals(parseFields(" , ", PATHS), { invalid: ["(empty)"] });
  const many = parseFields(Array(51).fill("summary").join(","), PATHS);
  assert("invalid" in many && many.invalid[0].startsWith("(51 paths"));
});
