import { fromFileUrl } from "@std/path";
// Test fixtures. The fixture KB uses the REAL taxonomy, classes and sources (so codes cannot drift)
// with a small, frozen set of ingredients, so analyser/API tests don't move when curators edit kb/.
import { parse as parseYaml } from "@std/yaml";
import { KbIndex } from "../src/core/kb-index.ts";
import {
  ClassesFile,
  ImplicationsFile,
  Ingredient,
  type IngredientT,
  type KbBundle,
  SourcesFile,
} from "../src/kb/schema.ts";
import { loadConfig } from "../src/config.ts";
import { memoryLogger } from "../src/http/log.ts";
import { createRuntime, type Runtime } from "../src/runtime.ts";
import { createKey, type Scope } from "../src/auth/keys.ts";

export const KB_DIR = fromFileUrl(new URL("../kb", import.meta.url));

const src = (id: string) => [{ id }];
const note = (en: string) => ({ en });
type A = NonNullable<IngredientT["assertions"]>[number];
const fact = (code: string, source = "reg-1169-2011", extra: Partial<A> = {}): A => ({
  code,
  certainty: "yes",
  kind: "fact",
  grade: "A",
  note: note(`${code} (fixture)`),
  sources: src(source),
  ...extra,
});

const addedSugar = fact("health.added_sugar", "who-free-sugars-2015", { population: ["general"] });

