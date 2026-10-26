// The real knowledge base: schema, cross-references and editorial rules. This is what CI runs on
// every KB pull request (in addition to deno task kb:validate).
import { assert, assertEquals } from "@std/assert";
import { KbIndex } from "../../src/core/kb-index.ts";
import { normName } from "../../src/core/normalize.ts";
import { readKb } from "../../src/kb/read.ts";
import { relative } from "@std/path";
import { KB_DIR } from "../helpers.ts";

const { bundle, errors } = await readKb(KB_DIR);

Deno.test("the knowledge base validates with zero errors", () => {
  assertEquals(errors, []);
  assert(bundle);
});

Deno.test("editorial rules: no alarmist words in curated text", () => {
  // Proportionality is a legal requirement (disparagement case law), not style.
  const banned =
    /\b(dangerous|toxic|harmful|poison(?:ous)?|niebezpieczn\w*|toksyczn\w*|szkodliw\w*|trując\w*|gefährlich\w*|giftig\w*)\b/iu;
  const offenders: string[] = [];
  for (const ing of bundle!.ingredients.filter((i) => i.provenance !== "wikidata")) {
    const texts = [
      ...Object.values(ing.summary ?? {}),
      ...(ing.assertions ?? []).flatMap((a) => Object.values(a.note)),
      ...(ing.variants ?? []).flatMap((
        v,
      ) => [...Object.values(v.process), ...Object.values(v.prior_rationale ?? {})]),
    ];
    for (const t of texts) {
      // "may have an adverse effect" is the legally mandated Southampton wording; quotes of a regulation are allowed.
      const m = t.match(banned);
      if (m && !/szkodliwy wpływ na aktywność|„[^”]*”|"[^"]*"/u.test(t)) {
        offenders.push(`${ing.id}: "${m[0]}"`);
      }
    }
  }
  assertEquals(offenders, []);
});

Deno.test("every curated variant name resolves to its own variant", () => {
  const idx = new KbIndex(bundle!);
  for (const ing of bundle!.ingredients.filter((i) => i.provenance !== "wikidata")) {
    for (const v of ing.variants ?? []) {
      for (const n of Object.values(v.names ?? {}).flat()) {
        const m = idx.match(n);
        assertEquals(m?.ingredientId, ing.id, `${n} → ${m?.ingredientId}`);
      }
    }
  }
});

Deno.test("every curated name resolves back to its ingredient", () => {
  const idx = new KbIndex(bundle!);
  const wrong: string[] = [];
  for (const ing of bundle!.ingredients.filter((i) => i.provenance !== "wikidata")) {
    for (const n of Object.values(ing.names).flat()) {
      if (!normName(n)) continue;
      const m = idx.match(n);
      if (m?.ingredientId !== ing.id) wrong.push(`${ing.id}: "${n}" → ${m?.ingredientId ?? "nothing"}`);
    }
  }
  assertEquals(wrong, []);
});

Deno.test("regulated E-numbers carry an EU regulatory status when curated", () => {
  const missing = bundle!.ingredients
    .filter((i) =>
      i.provenance !== "wikidata" && i.e_number && !(i.regulatory ?? []).some((r) => r.jurisdiction === "EU")
    )
    .map((i) => i.id);
  assertEquals(missing, []);
});

Deno.test("the identity backbone covers the EU E-number range", () => {
  const withE = bundle!.ingredients.filter((i) => i.e_number).length;
  assert(withE >= 450, `only ${withE} E-numbers`);
  const pl = bundle!.ingredients.filter((i) => i.e_number && i.names.pl?.length).length;
  assert(pl / withE > 0.7, `Polish names on ${pl}/${withE}`);
});

Deno.test("kb_version names the content, not how the directory was spelled", async () => {
  // It keys ETags; "./kb" (the server default) once hashed differently from the absolute path the tests use.
  const rel = relative(Deno.cwd(), KB_DIR);
  for (const dir of [rel, `./${rel}`, `${KB_DIR}/`]) {
    assertEquals((await readKb(dir)).bundle?.version, bundle!.version, dir);
  }
});

Deno.test("all six Southampton colours carry the warning (Reg 1333/2008 Annex V)", () => {
  const SIX = ["E102", "E104", "E110", "E122", "E124", "E129"];
  const missing = SIX.filter((e) =>
    !bundle!.ingredients.some((i) =>
      i.e_number === e && i.provenance !== "wikidata" &&
      (i.assertions ?? []).some((a) => a.code === "health.southampton_colour" && a.certainty === "yes")
    )
  );
  assertEquals(missing, []);
});

Deno.test("regulatory.revoked_elsewhere names a jurisdiction outside the EU and a matching regulatory row", () => {
  const bad: string[] = [];
  for (const ing of bundle!.ingredients) {
    for (const a of (ing.assertions ?? []).filter((a) => a.code === "regulatory.revoked_elsewhere")) {
      const row = (ing.regulatory ?? []).find((r) => r.jurisdiction === a.jurisdiction);
      if (!a.jurisdiction || a.jurisdiction === "EU" || row?.status !== "banned") bad.push(ing.id);
    }
  }
  assertEquals(bad, []);
});
