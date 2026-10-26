// Request/response schemas. They validate requests, generate the OpenAPI document, and the
// contract tests parse every response with them — so the published spec cannot drift.
import { z } from "@hono/zod-openapi";

export const LangParam = z.enum(["en", "pl", "de"]).optional().openapi({
  description: "Language for names and text. Defaults from Accept-Language, then English.",
  example: "pl",
});

export const Problem = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
}).openapi("Problem");

const Certainty = z.enum(["yes", "no", "maybe", "unknown"]);
const Kind = z.enum(["fact", "estimate", "opinion"]);
const Grade = z.enum(["A", "B", "C", "D"]);
const Severity = z.enum(["info", "notice", "caution", "warning"]);
const Concern = z.enum(["hazard", "sensitivity", "quality", "preference", "info"]);
const SourceRef = z.object({ id: z.string(), locator: z.string().optional() });

export const SourceSummary = z.object({
  title: z.string(),
  url: z.string(),
  year: z.number().int().optional(),
  publisher: z.string().optional(),
});

// ---------------------------------------------------------------- search
export const SearchQuery = z.object({
  q: z.string().max(200).optional().openapi({
    description: "Name in PL/EN/DE, E-number in any form, or keywords.",
    example: "kwas jabłkowy",
  }),
  lang: LangParam,
  implication: z.string().max(400).optional().openapi({
    description: "Comma-separated implication codes; results must assert each (certainty yes or maybe).",
    example: "origin.petrochemical_synthetic",
  }),
  origin: z.string().max(200).optional().openapi({
    description: "Shorthand for origin.* codes, comma-separated.",
    example: "petrochemical_synthetic",
  }),
  function: z.string().max(60).optional().openapi({
    description: "Additive function class id.",
    example: "emulsifier",
  }),
  type: z.string().max(40).optional(),
  review_status: z.enum(["draft", "reviewed", "imported"]).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(100).optional(),
});

export const SearchItem = z.object({
  id: z.string(),
  name: z.string(),
  e_number: z.string().optional(),
  type: z.string(),
  match: z.object({ type: z.string(), matched: z.string(), score: z.number() }),
  tags: z.array(z.string()).openapi({ description: "Implication codes asserted yes/maybe (any variant)." }),
  review_status: z.string(),
  provenance: z.string(),
}).openapi("SearchItem");

export const SearchResponse = z.object({
  items: z.array(SearchItem),
  total: z.number().int(),
  next_cursor: z.string().nullable(),
  kb_version: z.string(),
}).openapi("SearchResponse");

// ---------------------------------------------------------------- ingredient
export const Assertion = z.object({
  code: z.string(),
  label: z.string(),
  group: z.string(),
  severity: Severity,
  variant: z.string().optional(),
  certainty: Certainty,
  kind: Kind,
  grade: Grade,
  population: z.array(z.string()).optional(),
  jurisdiction: z.string().optional(),
  dose: z.string().optional(),
  note: z.string(),
  sources: z.array(SourceRef),
}).openapi("Assertion");

export const Ingredient = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  e_number: z.string().optional(),
  ids: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  names: z.record(z.string(), z.array(z.string())),
  functions: z.array(z.object({ id: z.string(), name: z.string() })),
  summary: z.string().nullable(),
  variants: z.array(z.object({
    id: z.string(),
    name: z.string().nullable(),
    process: z.string(),
    residues: z.array(z.object({ substance: z.string(), limit: z.string().optional(), source: z.string() })),
    prior: z.number().nullable(),
    prior_rationale: z.string().nullable(),
  })),
  assertions: z.array(Assertion),
  regulatory: z.array(z.object({
    jurisdiction: z.string(),
    status: z.string(),
    conditions: z.string().optional(),
    since: z.string().optional(),
    source: z.string(),
  })),
  reference_values: z.array(z.object({
    type: z.string(),
    value: z.union([z.number(), z.string()]),
    unit: z.string().optional(),
    body: z.string(),
    year: z.number().int().optional(),
    source: z.string(),
  })),
  review_status: z.string(),
  provenance: z.string(),
  review_notes: z.array(z.string()),
  sources: z.record(z.string(), SourceSummary),
  kb_version: z.string(),
}).openapi("Ingredient");

