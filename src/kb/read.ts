// Reads kb/ from disk, validates schema + cross-references, and returns one bundle.
// Pure apart from file reads: the loader, the validator script and the tests all call this.
import { parse as parseYaml } from "@std/yaml";
import { join } from "@std/path";
import { encodeHex } from "@std/encoding/hex";
import type { z } from "zod";
import {
  ClassesFile,
  GeneratedFile,
  ImplicationsFile,
  Ingredient,
  type IngredientT,
  type KbBundle,
  SourcesFile,
} from "./schema.ts";
import { baseENumber, normName } from "../core/normalize.ts";

export interface KbReadResult {
  bundle: KbBundle | null;
  errors: string[];
  warnings: string[];
}

async function listYaml(dir: string): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const e of Deno.readDir(dir)) {
      if (e.isFile && /\.ya?ml$/.test(e.name)) out.push(join(dir, e.name));
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  return out.sort();
}

function zodErrors(file: string, err: z.ZodError): string[] {
  return err.issues.map((i) => `${file}: ${i.path.join(".") || "(root)"}: ${i.message}`);
}

export async function readKb(root: string): Promise<KbReadResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const hashParts: string[] = [];

  const load = async (path: string): Promise<unknown> => {
    const text = await Deno.readTextFile(path);
    hashParts.push(`${path.slice(root.length).replaceAll("\\", "/")}\n${text}`);
    try {
      return parseYaml(text);
    } catch (e) {
      errors.push(`${path}: YAML parse error: ${(e as Error).message}`);
      return null;
    }
  };

  const sourcesRaw = await load(join(root, "sources.yaml"));
  const implRaw = await load(join(root, "implications.yaml"));
  const classesRaw = await load(join(root, "classes.yaml"));

  const sources = SourcesFile.safeParse(sourcesRaw);
  if (!sources.success) errors.push(...zodErrors("sources.yaml", sources.error));
  // Extra source files (kb/sources/*.yaml) let parallel contributors add citations without
  // editing one shared file.
  for (const path of await listYaml(join(root, "sources"))) {
    const extra = SourcesFile.safeParse(await load(path));
    if (!extra.success) errors.push(...zodErrors(path.slice(root.length + 1), extra.error));
    else if (sources.success) sources.data.sources.push(...extra.data.sources);
  }
  const impls = ImplicationsFile.safeParse(implRaw);
  if (!impls.success) errors.push(...zodErrors("implications.yaml", impls.error));
  const classes = ClassesFile.safeParse(classesRaw);
  if (!classes.success) errors.push(...zodErrors("classes.yaml", classes.error));

  const curated: IngredientT[] = [];
  for (const path of await listYaml(join(root, "ingredients"))) {
    const raw = await load(path);
    const r = Ingredient.safeParse(raw);
    if (!r.success) {
      errors.push(...zodErrors(path.slice(root.length + 1), r.error));
      continue;
    }
    const expected = path.replace(/^.*[\\/]/, "").replace(/\.ya?ml$/, "");
    if (r.data.id !== expected) errors.push(`${expected}.yaml: id "${r.data.id}" must match the file name`);
    curated.push(r.data);
  }

  const generated: IngredientT[] = [];
  for (const path of await listYaml(join(root, "generated"))) {
    const r = GeneratedFile.safeParse(await load(path));
    if (!r.success) errors.push(...zodErrors(path.slice(root.length + 1), r.error));
    else generated.push(...r.data.ingredients);
  }

  if (!sources.success || !impls.success || !classes.success) return { bundle: null, errors, warnings };

  // ---- uniqueness -------------------------------------------------------------------------
  const dupes = (label: string, ids: string[]) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) errors.push(`duplicate ${label} id: ${id}`);
      seen.add(id);
    }
  };
  dupes("source", sources.data.sources.map((s) => s.id));
  dupes("implication", impls.data.implications.map((i) => i.code));
  dupes("class", classes.data.classes.map((c) => c.id));
  dupes("curated ingredient", curated.map((i) => i.id));

  const sourceIds = new Set(sources.data.sources.map((s) => s.id));
  const implCodes = new Set(impls.data.implications.map((i) => i.code));
  const classIds = new Set(classes.data.classes.map((c) => c.id));
  const usedSources = new Set<string>();
  const useSource = (id: string, where: string) => {
    usedSources.add(id);
    if (!sourceIds.has(id)) errors.push(`${where}: unknown source "${id}"`);
  };
  for (const c of classes.data.classes) useSource(c.source, `class ${c.id}`);

  // ---- merge generated under curated --------------------------------------------------------
  const curatedE = new Map<string, string>();
  for (const i of curated) {
    if (!i.e_number) continue;
    if (curatedE.has(i.e_number)) {
      errors.push(`${i.id}: E-number ${i.e_number} already used by ${curatedE.get(i.e_number)}`);
    }
    curatedE.set(i.e_number, i.id);
  }
  const curatedIds = new Set(curated.map((i) => i.id));
  let superseded = 0;
  const kept: IngredientT[] = [];
  const genIds = new Set<string>();
  for (const g of generated) {
    if ((g.e_number && curatedE.has(baseENumber(g.e_number))) || curatedIds.has(g.id)) {
      superseded++;
      continue;
    }
    if (genIds.has(g.id)) {
      warnings.push(`generated: duplicate id ${g.id} dropped`);
      continue;
    }
    genIds.add(g.id);
    kept.push(g);
  }
  const all = [...curated, ...kept];
  const allIds = new Set(all.map((i) => i.id));

  // ---- per-ingredient cross-references -----------------------------------------------------
  for (const ing of curated) {
    const where = `ingredients/${ing.id}`;
    if (ing.provenance !== "wikidata" && !ing.names.pl?.length) {
      errors.push(`${where}: curated entries need Polish names`);
    }
    if (!ing.summary) warnings.push(`${where}: no summary`);
    if (ing.parent && !allIds.has(ing.parent)) errors.push(`${where}: unknown parent "${ing.parent}"`);
    for (const f of ing.functions ?? []) {
      if (!classIds.has(f)) errors.push(`${where}: unknown function class "${f}"`);
    }

    const variantIds = new Set<string>();
    let priorSum = 0;
    for (const v of ing.variants ?? []) {
      if (variantIds.has(v.id)) errors.push(`${where}: duplicate variant ${v.id}`);
      variantIds.add(v.id);
      priorSum += v.prior ?? 0;
      for (const r of v.residues ?? []) useSource(r.source, `${where}#${v.id} residue`);
      const compiled: RegExp[] = [];
      for (const t of v.tells ?? []) {
        try {
          compiled.push(new RegExp(t, "u"));
        } catch (e) {
          errors.push(`${where}#${v.id}: tell /${t}/ does not compile: ${(e as Error).message}`);
        }
      }
      // A variant's own names must trigger its tells, or the tell can never fire on a real label.
      if (compiled.length && v.names) {
        for (const lang of Object.keys(v.names) as (keyof typeof v.names)[]) {
          for (const n of v.names[lang] ?? []) {
            if (!compiled.some((re) => re.test(normName(n)))) {
              errors.push(`${where}#${v.id}: name "${n}" (${lang}) is not matched by any tell`);
            }
          }
        }
      }
      if (v.prior !== undefined && !v.prior_rationale) {
        errors.push(`${where}#${v.id}: prior without prior_rationale`);
      }
    }
    if (priorSum > 1.0001) errors.push(`${where}: variant priors sum to ${priorSum.toFixed(3)} > 1`);

    for (const [k, a] of (ing.assertions ?? []).entries()) {
      const aw = `${where} assertion[${k}] ${a.code}`;
      if (!implCodes.has(a.code)) errors.push(`${aw}: unknown implication code`);
      if (a.variant && !variantIds.has(a.variant)) errors.push(`${aw}: unknown variant "${a.variant}"`);
      for (const s of a.sources) useSource(s.id, aw);
      if (a.kind === "fact" && (a.grade === "C" || a.grade === "D")) {
        warnings.push(`${aw}: a fact graded ${a.grade} — should it be an estimate?`);
      }
    }
    for (const r of ing.regulatory ?? []) useSource(r.source, `${where} regulatory`);
    for (const r of ing.reference_values ?? []) useSource(r.source, `${where} reference value`);
  }
  for (const g of kept) {
    for (const f of g.functions ?? []) {
      if (!classIds.has(f)) errors.push(`generated ${g.id}: unknown function class "${f}"`);
    }
  }

  // ---- name collisions: one normalised name must mean one ingredient ------------------------
  const owner = new Map<string, string>();
  for (const ing of all) {
    const names = new Set<string>();
    for (const list of Object.values(ing.names)) for (const n of list ?? []) names.add(normName(n));
    for (const v of ing.variants ?? []) {
      for (const list of Object.values(v.names ?? {})) for (const n of list ?? []) names.add(normName(n));
    }
    for (const n of names) {
      if (!n) continue;
      const prev = owner.get(n);
      if (prev && prev !== ing.id) {
        const msg = `name "${n}" is claimed by both ${prev} and ${ing.id}`;
        if (curatedIds.has(prev) && curatedIds.has(ing.id)) errors.push(msg);
        else warnings.push(msg);
      } else owner.set(n, ing.id);
    }
  }

  for (const s of sources.data.sources) {
    if (!usedSources.has(s.id)) warnings.push(`source ${s.id} is never cited`);
  }

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(hashParts.sort().join("\n\u0000\n")),
  );
  const bundle: KbBundle = {
    sources: sources.data.sources,
    implications: impls.data.implications,
    classes: classes.data.classes,
    ingredients: all,
    version: `kb-${encodeHex(new Uint8Array(digest)).slice(0, 12)}`,
    counts: { curated: curated.length, generated: kept.length, superseded },
  };
  return { bundle: errors.length ? null : bundle, errors, warnings };
}
