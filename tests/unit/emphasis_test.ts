import { assert, assertEquals, assertFalse } from "@std/assert";
import { analyze } from "../../src/core/analyze.ts";
import { AnalysisResponse } from "../../src/http/schemas.ts";
import { fixtureIndex } from "../helpers.ts";

const idx = await fixtureIndex();
const run = (text: string, opts: Parameters<typeof analyze>[2] = {}) => {
  const r = analyze(idx, text, opts);
  AnalysisResponse.parse(r);
  return r;
};
const CODE = "allergen.unrecognised_emphasis";
const notice = (r: ReturnType<typeof run>) => r.flags.find((f) => f.code === CODE);

Deno.test("an emphasised item the KB does not know raises a possible-allergen notice", () => {
  // The fixture has no whey powder: SÜSSMOLKENPULVER is emphasised, as EU law requires for allergens, and unknown.
  const r = run("Zutaten: Zucker, SÜSSMOLKENPULVER, Salz.", { lang: "en" });
  assertEquals(r.items[1].match, null);
  const f = notice(r)!;
  assert(f, "no notice for an unknown emphasised item");
  assertEquals([f.group, f.severity, f.concern, f.certainty, f.kind], [
    "allergen",
    "notice",
    "sensitivity",
    "maybe",
    "estimate",
  ]);
  const t = f.triggers[0];
  assertEquals([t.path, t.basis, t.ingredient_id], ["2", "emphasis", undefined]);
  assert(t.note.includes("SÜSSMOLKENPULVER"), t.note);
  assertEquals(t.sources.map((s) => s.id), ["reg-1169-2011"]);
  assert(r.sources["reg-1169-2011"], "the cited regulation is resolved");
});

Deno.test("no notice when the emphasis is explained: a known allergen, a known non-allergen, all capitals, BIO", () => {
  // MILK resolves to milk: the allergen is flagged, so the emphasis is accounted for.
  const milk = run("Ingredients: sugar, whole MILK powder, salt.");
  assert(milk.flags.some((f) => f.code === "allergen.milk"));
  assertFalse(notice(milk));
  // SUGAR is known and carries no allergen: the KB knows what it is.
  assertFalse(notice(run("Ingredients: SUGAR, salt.")));
  // A label printed entirely in capitals emphasises nothing.
  assertFalse(notice(run("INGREDIENTS: SUGAR, ZORBLEX POWDER, SALT.")));
  // An organic marker is not allergen emphasis.
  assertFalse(notice(run("Zutaten: BIO-Zucker, Salz.")));
  // FCF is part of a colour name (Brilliant Blue FCF), not emphasis.
  assertFalse(notice(run("Skład: cukier, barwnik: błękit brylantowy FCF.")));
});

Deno.test("the notice is a sensitivity: danger only when the profile avoids allergens", () => {
  const text = "Zutaten: Zucker, SÜSSMOLKENPULVER, Salz.";
  assertEquals(run(text).summary.danger, null);
  const r = run(text, { profile: { avoid: ["allergen.*"] } });
  assertEquals(r.summary.danger, "notice");
  assertEquals(r.ranking[0].path, "2");
});