// ---------------------------------------------------------------- analyze
export const AnalyzeRequest = z.object({
  text: z.string().min(1).max(12_000).openapi({
    description: "Ingredient list as printed (header, precautionary clause and trailing text are handled).",
    example:
      "Skład: koncentrat białka serwatkowego (z MLEKA) 80%, kakao, emulgator: lecytyny (z soi), kwas jabłkowy, aromat.",
  }),
  lang: LangParam,
  profile: z.object({
    avoid: z.array(z.string().regex(/^[a-z]+(?:\.[a-z0-9_]+)*(?:\.\*)?$/)).max(50).optional().openapi({
      description:
        "Implication codes or group wildcards to check (e.g. allergen.*). Evaluated per request; never stored or logged.",
    }),
    diets: z.array(z.enum(["vegan", "vegetarian", "gluten_free", "lactose_free"])).max(4).optional(),
  }).strict().optional(),
  nutrition: z.object({
    basis: z.enum(["100g", "100ml"]).openapi({ description: "100ml for drinks, 100g for everything else." }),
    sugars_g: z.number().min(0).max(100).openapi({
      description: 'Total sugars as declared ("of which sugars").',
    }),
    serving: z.object({
      amount: z.number().positive().max(5000),
      unit: z.enum(["g", "ml"]),
    }).strict().optional(),
  }).strict().refine((n) => !n.serving || n.serving.unit === n.basis.slice(3), {
    message: "serving.unit must match the basis (g with 100g, ml with 100ml)",
    path: ["serving", "unit"],
  }).optional().openapi({
    description:
      "Declared nutrition from the label, the only source of amounts. Bands total sugars by the UK front-of-pack " +
      "criteria and raises health.high_sugar; never inferred from the ingredient list.",
  }),
}).strict().openapi("AnalyzeRequest");

const Match = z.object({
  ingredient_id: z.string(),
  name: z.string(),
  e_number: z.string().optional(),
  match_type: z.string(),
  confidence: z.number(),
  review_status: z.string(),
});

type ItemT = {
  path: string;
  text: string;
  name: string;
  role: "ingredient" | "qualifier" | "e_number" | "class";
  percent?: { value?: number; min?: number; max?: number; raw: string };
  emphasized: string[];
  function?: { id: string; name: string };
  match: z.infer<typeof Match> | null;
  variant: null | {
    basis: "label" | "prior";
    id?: string;
    name?: string;
    candidates?: { id: string; probability: number }[];
  };
  children: ItemT[];
};

export const AnalysisItem: z.ZodType<ItemT> = z.lazy(() =>
  z.object({
    path: z.string(),
    text: z.string(),
    name: z.string(),
    role: z.enum(["ingredient", "qualifier", "e_number", "class"]),
    percent: z.object({
      value: z.number().optional(),
      min: z.number().optional(),
      max: z.number().optional(),
      raw: z.string(),
    }).optional(),
    emphasized: z.array(z.string()),
    function: z.object({ id: z.string(), name: z.string() }).optional(),
    match: Match.nullable(),
    variant: z.object({
      basis: z.enum(["label", "prior"]),
      id: z.string().optional(),
      name: z.string().optional(),
      candidates: z.array(z.object({ id: z.string(), probability: z.number() })).optional(),
    }).nullable(),
    children: z.array(AnalysisItem),
  })
).openapi("AnalysisItem"); // a named component, so the generator emits a recursive $ref

const DietVerdict = z.object({
  status: Certainty,
  because: z.array(z.object({ path: z.string(), ingredient_id: z.string().optional(), status: Certainty })),
});