export const FIXTURE_INGREDIENTS: IngredientT[] = [
  {
    id: "whey-protein-concentrate",
    type: "protein",
    names: {
      en: ["whey protein concentrate"],
      pl: ["koncentrat białka serwatkowego"],
      de: ["Molkenproteinkonzentrat"],
    },
    assertions: [
      fact("allergen.milk"),
      fact("origin.dairy"),
      {
        code: "diet.lactose_free",
        certainty: "no",
        kind: "estimate",
        grade: "B",
        note: note("contains lactose"),
        sources: src("usda-fdc"),
      },
    ],
    review_status: "draft",
    provenance: "human",
  },
  {
    id: "milk",
    type: "ingredient",
    names: { en: ["milk", "milk powder"], pl: ["mleko", "mleka", "mleko w proszku"], de: ["Milch"] },
    assertions: [fact("allergen.milk"), fact("origin.dairy")],
    review_status: "draft",
    provenance: "human",
  },
  {
    id: "soybeans",
    type: "ingredient",
    names: { en: ["soybeans", "soy", "soya"], pl: ["soja", "soi", "soję"], de: ["Soja"] },
    assertions: [fact("allergen.soybeans"), fact("origin.plant")],
    review_status: "draft",
    provenance: "human",
  },
  {
    id: "hazelnuts",
    type: "ingredient",
    names: { en: ["hazelnuts"], pl: ["orzechy laskowe", "orzechów laskowych"], de: ["Haselnüsse"] },
    assertions: [fact("allergen.nuts"), fact("origin.plant")],
    review_status: "draft",
    provenance: "human",
  },
  {
    id: "wheat",
    type: "ingredient",
    names: {
      en: ["wheat", "wheat flour"],
      pl: ["pszenica", "mąka pszenna", "mąki pszennej"],
      de: ["Weizen", "Weizenmehl"],
    },
    assertions: [fact("allergen.gluten"), fact("origin.plant")],
    review_status: "draft",
    provenance: "human",
  },
  {
    id: "sugar",
    type: "carbohydrate",
    names: { en: ["sugar"], pl: ["cukier"], de: ["Zucker"] },
    assertions: [fact("origin.plant", "reg-1169-2011"), addedSugar],
    glycemic: [{ range: [61, 69], fraction: "sugars", method: "iso", source: "gi-dodd-2011" }],
    review_status: "draft",
    provenance: "human",
  },
  {
    id: "lecithins",
    type: "additive",
    e_number: "E322",
    functions: ["emulsifier"],
    names: { en: ["lecithins", "lecithin"], pl: ["lecytyny", "lecytyna"], de: ["Lecithine", "Lecithin"] },
    variants: [
      {
        id: "soy",
        names: { en: ["soy lecithin"], pl: ["lecytyna sojowa"], de: ["Sojalecithin"] },
        process: note("from soybean oil degumming"),
        tells: ["\\bsoi\\b", "\\bsoj", "\\bsoy"],
        prior: 0.7,
        prior_rationale: note("soy is the commodity source"),
      },
      {
        id: "sunflower",
        names: { en: ["sunflower lecithin"], pl: ["lecytyna słonecznikowa"], de: ["Sonnenblumenlecithin"] },
        process: note("from sunflower oil"),
        tells: ["slonecznik", "sunflower", "sonnenblum"],
        prior: 0.3,
        prior_rationale: note("premium, usually advertised"),
      },
    ],
    assertions: [
      fact("allergen.soybeans", "reg-1169-2011", { variant: "soy" }),
      {
        code: "origin.gmo_derived",
        variant: "soy",
        certainty: "maybe",
        kind: "estimate",
        grade: "C",
        note: note("GM soy common"),
        sources: src("reg-1333-2008"),
      },
      fact("origin.plant", "reg-231-2012"),
    ],
    review_status: "draft",
    provenance: "ai-drafted",
  },
  {
    id: "malic-acid",
    type: "additive",
    e_number: "E296",
    functions: ["acid", "acidity-regulator"],
    names: { en: ["malic acid"], pl: ["kwas jabłkowy"], de: ["Äpfelsäure"] },
    variants: [
      {
        id: "dl",
        names: { en: ["DL-malic acid"], pl: ["kwas DL-jabłkowy"] },
        process: note("synthesis from maleic anhydride"),
        tells: ["\\bdl (?:malic|jablkow|apfel)", "\\bkwas dl jablkow"],
        prior: 0.8,
        prior_rationale: note("commodity route"),
      },
      {
        id: "l",
        names: { en: ["L-malic acid"], pl: ["kwas L-jabłkowy"] },
        process: note("fermentation or enzymatic"),
        tells: ["(?<!d)\\bl (?:malic|jablkow|apfel)", "\\bkwas l jablkow"],
        prior: 0.2,
        prior_rationale: note("advertised when used"),
      },
    ],
    assertions: [
      fact("origin.petrochemical_synthetic", "efsa-malic-call-2024", { variant: "dl" }),
      {
        code: "origin.microbial_fermentation",
        variant: "l",
        certainty: "maybe",
        kind: "estimate",
        grade: "B",
        note: note("maybe fermentation"),
        sources: src("efsa-malic-call-2024"),
      },
      fact("diet.vegan", "efsa-malic-call-2024"),
    ],
    review_status: "draft",
    provenance: "ai-drafted",
  },
  {
    id: "mono-and-diglycerides",
    type: "additive",
    e_number: "E471",
    functions: ["emulsifier"],
    names: {
      en: ["mono- and diglycerides of fatty acids"],
      pl: ["mono- i diglicerydy kwasów tłuszczowych"],
      de: ["Mono- und Diglyceride von Speisefettsäuren"],
    },
    variants: [
      { id: "plant", process: note("from vegetable oils"), tells: ["roslinn", "vegetable", "pflanzlich"] },
      { id: "animal", process: note("from animal fat"), tells: ["zwierzec", "animal", "tierisch"] },
    ],
    assertions: [
      {
        code: "diet.vegan",
        certainty: "maybe",
        kind: "estimate",
        grade: "C",
        note: note("source undisclosed"),
        sources: src("reg-231-2012"),
      },
      {
        code: "diet.vegan",
        variant: "plant",
        certainty: "yes",
        kind: "fact",
        grade: "A",
        note: note("plant"),
        sources: src("reg-231-2012"),
      },
      fact("origin.vegetable_oil_derived", "reg-231-2012", { variant: "plant" }),
      fact("origin.animal", "reg-231-2012", { variant: "animal" }),
    ],
    review_status: "draft",
    provenance: "ai-drafted",
  },
  {
    id: "sucralose",
    type: "sweetener",
    e_number: "E955",
    functions: ["sweetener"],
    names: { en: ["sucralose"], pl: ["sukraloza"], de: ["Sucralose"] },
    assertions: [fact("origin.chemical_synthesis", "reg-231-2012"), fact("diet.vegan", "reg-231-2012")],
    review_status: "draft",
    provenance: "ai-drafted",
  },
  {
    // As imported from Wikidata, including its Polish label (which actually names the maleate): the
    // fuzzy-guard regression — "kazeinian sodu" once matched this entry.
    id: "e350",
    type: "additive",
    e_number: "E350",
    names: { en: ["sodium malates"], pl: ["maleinian sodu", "maleiniany sodu"] },
    review_status: "imported",
    provenance: "wikidata",
  },
  {
    id: "glucose-syrup",
    type: "ingredient",
    names: { en: ["glucose syrup"], pl: ["syrop glukozowy"], de: ["Glukosesirup"] },
    glycemic: [
      { range: [90, 100], fraction: "sugars", method: "non_iso", source: "gi-dodd-2011" },
      { range: [90, 100], fraction: "starch", method: "non_iso", source: "gi-dodd-2011" },
    ],
    variants: [
      {
        id: "wheat",
        process: note("wheat starch"),
        tells: ["pszen", "wheat", "weizen"],
        prior: 0.15,
        prior_rationale: note("minority"),
      },
      {
        id: "maize",
        process: note("maize starch"),
        tells: ["kukurydz", "maize", "corn", "mais"],
        prior: 0.6,
        prior_rationale: note("majority"),
      },
      {
        id: "potato",
        process: note("potato starch"),
        tells: ["ziemniacz", "potato", "kartoffel"],
        prior: 0.25,
        prior_rationale: note("some"),
      },
    ],
    assertions: [
      addedSugar,
      {
        code: "allergen.gluten",
        variant: "wheat",
        certainty: "maybe",
        kind: "fact",
        grade: "A",
        note: note("exempt"),
        sources: src("reg-1169-2011"),
      },
      {
        code: "diet.gluten_free",
        variant: "wheat",
        certainty: "maybe",
        kind: "estimate",
        grade: "C",
        note: note("exempt"),
        sources: src("reg-1169-2011"),
      },
      fact("origin.plant"),
    ],
    review_status: "draft",
    provenance: "human",
  },
  {
    // Test priors: the top candidate is below the 0.5 flag threshold (the real entry differs).
    id: "vegetable-fat-powder",
    type: "ingredient",
    names: { en: ["vegetable fat powder"], pl: ["tłuszcz roślinny w proszku"] },
    variants: [
      { id: "palm", process: note("palm"), tells: ["palm"], prior: 0.45, prior_rationale: note("test") },
      {
        id: "coconut",
        process: note("coconut"),
        tells: ["kokos", "coconut"],
        prior: 0.35,
        prior_rationale: note("test"),
      },
    ],
    assertions: [
      fact("ethics.palm_oil", "reg-1169-2011", { variant: "palm" }),
      fact("origin.vegetable_oil_derived"),
    ],
    review_status: "draft",
    provenance: "human",
  },
  {
    id: "palm-oil",
    type: "fat",
    names: {
      en: ["palm oil", "palm fat"],
      pl: ["olej palmowy", "tłuszcz palmowy"],
      de: ["Palmöl", "Palmfett"],
    },
    assertions: [
      fact("ethics.palm_oil", "reg-1169-2011"),
      fact("origin.vegetable_oil_derived", "reg-1169-2011"),
      fact("origin.plant", "reg-1169-2011"),
    ],
    review_status: "draft",
    provenance: "human",
  },
  {
    id: "carmine",
    type: "additive",
    e_number: "E120",
    functions: ["colour"],
    names: { en: ["carmine", "cochineal"], pl: ["karmin", "koszenila"], de: ["Karmin", "Echtes Karmin"] },
    assertions: [
      fact("origin.insect", "reg-231-2012"),
      {
        code: "diet.vegan",
        certainty: "no",
        kind: "fact",
        grade: "A",
        note: note("insect"),
        sources: src("reg-231-2012"),
      },
      {
        code: "diet.vegetarian",
        certainty: "no",
        kind: "fact",
        grade: "A",
        note: note("insect"),
        sources: src("reg-231-2012"),
      },
    ],
    review_status: "draft",
    provenance: "ai-drafted",
  },
  {
    id: "sunset-yellow",
    type: "additive",
    e_number: "E110",
    functions: ["colour"],
    names: { en: ["sunset yellow FCF"], pl: ["żółcień pomarańczowa FCF"], de: ["Gelborange S"] },
    assertions: [fact("health.southampton_colour", "reg-1333-2008", { population: ["children"] })],
    review_status: "draft",
    provenance: "ai-drafted",
  },
  {
    id: "aspartame",
    type: "sweetener",
    e_number: "E951",
    functions: ["sweetener"],
    names: { en: ["aspartame"], pl: ["aspartam"], de: ["Aspartam"] },
    assertions: [fact("health.phenylalanine_source", "reg-1169-2011", { population: ["pku"] })],
    review_status: "draft",
    provenance: "ai-drafted",
  },
];

