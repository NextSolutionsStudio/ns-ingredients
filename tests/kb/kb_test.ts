// The real knowledge base: schema, cross-references and editorial rules. This is what CI runs on
// every KB pull request (in addition to deno task kb:validate).
import { assert, assertEquals } from "@std/assert";
import { analyze } from "../../src/core/analyze.ts";
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

Deno.test("every sweetener WHO names carries processing.non_sugar_sweetener; no polyol does", () => {
  const curated = bundle!.ingredients.filter((i) => i.provenance !== "wikidata");
  const has = (i: (typeof curated)[number]) =>
    (i.assertions ?? []).some((a) => a.code === "processing.non_sugar_sweetener" && a.certainty === "yes");
  // WHO 2023: acesulfame K, aspartame, advantame, cyclamates, neotame, saccharin, sucralose, stevia.
  const WHO = ["E950", "E951", "E969", "E952", "E961", "E954", "E955", "E960"];
  // E960 is a family (E960a steviol glycosides, E960c enzymatically produced ones).
  assertEquals(
    WHO.filter((e) => !curated.some((i) => i.e_number?.replace(/[a-j]$/, "") === e && has(i))),
    [],
  );
  const polyols = curated.filter((i) =>
    (i.assertions ?? []).some((a) => a.code === "health.laxative_polyol")
  );
  assert(polyols.length >= 8, `only ${polyols.length} polyols curated`);
  assertEquals(polyols.filter(has).map((i) => i.id), []);
});

Deno.test("health.added_sugar sits on free sugars only, never on a sweetener or a starch", () => {
  const withCode = bundle!.ingredients.filter((i) =>
    (i.assertions ?? []).some((a) => a.code === "health.added_sugar")
  ).map((i) => i.id);
  for (
    const id of [
      "sugar",
      "dextrose",
      "glucose-syrup",
      "glucose-fructose-syrup",
      "fructose",
      "honey",
      "lactose",
    ]
  ) {
    assert(withCode.includes(id), `${id} lacks health.added_sugar`);
  }
  for (const id of ["maltodextrin", "sorbitol", "sucralose", "inulin"]) {
    assert(!withCode.includes(id), `${id} must not carry health.added_sugar`);
  }
});

Deno.test("every source the code cites for amounts and list order exists in the KB", () => {
  // A missing id is dropped from `sources` without an error, so the citation would vanish quietly.
  const r = analyze(new KbIndex(bundle!), "sugar, wheat flour, glucose syrup, palm oil", {
    nutrition: { basis: "100g", sugars_g: 30, carbohydrate_g: 70, serving: { amount: 50, unit: "g" } },
  });
  const cited = [
    ...r.nutrition!.sugars.sources,
    ...(r.nutrition!.glycemic_load?.sources ?? []),
    ...r.flags.flatMap((f) => f.triggers.flatMap((t) => t.sources)),
  ].map((s) => s.id);
  assert(cited.includes("gi-gl-bands") && cited.includes("reg-1169-2011"), "the probe label cites nothing");
  const known = new Set(bundle!.sources.map((s) => s.id));
  assertEquals([...new Set(cited)].filter((id) => !known.has(id)), []);
});

Deno.test("glycemic entries: one per fraction, and dextrose is the reference", () => {
  const dupes: string[] = [];
  for (const ing of bundle!.ingredients) {
    const fr = (ing.glycemic ?? []).map((g) => g.fraction);
    if (new Set(fr).size !== fr.length) dupes.push(ing.id);
  }
  assertEquals(dupes, []);
  const dextrose = bundle!.ingredients.find((i) => i.id === "dextrose")!;
  assertEquals(dextrose.glycemic?.map((g) => [g.fraction, g.range]), [["sugars", [100, 100]]]);
});
