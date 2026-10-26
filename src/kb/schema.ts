// Schema of the knowledge base as authored in kb/*.yaml. The YAML is the source of truth;
// Postgres holds a read-optimised projection built by load.ts.
import { z } from "zod";

export const LANGS = ["en", "pl", "de"] as const;
export type Lang = (typeof LANGS)[number];

const slug = z.string().regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/, "lowercase slug");
export const Text = z.object({
  en: z.string().min(1),
  pl: z.string().min(1).optional(),
  de: z.string().min(1).optional(),
})
  .strict();
export const Names = z.object({
  en: z.array(z.string().min(1)).min(1),
  pl: z.array(z.string().min(1)).optional(),
  de: z.array(z.string().min(1)).optional(),
}).strict();

export const CERTAINTIES = ["yes", "no", "maybe", "unknown"] as const;
export const KINDS = ["fact", "estimate", "opinion"] as const;
export const GRADES = ["A", "B", "C", "D"] as const;
export const SEVERITIES = ["info", "notice", "caution", "warning"] as const;
/** Who a code matters to — see kb/implications.yaml. Severity says how serious, concern says for whom. */
export const CONCERNS = ["hazard", "sensitivity", "quality", "preference", "info"] as const;
export const REVIEW = ["draft", "reviewed", "imported"] as const;
export const PROVENANCE = ["human", "ai-drafted", "wikidata"] as const;
export const INGREDIENT_TYPES = [
  "additive",
  "ingredient",
  "flavouring",
  "nutrient",
  "protein",
  "fat",
  "sweetener",
  "carbohydrate",
  "processing_aid",
] as const;

export const SourceRef = z.object({ id: slug, locator: z.string().optional() }).strict();

export const Source = z.object({
  id: slug,
  type: z.enum([
    "regulation",
    "regulatory_opinion",
    "monograph",
    "systematic_review",
    "rct",
    "observational",
    "review",
    "reference",
    "dataset",
    "standard",
  ]),
  title: z.string().min(3),
  publisher: z.string().optional(),
  authors: z.string().optional(),
  year: z.number().int().min(1900).max(2100).optional(),
  url: z.url(),
  doi: z.string().regex(/^10\.\d{4,9}\/\S+$/).optional(),
  pmid: z.string().regex(/^\d+$/).optional(),
  licence: z.string().min(2),
  // YAML parses an unquoted 2026-09-27 as a Date; accept both and store the ISO day.
  accessed: z.preprocess((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v), z.iso.date()),
  note: z.string().optional(),
}).strict();

export const Implication = z.object({
  code: z.string().regex(/^[a-z]+(?:\.[a-z0-9_]+)+$/, "group.name"),
  group: z.enum(["allergen", "diet", "origin", "processing", "health", "regulatory", "ethics", "sport"]),
  severity: z.enum(SEVERITIES),
  concern: z.enum(CONCERNS),
  kind: z.enum(KINDS),
  label: Text,
  definition: Text,
  evidence_required: z.string().min(3),
}).strict();

export const FunctionClass = z.object({
  id: slug,
  names: Names,
  source: slug,
}).strict();

export const Variant = z.object({
  id: slug,
  names: Names.optional(),
  process: Text,
  residues: z.array(z.object({ substance: Text, limit: z.string().optional(), source: slug }).strict())
    .optional(),
  /** Regexes tested against normName(item text): lowercase, no diacritics, punctuation → spaces. */
  tells: z.array(z.string().min(2)).optional(),
  /** P(this variant | label silent). Priors of one ingredient's variants must sum to ≤ 1. */
  prior: z.number().min(0).max(1).optional(),
  prior_rationale: Text.optional(),
}).strict();

export const Assertion = z.object({
  code: z.string(),
  variant: slug.optional(),
  certainty: z.enum(CERTAINTIES),
  kind: z.enum(KINDS),
  grade: z.enum(GRADES),
  population: z.array(z.enum(["general", "children", "pregnancy", "athletes", "pku", "coeliac", "infants"]))
    .optional(),
  jurisdiction: z.string().optional(),
  dose: z.string().optional(),
  note: Text,
  sources: z.array(SourceRef).min(1),
}).strict();

export const Regulatory = z.object({
  jurisdiction: z.enum(["EU", "US", "UK", "CA", "AU", "CODEX"]),
  status: z.enum(["authorised", "restricted", "banned", "not_authorised"]),
  conditions: Text.optional(),
  since: z.string().optional(),
  source: slug,
}).strict();

export const ReferenceValue = z.object({
  type: z.enum(["ADI", "TDI", "UL", "group_ADI"]),
  value: z.union([z.number(), z.literal("not specified"), z.literal("not established")]),
  unit: z.string().optional(),
  body: z.enum(["EFSA", "JECFA", "SCF", "FDA", "IOM"]),
  year: z.number().int().optional(),
  source: slug,
}).strict();

export const Ingredient = z.object({
  id: slug,
  type: z.enum(INGREDIENT_TYPES),
  e_number: z.string().regex(/^E\d{3,4}[a-j]?$/).optional(),
  parent: slug.optional(),
  ids: z.object({
    cas: z.string().regex(/^\d{2,7}-\d{2}-\d$/).optional(),
    wikidata: z.string().regex(/^Q\d+$/).optional(),
    chebi: z.string().regex(/^CHEBI:\d+$/).optional(),
    pubchem: z.number().int().optional(),
    foodon: z.string().optional(),
  }).strict().optional(),
  names: Names,
  functions: z.array(slug).optional(),
  summary: Text.optional(),
  variants: z.array(Variant).optional(),
  assertions: z.array(Assertion).optional(),
  regulatory: z.array(Regulatory).optional(),
  reference_values: z.array(ReferenceValue).optional(),
  review_status: z.enum(REVIEW),
  provenance: z.enum(PROVENANCE),
  review_notes: z.array(z.string()).optional(),
}).strict();

export type SourceT = z.infer<typeof Source>;
export type ImplicationT = z.infer<typeof Implication>;
export type FunctionClassT = z.infer<typeof FunctionClass>;
export type VariantT = z.infer<typeof Variant>;
export type AssertionT = z.infer<typeof Assertion>;
export type IngredientT = z.infer<typeof Ingredient>;
export type TextT = z.infer<typeof Text>;
export type NamesT = z.infer<typeof Names>;

export const SourcesFile = z.object({ sources: z.array(Source) }).strict();
export const ImplicationsFile = z.object({ implications: z.array(Implication) }).strict();
export const ClassesFile = z.object({ classes: z.array(FunctionClass) }).strict();
export const GeneratedFile = z.object({
  generated: z.object({ source: z.string(), licence: z.string(), fetched: z.string(), query: z.string() }),
  ingredients: z.array(Ingredient),
}).strict();

export interface KbBundle {
  sources: SourceT[];
  implications: ImplicationT[];
  classes: FunctionClassT[];
  /** Curated first, then generated entries that no curated entry supersedes. */
  ingredients: IngredientT[];
  /** Content hash of every KB file — the kb_version stamped on responses. */
  version: string;
  counts: { curated: number; generated: number; superseded: number };
}