async function readYaml<T>(file: string, schema: { parse(v: unknown): T }): Promise<T> {
  return schema.parse(parseYaml(await Deno.readTextFile(`${KB_DIR}/${file}`)));
}

/** kb/sources.yaml plus kb/sources/*.yaml, as the real loader merges them. */
async function allSources() {
  const all = (await readYaml("sources.yaml", SourcesFile)).sources;
  for await (const e of Deno.readDir(`${KB_DIR}/sources`)) {
    if (e.isFile && e.name.endsWith(".yaml")) {
      all.push(...(await readYaml(`sources/${e.name}`, SourcesFile)).sources);
    }
  }
  return all;
}

let fixture: KbIndex | null = null;
export async function fixtureIndex(): Promise<KbIndex> {
  if (fixture) return fixture;
  const bundle: KbBundle = {
    sources: await allSources(),
    implications: (await readYaml("implications.yaml", ImplicationsFile)).implications,
    classes: (await readYaml("classes.yaml", ClassesFile)).classes,
    ingredients: FIXTURE_INGREDIENTS.map((i) => Ingredient.parse(i)),
    version: "kb-fixture",
    counts: { curated: FIXTURE_INGREDIENTS.length, generated: 0, superseded: 0 },
  };
  fixture = new KbIndex(bundle);
  return fixture;
}

