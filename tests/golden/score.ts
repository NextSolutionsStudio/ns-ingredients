// Golden corpus: realistic labels with hand-written expectations, scored as precision/recall.
// Shared by tests/golden/golden_test.ts (the CI gate) and scripts/golden-report.ts (the readable report).
//
// Expectations describe what SHOULD happen, not what the analyser does today. A gap is closed by fixing the
// KB or the parser, never by editing the expectation — unless the expectation itself was wrong.
import { parse as parseYaml } from "@std/yaml";
import { z } from "zod";
import { type AnalysisResult, analyze, type ItemResult } from "../../src/core/analyze.ts";
import type { KbIndex } from "../../src/core/kb-index.ts";
import { normName } from "../../src/core/normalize.ts";

const Certainty = z.enum(["yes", "no", "maybe", "unknown"]);
const Diet = z.enum(["vegan", "vegetarian", "gluten_free", "lactose_free"]);

export const GoldenCase = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  lang: z.enum(["pl", "en", "de"]),
  category: z.enum([
    "protein_powder",
    "pre_workout",
    "bar",
    "drink",
    "confectionery",
    "supplement",
    "dairy",
    "bakery",
    "processed",
  ]),
  note: z.string().optional(),
  text: z.string().min(1),
  expect: z.object({
    /** Label item name (as printed, compared after normalisation) → ingredient id; null = must stay unmatched. */
    match: z.record(z.string(), z.string().nullable()).default({}),
    /** Ingredient id → variant id read from the label; "~id" = the top prior candidate when the label is silent. */
    variant: z.record(z.string(), z.string()).default({}),
    /** Flag codes that must be raised. "code=certainty" also pins the certainty. */
    flags: z.array(z.string()).default([]),
    /** Flag codes that must NOT be raised — false alarms are what destroys trust, so each one fails the gate. */
    absent: z.array(z.string()).default([]),
    diets: z.partialRecord(Diet, Certainty).default({}),
    /** Allergen codes that must be read from the precautionary ("may contain") clause. */
    may_contain: z.array(z.string()).default([]),
    /** When present, the exact set of mandatory label statements detected. */
    statements: z.array(z.string()).optional(),
  }).strict(),
}).strict();
export type GoldenCaseT = z.infer<typeof GoldenCase>;

export const GOLDEN_DIR = new URL("./cases/", import.meta.url);

export async function readGolden(dir: URL = GOLDEN_DIR): Promise<GoldenCaseT[]> {
  const cases: GoldenCaseT[] = [];
  const files: string[] = [];
  for await (const e of Deno.readDir(dir)) if (e.isFile && e.name.endsWith(".yaml")) files.push(e.name);
  for (const f of files.sort()) {
    const raw = parseYaml(await Deno.readTextFile(new URL(f, dir)));
    const parsed = z.array(GoldenCase).safeParse(raw);
    if (!parsed.success) throw new Error(`${f}: ${z.prettifyError(parsed.error)}`);
    cases.push(...parsed.data);
  }
  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.id)) throw new Error(`duplicate golden case id ${c.id}`);
    seen.add(c.id);
  }
  return cases;
}

export interface Tally {
  ok: number;
  total: number;
}
export interface Metrics {
  match_precision: number;
  match_recall: number;
  unmatched_kept: number;
  variant_accuracy: number;
  flag_recall: number;
  false_flags: number;
  diet_accuracy: number;
  may_contain_recall: number;
  statement_accuracy: number;
}
export interface CaseReport {
  id: string;
  problems: string[];
  result: AnalysisResult;
}
export interface GoldenReport {
  cases: CaseReport[];
  counts: Record<keyof Metrics, Tally>;
  metrics: Metrics;
}

const flatten = (items: ItemResult[]): ItemResult[] => items.flatMap((i) => [i, ...flatten(i.children)]);
const ratio = (t: Tally) => (t.total === 0 ? 1 : t.ok / t.total);