export const AnalysisResponse = z.object({
  kb_version: z.string(),
  lang: z.enum(["en", "pl", "de"]),
  items: z.array(AnalysisItem),
  flags: z.array(z.object({
    code: z.string(),
    group: z.string(),
    severity: Severity,
    concern: Concern,
    personal: z.boolean().optional(),
    label: z.string(),
    certainty: Certainty,
    kind: Kind,
    grade: Grade,
    triggers: z.array(z.object({
      path: z.string().openapi({
        description: 'A label item path, or "nutrition.sugars_g" on basis nutrition.',
      }),
      ingredient_id: z.string().optional().openapi({ description: "Absent only on basis nutrition." }),
      variant_id: z.string().optional(),
      basis: z.enum([
        "ingredient",
        "label_variant",
        "prior_variant",
        "qualifier",
        "emphasis",
        "trace",
        "nutrition",
      ]),
      certainty: Certainty,
      kind: Kind,
      grade: Grade,
      probability: z.number().optional(),
      population: z.array(z.string()).optional(),
      note: z.string(),
      sources: z.array(SourceRef),
    })),
  })),
  ranking: z.array(z.object({
    path: z.string(),
    name: z.string(),
    ingredient_id: z.string().nullable(),
    score: z.number(),
    level: Severity,
    personal: z.boolean(),
    reasons: z.array(z.object({
      code: z.string(),
      label: z.string(),
      concern: Concern,
      severity: Severity,
      certainty: Certainty,
      grade: Grade.optional(),
      personal: z.boolean(),
    })),
  })).openapi({
    description:
      "Label items ordered by danger. Hazards rank; sensitivities and preferences only when the profile asks.",
  }),
  diets: z.object({
    vegan: DietVerdict,
    vegetarian: DietVerdict,
    gluten_free: DietVerdict,
    lactose_free: DietVerdict,
  }),
  may_contain: z.array(
    z.object({ text: z.string(), ingredient_id: z.string().nullable(), allergens: z.array(z.string()) }),
  ),
  label_statements: z.array(z.string()),
  coverage: z.object({
    ingredients: z.number().int(),
    matched: z.number().int(),
    low_confidence: z.number().int(),
    ratio: z.number(),
  }),
  summary: z.object({
    warning: z.number().int(),
    caution: z.number().int(),
    notice: z.number().int(),
    info: z.number().int(),
    highest: Severity.nullable(),
    danger: Severity.nullable().openapi({
      description:
        "Highest severity among hazards and the profile's own concerns (allergens alone do not raise it).",
    }),
  }),
  profile: z.object({
    hits: z.array(
      z.object({ code: z.string(), certainty: Certainty, paths: z.array(z.string()), trace: z.boolean() }),
    ),
    diets: z.array(z.object({ diet: z.string(), status: Certainty })),
  }).optional(),
  nutrition: z.object({
    basis: z.enum(["100g", "100ml"]),
    sugars: z.object({
      per_100: z.number(),
      per_serving: z.number().nullable(),
      band: z.enum(["low", "medium", "high"]),
      band_by: z.enum(["per_100", "per_portion"]),
      ri_percent_per_100: z.number().int(),
      ri_percent_per_serving: z.number().int().nullable(),
      criteria: z.literal("uk-fop-2016"),
      kind: z.literal("fact"),
      sources: z.array(SourceRef),
    }),
  }).nullable().openapi({ description: "Amounts from the declared nutrition; null when none was sent." }),
  unanalysed_text: z.string().nullable(),
  sources: z.record(z.string(), SourceSummary),
  disclaimer: z.string(),
  ai_generated_content: z.boolean().openapi({
    description: "True when any matched entry is AI-drafted and not yet human-reviewed (EU AI Act art. 50).",
  }),
}).openapi("Analysis");

// ---------------------------------------------------------------- taxonomy, sources, meta
export const ImplicationsResponse = z.object({
  items: z.array(z.object({
    code: z.string(),
    group: z.string(),
    severity: Severity,
    concern: Concern,
    kind: Kind,
    label: z.string(),
    definition: z.string(),
    evidence_required: z.string(),
  })),
  kb_version: z.string(),
}).openapi("Implications");

export const SourceResponse = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  publisher: z.string().optional(),
  authors: z.string().optional(),
  year: z.number().int().optional(),
  url: z.string(),
  doi: z.string().optional(),
  pmid: z.string().optional(),
  licence: z.string(),
  accessed: z.string(),
  note: z.string().optional(),
}).openapi("Source");

export const MetaResponse = z.object({
  service: z.string(),
  version: z.string(),
  kb_version: z.string(),
  methodology_version: z.string(),
  counts: z.object({
    ingredients: z.number().int(),
    curated: z.number().int(),
    generated: z.number().int(),
    implications: z.number().int(),
    sources: z.number().int(),
    classes: z.number().int(),
  }),
  licences: z.object({ code: z.string(), knowledge_base: z.string(), generated_identity: z.string() }),
  attribution: z.array(z.string()),
  keyless: z.object({
    scopes: z.array(z.string()),
    per_minute: z.record(z.string(), z.number().int()),
  }).optional().openapi({
    description:
      "Present when this deployment answers without an API key: the scopes it opens and the requests a minute per IP address, by bucket.",
  }),
  docs: z.string(),
  openapi: z.string(),
}).openapi("Meta");