export interface TestApi {
  rt: Runtime;
  token: string;
  log: ReturnType<typeof memoryLogger>;
  req(path: string, init?: RequestInit & { auth?: string | false }): Promise<Response>;
  close(): Promise<void>;
}

/** The whole API in-process on PGlite (or TEST_DATABASE_URL when set, e.g. postgres:17 in CI). */
export async function startApi(
  opts: { scopes?: Scope[]; rate?: number; quota?: number; env?: Record<string, string> } = {},
): Promise<TestApi> {
  const log = memoryLogger();
  const url = Deno.env.get("TEST_DATABASE_URL") ?? "pglite:memory";
  const cfg = loadConfig({ DATABASE_URL: url, KB_DIR, ...opts.env });
  const rt = await createRuntime(cfg, log, { index: await fixtureIndex() });
  if (url !== "pglite:memory") await rt.db.exec("truncate api_usage, api_key restart identity cascade");
  const { token } = await createKey(rt.db, {
    label: "test",
    scopes: opts.scopes ?? ["kb:read", "analyze"],
    ratePerMin: opts.rate ?? 1000,
    dailyQuota: opts.quota ?? 100000,
  });
  return {
    rt,
    token,
    log,
    req(path, init = {}) {
      const headers = new Headers(init.headers);
      if (init.auth !== false) headers.set("authorization", `Bearer ${init.auth ?? token}`);
      return Promise.resolve(rt.app.request(path, { ...init, headers }));
    },
    close: () => rt.close(),
  };
}