export function scoreGolden(index: KbIndex, cases: GoldenCaseT[]): GoldenReport {
  const t = (): Tally => ({ ok: 0, total: 0 });
  const c = {
    match_precision: t(),
    match_recall: t(),
    unmatched_kept: t(),
    variant_accuracy: t(),
    flag_recall: t(),
    false_flags: t(),
    diet_accuracy: t(),
    may_contain_recall: t(),
    statement_accuracy: t(),
  };
  const reports: CaseReport[] = [];

  for (const gc of cases) {
    const result = analyze(index, gc.text, { lang: gc.lang });
    const items = flatten(result.items);
    const problems: string[] = [];
    const e = gc.expect;

    for (const [label, want] of Object.entries(e.match)) {
      const found = items.filter((i) => normName(i.name) === normName(label));
      if (!found.length) {
        problems.push(`match: "${label}" is not an item of the parse`);
        if (want) c.match_recall.total++;
        else c.unmatched_kept.total++;
        continue;
      }
      for (const it of found) {
        const got = it.match?.ingredient_id ?? null;
        if (want === null) {
          c.unmatched_kept.total++;
          if (got === null) c.unmatched_kept.ok++;
          else {
            c.match_precision.total++;
            problems.push(`match: "${label}" should stay unmatched, got ${got} (${it.match!.match_type})`);
          }
          continue;
        }
        c.match_recall.total++;
        if (got === null) problems.push(`match: "${label}" → nothing, want ${want}`);
        else {
          c.match_precision.total++;
          if (got === want) (c.match_recall.ok++, c.match_precision.ok++);
          else problems.push(`match: "${label}" → ${got} (${it.match!.match_type}), want ${want}`);
        }
      }
    }

    for (const [ingredient, want] of Object.entries(e.variant)) {
      c.variant_accuracy.total++;
      const prior = want.startsWith("~");
      const id = want.replace(/^~/, "");
      const hits = items.filter((i) => i.match?.ingredient_id === ingredient);
      const ok = hits.some((i) =>
        prior
          ? i.variant?.basis === "prior" && (i.variant.id ?? i.variant.candidates?.[0]?.id) === id
          : i.variant?.basis === "label" && i.variant.id === id
      );
      if (ok) c.variant_accuracy.ok++;
      else {
        const got = hits.map((i) =>
          i.variant ? `${i.variant.basis}:${i.variant.id ?? i.variant.candidates?.[0]?.id}` : "none"
        );
        problems.push(
          `variant: ${ingredient} want ${want}, got ${got.join(",") || "ingredient not matched"}`,
        );
      }
    }

    for (const spec of e.flags) {
      c.flag_recall.total++;
      const [code, certainty] = spec.split("=");
      const f = result.flags.find((x) => x.code === code);
      if (f && (!certainty || f.certainty === certainty)) c.flag_recall.ok++;
      else problems.push(`flag: ${spec} missing${f ? ` (certainty ${f.certainty})` : ""}`);
    }
    for (const code of e.absent) {
      c.false_flags.total++;
      const f = result.flags.find((x) =>
        x.code === code || (code.endsWith(".*") && x.code.startsWith(code.slice(0, -1)))
      );
      if (!f) c.false_flags.ok++;
      else {
        const why = f.triggers.map((tr) => `${tr.ingredient_id}/${tr.basis}`).join(",");
        problems.push(`false flag: ${f.code} (${f.certainty}) from ${why}`);
      }
    }

    for (const [diet, want] of Object.entries(e.diets)) {
      c.diet_accuracy.total++;
      const got = result.diets[diet as keyof typeof result.diets].status;
      if (got === want) c.diet_accuracy.ok++;
      else problems.push(`diet: ${diet} = ${got}, want ${want}`);
    }

    const traces = new Set(result.may_contain.flatMap((m) => m.allergens));
    for (const code of e.may_contain) {
      c.may_contain_recall.total++;
      if (traces.has(code)) c.may_contain_recall.ok++;
      else problems.push(`may contain: ${code} not read (got ${[...traces].join(",") || "nothing"})`);
    }

    if (e.statements) {
      c.statement_accuracy.total++;
      const got = [...result.label_statements].sort();
      const want = [...e.statements].sort();
      if (JSON.stringify(got) === JSON.stringify(want)) c.statement_accuracy.ok++;
      else problems.push(`statements: got [${got}], want [${want}]`);
    }

    reports.push({ id: gc.id, problems, result });
  }

  const metrics = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, ratio(v)])) as unknown as Metrics;
  // A count, not a ratio: every false alarm is a failure in its own right.
  metrics.false_flags = c.false_flags.total - c.false_flags.ok;
  return { cases: reports, counts: c, metrics };
}

/** Floors for the CI gate. Raise them as the KB improves (the report prints when you can); never lower one silently. */
export const THRESHOLDS_FILE = new URL("./thresholds.json", import.meta.url);
export type Thresholds = Metrics;

export function gateFailures(m: Metrics, th: Thresholds): string[] {
  const out: string[] = [];
  for (const [k, floor] of Object.entries(th) as [keyof Metrics, number][]) {
    if (k === "false_flags") {
      if (m[k] > floor) out.push(`${k} = ${m[k]} > ${floor}`);
    } else if (m[k] + 1e-9 < floor) out.push(`${k} = ${m[k].toFixed(3)} < ${floor}`);
  }
  return out;
}
