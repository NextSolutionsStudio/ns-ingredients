// Label analysis: parse → match → variants → implications → diets → profile.
// Deterministic and side-effect free; the HTTP layer only validates and serialises.
import type { AssertionT, IngredientT, Lang, TextT } from "../kb/schema.ts";
import type { DeniedName, KbIndex, MatchType, NameMatch } from "./kb-index.ts";
import { PRIOR_FLAG_MIN } from "./kb-index.ts";
import { baseENumber, findENumbers, guessLang, normName } from "./normalize.ts";
import {
  assessNutrition,
  type GiCarrier,
  highGlNote,
  highSugarNote,
  type NutritionInput,
  type NutritionResult,
} from "./nutrition.ts";
import { type NameOracle, type ParsedItem, parseLabel, type Percent, splitTopLevel } from "./parse.ts";

export type Certainty = "yes" | "no" | "maybe" | "unknown";
export type DietId = "vegan" | "vegetarian" | "gluten_free" | "lactose_free";
export const DIETS: DietId[] = ["vegan", "vegetarian", "gluten_free", "lactose_free"];

export interface Profile {
  /** Implication codes or group prefixes ("allergen.milk", "origin.petrochemical_synthetic", "allergen.*"). */
  avoid?: string[];
  diets?: DietId[];
}

export interface AnalyzeOptions {
  lang?: Lang;
  profile?: Profile;
  /** Declared nutrition: the only source of amounts. */
  nutrition?: NutritionInput;
}

export interface ItemResult {
  path: string;
  text: string;
  name: string;
  role: "ingredient" | "qualifier" | "e_number" | "class";
  percent?: Percent;
  emphasized: string[];
  function?: { id: string; name: string };
  match: null | {
    ingredient_id: string;
    name: string;
    e_number?: string;
    match_type: MatchType;
    confidence: number;
    review_status: string;
  };
  variant: null | {
    basis: "label" | "prior";
    id?: string;
    name?: string;
    candidates?: { id: string; probability: number }[];
  };
  children: ItemResult[];
}

export interface FlagTrigger {
  /** A label item, or "nutrition.<field>" for a trigger computed from declared nutrition. */
  path: string;
  /** Absent on basis "nutrition", and on an emphasised item the KB does not recognise. */
  ingredient_id?: string;
  variant_id?: string;
  basis: "ingredient" | "label_variant" | "prior_variant" | "qualifier" | "emphasis" | "trace" | "nutrition";
  certainty: Certainty;
  kind: "fact" | "estimate" | "opinion";
  grade: "A" | "B" | "C" | "D";
  probability?: number;
  population?: string[];
  note: string;
  sources: { id: string; locator?: string }[];
}

export type Concern = "hazard" | "sensitivity" | "quality" | "preference" | "info";
type Severity = "info" | "notice" | "caution" | "warning";

export interface Flag {
  code: string;
  group: string;
  severity: Severity;
  /** Who it matters to. Severity says how serious; a warning-level allergen is no hazard to the non-allergic. */
  concern: Concern;
  /** Present when a profile was sent: the profile asked about this code. */
  personal?: boolean;
  label: string;
  certainty: Certainty;
  kind: "fact" | "estimate" | "opinion";
  grade: "A" | "B" | "C" | "D";
  triggers: FlagTrigger[];
}

export interface DietVerdict {
  status: Certainty;
  because: { path: string; ingredient_id?: string; status: Certainty }[];
}

/** One line of the danger ranking: a label item and why it ranks where it does. */
export interface RankedItem {
  path: string;
  /** The words on the label. */
  name: string;
  ingredient_id: string | null;
  score: number;
  /** Severity of the reason that ranks it. */
  level: Severity;
  personal: boolean;
  reasons: {
    code: string;
    label: string;
    concern: Concern;
    severity: Severity;
    /** For a diet.* reason: the diet's status for this item (no / maybe). */
    certainty: Certainty;
    /** Evidence grade of the claim; absent for diet reasons, which are derived. */
    grade?: "A" | "B" | "C" | "D";
    personal: boolean;
  }[];
}

export interface AnalysisResult {
  kb_version: string;
  lang: Lang;
  items: ItemResult[];
  flags: Flag[];
  /** Label items ordered by danger: hazards first, then quality markers; sensitivities and preferences
   * count only when the profile asks about them. Items with nothing to rank are left out. */
  ranking: RankedItem[];
  diets: Record<DietId, DietVerdict>;
  may_contain: { text: string; ingredient_id: string | null; allergens: string[] }[];
  label_statements: string[];
  coverage: { ingredients: number; matched: number; low_confidence: number; ratio: number };
  summary: {
    warning: number;
    caution: number;
    notice: number;
    info: number;
    /** Highest severity of any flag, including ones that only matter to some people (allergens). */
    highest: Severity | null;
    /** Highest severity among hazards and the profile's own concerns: the headline for "is this dangerous". */
    danger: Severity | null;
  };
  profile?: {
    hits: { code: string; certainty: Certainty; paths: string[]; trace: boolean }[];
    diets: { diet: DietId; status: Certainty }[];
  };
  /** Amounts from the declared nutrition; null when none was sent. */
  nutrition: NutritionResult | null;
  unanalysed_text: string | null;
  sources: Record<string, { title: string; url: string; year?: number; publisher?: string }>;
  disclaimer: string;
  ai_generated_content: boolean;
}

const SEVERITY_RANK = { info: 0, notice: 1, caution: 2, warning: 3 } as const;
const CERTAINTY_RANK: Record<Certainty, number> = { no: 0, unknown: 1, maybe: 2, yes: 3 };
const KIND_RANK = { opinion: 0, estimate: 1, fact: 2 } as const;
const GRADE_RANK = { D: 0, C: 1, B: 2, A: 3 } as const;

const DISCLAIMER: Record<Lang, string> = {
  en:
    "Informational only, not medical advice. Based on the ingredient text supplied and the cited sources; " +
    "an ingredient list cannot show amounts, cross-contamination or the manufacturer's actual supplier. " +
    "Check the physical label and consult a professional for medical conditions.",
  pl:
    "Wyłącznie informacyjnie, nie jest to porada medyczna. Na podstawie podanego składu i cytowanych źródeł; " +
    "lista składników nie pokazuje ilości, zanieczyszczeń krzyżowych ani faktycznego dostawcy producenta. " +
    "Sprawdź etykietę produktu, a w razie chorób skonsultuj się ze specjalistą.",
  de:
    "Nur zur Information, keine medizinische Beratung. Grundlage sind der angegebene Zutatentext und die zitierten " +
    "Quellen; eine Zutatenliste zeigt weder Mengen noch Kreuzkontamination noch den tatsächlichen Lieferanten. " +
    "Prüfen Sie das Etikett und fragen Sie bei Erkrankungen Fachleute.",
};

const txt = (t: TextT | undefined, lang: Lang): string => (t ? t[lang] ?? t.en : "");

// E1400–E1452: modified starches, which can be wheat-derived; identity-only entries can't say.
const isModifiedStarch = (e?: string) => !!e && /^E14[0-5]\d/.test(e);

/**
 * An item's own match: the matcher, else an E-number the name prints ("barwnik E150d"). `excluded` receives the
 * foods whose variant name the item denies (`KbIndex.match`).
 */
function matchName(index: KbIndex, name: string, excluded?: DeniedName[]): NameMatch | null {
  const m = name ? index.match(name, excluded) : null;
  if (m && m.confidence >= 0.9) return m;
  const es = findENumbers(name);
  const byE = es.length ? index.byENumber(es[0].code) : undefined;
  return byE
    ? { ingredientId: byE.id, matchType: "e_number", confidence: 1, matched: baseENumber(es[0].code) }
    : m;
}

/**
 * A match the score counts: exact, variant, E-number, or a sub-phrase ≥ 0.8; never fuzzy. The same rule as
 * airon skład's `isConfident` (src/score.ts), which can import this one.
 */
export function isConfident(m: { match_type: MatchType; confidence: number } | null): boolean {
  if (!m) return false;
  if (m.match_type === "exact" || m.match_type === "variant" || m.match_type === "e_number") return true;
  return m.match_type === "sub_phrase" && m.confidence >= 0.8;
}

/**
 * What the parser may ask when a dash or a full stop could be a separator: a class, or a confident match.
 * Anything that re-parses a label to line up with an analysis (item paths) must pass the same oracle.
 */
export const nameOracle = (index: KbIndex): NameOracle => ({
  classOf: (t) => index.classOf(t),
  confident: (name) => {
    const m = matchName(index, name);
    return m && isConfident({ match_type: m.matchType, confidence: m.confidence })
      ? m.ingredientId
      : undefined;
  },
  isName: (words) => index.isName(words),
  beginsName: (words) => index.beginsName(words),
  tells: () => index.allTells(),
});

export function analyze(index: KbIndex, text: string, opts: AnalyzeOptions = {}): AnalysisResult {
  const parsed = parseLabel(text, { lang: opts.lang, kb: nameOracle(index) });
  const lang: Lang = opts.lang ?? parsed.lang ?? guessLang(text);
  const flags = new Map<string, Flag>();
  const citedSources = new Set<string>();
  /** Label paths that raised a real allergen: emphasis there is accounted for. */
  const allergenPaths = new Set<string>();

  const addFlag = (
    a: AssertionT,
    trigger: Omit<FlagTrigger, "note" | "sources" | "population"> & { note?: string },
  ) => {
    const impl = index.implications.get(a.code);
    if (!impl || impl.group === "diet") return;
    if (trigger.certainty !== "yes" && trigger.certainty !== "maybe") return;
    for (const s of a.sources) citedSources.add(s.id);
    if (impl.group === "allergen" && a.code !== UNRECOGNISED_EMPHASIS) allergenPaths.add(trigger.path);
    const full: FlagTrigger = {
      ...trigger,
      ...(a.population ? { population: a.population } : {}),
      note: trigger.note ?? txt(a.note, lang),
      sources: a.sources,
    };
    const existing = flags.get(a.code);
    if (!existing) {
      flags.set(a.code, {
        code: a.code,
        group: impl.group,
        severity: impl.severity,
        concern: impl.concern,
        label: txt(impl.label, lang),
        certainty: full.certainty,
        kind: full.kind,
        grade: full.grade,
        triggers: [full],
      });
      return;
    }
    if (existing.triggers.some((t) => t.path === full.path && t.ingredient_id === full.ingredient_id)) return;
    existing.triggers.push(full);
    if (CERTAINTY_RANK[full.certainty] > CERTAINTY_RANK[existing.certainty]) {
      existing.certainty = full.certainty;
    }
    if (KIND_RANK[full.kind] > KIND_RANK[existing.kind]) existing.kind = full.kind;
    if (GRADE_RANK[full.grade] > GRADE_RANK[existing.grade]) existing.grade = full.grade;
  };

  /**
   * The allergens a food's own reading asserts (its unscoped ones, and its most likely prior variant's when that is
   * more likely than not), for a variant name of it that the item denies.
   */
  const ownAllergens = (ing: IngredientT) => {
    const top = (ing.variants ?? []).filter((v) => v.prior !== undefined)
      .sort((x, y) => y.prior! - x.prior!)[0];
    const topId = top && top.prior! >= PRIOR_FLAG_MIN ? top.id : undefined;
    return (ing.assertions ?? []).filter((a) =>
      a.code.startsWith("allergen.") && (a.certainty === "yes" || a.certainty === "maybe") &&
      (!a.variant || a.variant === topId)
    );
  };

  /**
   * The allergens a denied name is exempt from: those the variant its name selects asserts "no" for ("fully refined
   * hydrogenated soybean oil": Annex II 6(a)). A name that states no exemption keeps the food's own allergens.
   */
  const exemptFrom = (ing: IngredientT, variantId?: string) =>
    new Set(
      (ing.assertions ?? []).filter((a) =>
        variantId && a.variant === variantId && a.code.startsWith("allergen.") && a.certainty === "no"
      ).map((a) => a.code),
    );

  /**
   * A qualifier's allergens: those its food asserts ("z soi"); then those of the variant its name selects, the
   * variant's "no" an exemption ("(from fully refined hydrogenated soybean oil)": no soy, Sol 6.1 on #18 at c16374b);
   * else those of its most likely prior variant at "maybe", as the food named as an item shows them ("(bez GMO olej
   * sojowy)": soy maybe, as "olej sojowy").
   */
  const qualifierAllergens = (ing: IngredientT, variantId?: string) => {
    const out: AssertionT[] = allergenAssertions(ing);
    if (variantId) {
      const scoped = (ing.assertions ?? []).filter((a) =>
        a.variant === variantId && a.code.startsWith("allergen.")
      );
      const exempt = new Set(scoped.filter((a) => a.certainty === "no").map((a) => a.code));
      return [
        ...out.filter((a) => !exempt.has(a.code)),
        ...scoped.filter((a) =>
          (a.certainty === "yes" || a.certainty === "maybe") && !out.some((b) => b.code === a.code)
        ),
      ];
    }
    for (const a of ownAllergens(ing)) {
      if (a.variant && !out.some((b) => b.code === a.code)) {
        out.push({ ...a, certainty: "maybe", kind: a.kind === "fact" ? "estimate" : a.kind });
      }
    }
    return out;
  };

  /** Allergen assertions of an ingredient named inside a qualifier, emphasis or trace. */
  const allergenAssertions = (ing: IngredientT) =>
    (ing.assertions ?? []).filter((a) =>
      a.code.startsWith("allergen.") && !a.variant && a.certainty === "yes"
    );

  const dietInputs: DietInput[] = [];
  /** Entries a denied variant name contributes allergens from: no diet input, but their provenance counts. */
  const deniedFoods = new Set<string>();
  /** Per qualifier path, the variant its name selects ("(from fully refined hydrogenated soybean oil)"). */
  const qualifierVariants = new Map<string, string>();
  /** Per item path, the words of it and of its brackets that denied names cover: emphasis there reasserts nothing. */
  const deniedTexts = new Map<string, DeniedText[]>();

  const resolveItem = (item: ParsedItem, parentFn?: string, parentNorm?: string): ItemResult => {
    const base: ItemResult = {
      path: item.path,
      text: item.raw,
      name: item.name,
      role: item.role,
      ...(item.percent ? { percent: item.percent } : {}),
      emphasized: item.emphasized,
      match: null,
      variant: null,
      children: [],
    };

    // Qualifiers ("z soi") and bare E-number annotations are resolved for their parent.
    if (item.role === "qualifier") {
      const m = index.match(item.name.replace(/^(?:z|ze|from|of|aus|von)\s+/iu, ""));
      if (m) base.match = toMatch(index, m.ingredientId, m.matchType, m.confidence);
      if (m?.variantId) qualifierVariants.set(item.path, m.variantId);
      return base;
    }
    if (item.role === "e_number") {
      const e = findENumbers(item.name)[0];
      const ing = e ? index.byENumber(e.code) : undefined;
      if (ing) base.match = toMatch(index, ing.id, "e_number", 1);
      return base;
    }

    // Function class: from this item's header, or an inherited header that fits the match.
    const headerClass = item.header ? index.classOf(item.header) : undefined;
    let fn = headerClass ?? parentFn;

    const excluded: DeniedName[] = [];
    let m = matchName(index, item.name, excluded);
    // A compound item ("Vitamins (…)", "polewa kakaowa (…)") is described by its parts; a fuzzy guess at
    // the header name is how "Vitamins" became vitamin C.
    if (m?.matchType === "fuzzy" && item.children.some((c) => c.role === "ingredient")) m = null;
    // A part that only makes sense with its parent's noun: "Vegetable Oil (Palm, Rapeseed)", "Vitamins (B12)".
    if ((!m || m.matchType === "fuzzy") && parentNorm && item.role === "ingredient") {
      const own = normName(item.name);
      for (const ctx of CONTEXT_FORMS) {
        if (!ctx.parent.test(parentNorm)) continue;
        const hit = ctx.forms.map((f) => index.match(f(own))).find((x) =>
          x && (x.matchType === "exact" || x.matchType === "variant")
        );
        if (hit) {
          m = { ...hit, matchType: "sub_phrase", confidence: 0.9 };
          break;
        }
      }
    }
    // The item itself is only a class name ("emulgator", "barwnik (E120)").
    const classOnly = index.classOf(item.name);
    if ((!m || m.matchType === "fuzzy") && classOnly) {
      base.role = "class";
      fn = classOnly;
      m = null;
    }

    const children = item.children.map((c) =>
      resolveItem(
        c,
        base.role === "class" ? fn : undefined,
        base.role === "class" ? undefined : normName(item.name),
      )
    );
    base.children = children;
    // "barwnik (E120)" / "przeciwutleniacz (ekstrakt bogaty w tokoferole)": the child names the additive.
    if (base.role === "class" && children.length === 1 && children[0].match) {
      base.match = children[0].match;
      children[0].role = children[0].role === "e_number" ? "e_number" : children[0].role;
    }

    if (m) base.match = toMatch(index, m.ingredientId, m.matchType, m.confidence);
    if (!base.match && children.some((c) => c.role === "e_number" && c.match)) {
      base.match = children.find((c) => c.role === "e_number" && c.match)!.match;
    }

    const ing = base.match ? index.get(base.match.ingredient_id) : undefined;
    // "lecytyny (słonecznik)": an unknown part that fires one of the parent's tells names its source, not an
    // extra ingredient — it must not turn every diet "unknown".
    if (ing) {
      for (const c of children) {
        if (
          c.role !== "ingredient" || c.match || c.children.length || !index.tellsFor(ing.id, c.name).length
        ) continue;
        c.role = "qualifier";
        const at = dietInputs.findIndex((d) => d.path === c.path && !d.ingredient);
        if (at >= 0) dietInputs.splice(at, 1);
      }
    }
    if (!headerClass && item.inheritedHeader && ing) {
      const inherited = index.classOf(item.inheritedHeader);
      if (inherited && ing.functions?.includes(inherited)) fn = inherited;
    }
    if (fn) {
      const cls = index.classes.get(fn)!;
      base.function = { id: fn, name: cls.names[lang]?.[0] ?? cls.names.en[0] };
    }

    if (ing) {
      // Variant: label tells over the item and everything printed inside its brackets.
      // Several tells firing means a blend the label spells out ("olej palmowy, olej kokosowy"): every named
      // variant is present, so each one's facts apply.
      const labelIds = m?.variantId ? [m.variantId] : index.tellsFor(ing.id, item.raw).map((v) => v.id);
      if (labelIds.length === 1) {
        const v = ing.variants?.find((x) => x.id === labelIds[0]);
        base.variant = { basis: "label", id: labelIds[0], name: v?.names?.[lang]?.[0] ?? v?.names?.en[0] };
      } else if (labelIds.length > 1) {
        base.variant = { basis: "label", candidates: labelIds.map((id) => ({ id, probability: 1 })) };
      } else if (ing.variants?.some((v) => v.prior !== undefined)) {
        const candidates = ing.variants.filter((v) => v.prior !== undefined)
          .map((v) => ({ id: v.id, probability: v.prior! }))
          .sort((a, b) => b.probability - a.probability);
        base.variant = { basis: "prior", candidates };
      }

      const labelVariants = base.variant?.basis === "label" ? labelIds : [];
      const top = base.variant?.basis === "prior" ? base.variant.candidates?.[0] : undefined;
      const priorTop = top && top.probability >= PRIOR_FLAG_MIN ? top.id : undefined;
      for (const a of ing.assertions ?? []) {
        if (!a.variant) {
          addFlag(a, trig(item.path, ing.id, "ingredient", a));
        } else if (labelVariants.length) {
          if (labelVariants.includes(a.variant)) {
            addFlag(a, trig(item.path, ing.id, "label_variant", a, a.variant));
          }
        } else if (base.variant?.basis === "prior") {
          // Only the most likely variant raises flags, and only when it is more likely than not;
          // the full distribution stays visible on the item.
          if (!priorTop || priorTop !== a.variant) continue;
          const p = top!.probability;
          const v = ing.variants?.find((x) => x.id === a.variant);
          addFlag(a, {
            ...trig(item.path, ing.id, "prior_variant", a, a.variant),
            // A property of one possible variant is at most "maybe" and an estimate.
            certainty: a.certainty === "yes" ? "maybe" : a.certainty,
            kind: a.kind === "fact" ? "estimate" : a.kind,
            probability: p,
            note: [txt(a.note, lang), txt(v?.prior_rationale, lang)].filter(Boolean).join(" "),
          });
        }
      }
      dietInputs.push({
        path: item.path,
        ingredient: ing,
        variantBasis: base.variant?.basis,
        variantIds: labelVariants.length ? labelVariants : priorTop ? [priorTop] : [],
      });
    } else if (base.role === "ingredient" && !children.some((c) => c.role === "ingredient")) {
      dietInputs.push({ path: item.path }); // unmatched leaf → "unknown" for every diet
    }

    // A variant name the item denies ("without using partially hydrogenated sesame oil") is read like a claim (b2
    // policy B): the food's own allergens stand at "maybe", and nothing else of it (no origin, diet or processing).
    const denied: DeniedText[] = [];
    for (const c of children) denied.push(...deniedTexts.get(c.path) ?? []);
    if (excluded.length) {
      const tokens = normName(item.name).split(" ");
      const covered = new Uint8Array(tokens.length);
      for (const x of excluded) covered.fill(1, x.start, x.end);
      denied.push({ tokens, covered });
    }
    for (const x of excluded) {
      const q = index.get(x.ingredientId);
      if (!q) continue;
      const exempt = exemptFrom(q, x.variantId);
      const own = ownAllergens(q).filter((a) => !exempt.has(a.code));
      if (own.length) deniedFoods.add(q.id);
      for (const a of own) {
        addFlag(a, {
          ...trig(item.path, q.id, "qualifier", a),
          certainty: "maybe",
          kind: a.kind === "fact" ? "estimate" : a.kind,
        });
      }
    }
    // Sources named in qualifiers, children or CAPS emphasis carry their allergens to this item.
    for (const c of children) {
      if ((c.role === "qualifier" || c.role === "e_number") && c.match) {
        const q = index.get(c.match.ingredient_id);
        if (!q) continue;
        const allergens = c.role === "qualifier"
          ? qualifierAllergens(q, qualifierVariants.get(c.path))
          : allergenAssertions(q);
        for (const a of allergens) addFlag(a, trig(item.path, q.id, "qualifier", a));
        if (c.role === "qualifier") dietInputs.push({ path: c.path, ingredient: q });
      }
    }
    if (denied.length) deniedTexts.set(item.path, denied);
    const unknownEmphasis: string[] = [];
    for (const w of item.emphasized) {
      // "without using hydrogenated SOY oil": every occurrence of the word sits inside a denied name, whose
      // allergens stand at maybe; one outside ("olive oil with SOY (without using hydrogenated soy oil)") still counts
      if (denied.length && insideDenied(normName(w), normName(item.raw), denied)) continue;
      const em = index.match(w);
      const q = em && em.confidence >= 0.9 ? index.get(em.ingredientId) : undefined;
      if (q) { for (const a of allergenAssertions(q)) addFlag(a, trig(item.path, q.id, "emphasis", a)); }
      else unknownEmphasis.push(w);
    }
    // Emphasis the KB cannot explain: EU law emphasises allergens, so say "possibly one" rather than nothing.
    // Not when this item or one inside it already raised an allergen, or when the emphasised word is known.
    const explained = [...allergenPaths].some((p) => p === item.path || p.startsWith(`${item.path}.`));
    if (unknownEmphasis.length && !explained) {
      addFlag(EMPHASIS_ASSERTION, {
        path: item.path,
        ...(base.match ? { ingredient_id: base.match.ingredient_id } : {}),
        basis: "emphasis",
        certainty: "maybe",
        kind: "estimate",
        grade: "B",
        note: emphasisNote(unknownEmphasis, lang),
      });
    }
    return base;
  };

  const items = parsed.items.map((it) => resolveItem(it));
  const sugar = flags.get("health.added_sugar");
  if (sugar && noteSugarPositions(sugar, items, lang)) citedSources.add(ORDER_SOURCE.id);
  // Amounts: only from declared nutrition. GL reads the GI of every matched carbohydrate source.
  const carriers: GiCarrier[] = [];
  const collect = (list: ItemResult[]) => {
    for (const it of list) {
      const g = it.match ? index.get(it.match.ingredient_id)?.glycemic : undefined;
      if (g?.length) carriers.push({ ingredient_id: it.match!.ingredient_id, glycemic: g });
      collect(it.children);
    }
  };
  if (opts.nutrition?.carbohydrate_g !== undefined) collect(items);
  const nutrition = opts.nutrition ? assessNutrition(opts.nutrition, carriers, lang) : null;
  const nutritionFlag = (
    code: string,
    path: string,
    t: Pick<FlagTrigger, "kind" | "grade" | "note" | "sources" | "population">,
  ) => {
    const impl = index.implications.get(code);
    if (!impl) return;
    for (const s of t.sources) citedSources.add(s.id);
    flags.set(code, {
      code,
      group: impl.group,
      severity: impl.severity,
      concern: impl.concern,
      label: txt(impl.label, lang),
      certainty: "yes",
      kind: t.kind,
      grade: t.grade,
      triggers: [{ path, basis: "nutrition", certainty: "yes", ...t }],
    });
  };
  if (nutrition) {
    for (const s of nutrition.sugars.sources) citedSources.add(s.id);
    for (const s of nutrition.glycemic_load?.sources ?? []) citedSources.add(s.id);
    if (nutrition.sugars.band === "high") {
      nutritionFlag("health.high_sugar", "nutrition.sugars_g", {
        kind: "fact",
        grade: "A",
        population: ["general"],
        note: highSugarNote(nutrition, opts.nutrition!.serving, lang),
        sources: nutrition.sugars.sources,
      });
    }
    // Only when the whole range is high: an uncertain range never raises the flag.
    const gl = nutrition.glycemic_load;
    if (gl?.status === "estimated" && gl.band?.[0] === "high") {
      nutritionFlag("health.high_glycemic_load", "nutrition.carbohydrate_g", {
        kind: "estimate",
        grade: "D",
        note: highGlNote(gl, opts.nutrition!.serving!, lang),
        sources: gl.sources,
      });
    }
  }

  // Precautionary allergen statement ("może zawierać orzechy, sezam").
  const mayContain: AnalysisResult["may_contain"] = [];
  if (parsed.mayContain) {
    const body = parsed.mayContain.replace(
      /^(?:produkt\s+)?(?:mo[żz]e\s+zawiera[ćc]|may\s+contain|contains?\s+traces?\s+of|kann|enth[äa]lt|spuren\s+von)\s*(?:[śs]ladow[ea]\s+ilo[śs]ci|traces?\s+of|spuren\s+von|spuren)?\s*:?\s*/iu,
      "",
    ).replace(/\s*enthalten\.?$/iu, "").replace(/\)+$/, "");
    for (const part of splitTopLevel(body.replace(/\s+(?:i|oraz|and|und|or|lub|oder)\s+/giu, ", "))) {
      const m = index.match(part);
      const ing = m && m.confidence >= 0.75 ? index.get(m.ingredientId) : undefined;
      const allergens = ing ? allergenAssertions(ing).map((a) => a.code) : [];
      mayContain.push({ text: part, ingredient_id: ing?.id ?? null, allergens });
    }
  }

  const diets = Object.fromEntries(DIETS.map((d) => [d, dietVerdict(d, dietInputs)])) as Record<
    DietId,
    DietVerdict
  >;

  const flagList = [...flags.values()].sort((a, b) =>
    SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
    CERTAINTY_RANK[b.certainty] - CERTAINTY_RANK[a.certainty] || a.code.localeCompare(b.code)
  );

  let total = 0, matched = 0, low = 0;
  const count = (list: ItemResult[]) => {
    for (const it of list) {
      if (it.role === "ingredient" || it.role === "class") {
        const leaf = !it.children.some((c) => c.role === "ingredient" || c.role === "class");
        if (leaf || it.match) {
          total++;
          if (it.match) {
            matched++;
            if (it.match.confidence < 0.8) low++;
          }
        }
      }
      count(it.children);
    }
  };
  count(items);

  const summary = {
    warning: 0,
    caution: 0,
    notice: 0,
    info: 0,
    highest: null as Severity | null,
    danger: null as Severity | null,
  };
  for (const f of flagList) {
    summary[f.severity]++;
    if (!summary.highest || SEVERITY_RANK[f.severity] > SEVERITY_RANK[summary.highest]) {
      summary.highest = f.severity;
    }
  }
  if (opts.profile) {
    const wants = profileMatcher(opts.profile);
    for (const f of flagList) f.personal = wants(f.code);
  }
  const ranking = rankByDanger(index, items, flagList, diets, opts.profile, lang);
  for (const r of ranking) {
    for (const why of r.reasons) {
      if (why.concern !== "hazard" && !why.personal) continue;
      if (!summary.danger || SEVERITY_RANK[why.severity] > SEVERITY_RANK[summary.danger]) {
        summary.danger = why.severity;
      }
    }
  }

  for (const f of flagList) {
    if (!f.triggers.some((t) => t.basis === "nutrition") || (f.concern !== "hazard" && !f.personal)) continue;
    if (!summary.danger || SEVERITY_RANK[f.severity] > SEVERITY_RANK[summary.danger]) {
      summary.danger = f.severity;
    }
  }

  const result: AnalysisResult = {
    kb_version: index.version,
    lang,
    items,
    flags: flagList,
    ranking,
    diets,
    may_contain: mayContain,
    label_statements: parsed.statements,
    coverage: { ingredients: total, matched, low_confidence: low, ratio: total ? round(matched / total) : 0 },
    summary,
    nutrition,
    unanalysed_text: parsed.trailing,
    sources: {},
    disclaimer: DISCLAIMER[lang],
    ai_generated_content: false,
  };

  if (opts.profile) result.profile = evaluateProfile(opts.profile, flagList, mayContain, diets);

  // Cite what the flags cite; mark content that has not had human review.
  for (const id of [...citedSources].sort()) {
    const s = index.sources.get(id);
    if (s) {
      result.sources[id] = {
        title: s.title,
        url: s.url,
        ...(s.year ? { year: s.year } : {}),
        ...(s.publisher ? { publisher: s.publisher } : {}),
      };
    }
  }
  const touched = new Set(dietInputs.map((d) => d.ingredient?.id).filter(Boolean) as string[]);
  for (const id of deniedFoods) touched.add(id);
  result.ai_generated_content = [...touched].some((id) => index.get(id)?.provenance === "ai-drafted");
  return result;
}

/** An item's normalised words, and which of them its denied names cover. */
interface DeniedText {
  tokens: string[];
  covered: Uint8Array;
}

/**
 * Whether every occurrence of the words `w` in the item's normalised text `item` lies inside its denied names: as
 * many occurrences wholly on covered words of it and its brackets as in the whole text.
 */
function insideDenied(w: string, item: string, denied: DeniedText[]): boolean {
  if (!w) return false;
  const ws = w.split(" ");
  const occurrences = (tokens: string[], covered?: Uint8Array) => {
    let n = 0;
    for (let i = 0; i + ws.length <= tokens.length; i++) {
      if (ws.every((x, j) => tokens[i + j] === x && (!covered || covered[i + j]))) n++;
    }
    return n;
  };
  const inItem = occurrences(item.split(" "));
  return inItem > 0 && inItem <= denied.reduce((n, d) => n + occurrences(d.tokens, d.covered), 0);
}

// Position is the only amount signal a bare list carries: it runs in descending order of weight, though
// ingredients under 2% may close it in any order (Reg 1169/2011 art. 18(1), Annex VII Part A point 6).
const ORDER_SOURCE = { id: "reg-1169-2011", locator: "Article 18(1); Annex VII Part A" };
const SUGAR_FACTS: Record<Lang, {
  first: string;
  nth: (n: number, of: number) => string;
  declared: (raw: string) => string;
  kinds: (k: number) => string;
}> = {
  en: {
    first: "It is the first ingredient: EU lists run in descending order of weight.",
    nth: (n, of) => `Listed ${n} of ${of}.`,
    declared: (raw) => `Declared at ${raw}.`,
    kinds: (k) => `One of ${k} different added sugars on this label.`,
  },
  pl: {
    first: "To pierwszy składnik: w UE skład podaje się w malejącej kolejności masy.",
    nth: (n, of) => `Na ${n}. miejscu z ${of}.`,
    declared: (raw) => `Zadeklarowano ${raw}.`,
    kinds: (k) => `Jeden z ${k} różnych cukrów dodanych na tej etykiecie.`,
  },
  de: {
    first: "Es ist die erste Zutat: In der EU stehen Zutaten in absteigender Reihenfolge des Gewichts.",
    nth: (n, of) => `An ${n}. Stelle von ${of}.`,
    declared: (raw) => `Angegeben mit ${raw}.`,
    kinds: (k) => `Einer von ${k} verschiedenen zugesetzten Zuckern auf diesem Etikett.`,
  },
};

/** Adds position facts to each added-sugar trigger; true when one rests on the order rule. */
function noteSugarPositions(flag: Flag, items: ItemResult[], lang: Lang): boolean {
  const t = SUGAR_FACTS[lang];
  const kinds = new Set(flag.triggers.map((x) => x.ingredient_id)).size;
  const tops = items.filter((it) => it.role === "ingredient" || it.role === "class");
  let cited = false;
  for (const trigger of flag.triggers) {
    const facts: string[] = [];
    // Only top-level items: a nested percentage is a share of its compound, not of the food.
    const at = tops.findIndex((it) => it.path === trigger.path);
    if (at === 0) {
      facts.push(t.first);
      trigger.sources = [...trigger.sources, ORDER_SOURCE];
      cited = true;
    } else if (at > 0) facts.push(t.nth(at + 1, tops.length));
    const pct = at >= 0 ? tops[at].percent : undefined;
    if (pct?.value !== undefined) facts.push(t.declared(pct.raw));
    if (kinds > 1) facts.push(t.kinds(kinds));
    if (facts.length) trigger.note = [trigger.note, ...facts].filter(Boolean).join(" ");
  }
  return cited;
}

const UNRECOGNISED_EMPHASIS = "allergen.unrecognised_emphasis";
// Reg 1169/2011 Art 21(1)(b): the 14 allergens must stand out in the list by typeset (here, capitals).
const EMPHASIS_ASSERTION: AssertionT = {
  code: UNRECOGNISED_EMPHASIS,
  certainty: "maybe",
  kind: "estimate",
  grade: "B",
  note: { en: "Emphasised on the label but not recognised." },
  sources: [{ id: "reg-1169-2011", locator: "Article 21(1)(b)" }],
};

function emphasisNote(words: string[], lang: Lang): string {
  const w = words.map((x) => `"${x}"`).join(", ");
  return {
    en:
      `${w} is emphasised on the label, as EU law requires for the 14 allergens, but the knowledge base does not ` +
      "recognise it, so it cannot say which allergen this is. Check the item on the pack.",
    pl:
      `${w} wyróżniono na etykiecie, jak prawo UE wymaga dla 14 alergenów, ale baza wiedzy tego nie rozpoznaje, ` +
      "więc nie wskazuje, który to alergen. Sprawdź ten składnik na opakowaniu.",
    de:
      `${w} ist auf dem Etikett hervorgehoben, wie es das EU-Recht für die 14 Allergene verlangt, aber die ` +
      "Wissensbasis erkennt es nicht und kann daher nicht sagen, welches Allergen es ist. Bitte auf der Packung prüfen.",
  }[lang];
}

function trig(
  path: string,
  ingredientId: string,
  basis: FlagTrigger["basis"],
  a: AssertionT,
  variantId?: string,
): Omit<FlagTrigger, "note" | "sources" | "population"> {
  return {
    path,
    ingredient_id: ingredientId,
    ...(variantId ? { variant_id: variantId } : {}),
    basis,
    certainty: a.certainty,
    kind: a.kind,
    grade: a.grade,
  };
}

function toMatch(index: KbIndex, id: string, type: MatchType, confidence: number): ItemResult["match"] {
  const ing = index.get(id)!;
  return {
    ingredient_id: ing.id,
    name: ing.names.en[0],
    ...(ing.e_number ? { e_number: ing.e_number } : {}),
    match_type: type,
    confidence,
    review_status: ing.review_status,
  };
}

const ORIGIN_ANIMAL = ["origin.animal", "origin.fish", "origin.insect"];
// Made by animals, not from them: not vegan, still vegetarian.
const ORIGIN_ANIMAL_PRODUCT = ["origin.dairy", "origin.egg", "origin.bee_product"];

/**
 * Parent nouns a bracketed part leans on. EU labels may group refined oils as "oleje roślinne (palmowy,
 * rzepakowy)" (Reg 1169/2011 Annex VII Part A item 8), and vitamins as "Vitamins (B6, B12)".
 */
const CONTEXT_FORMS: { parent: RegExp; forms: ((part: string) => string)[] }[] = [
  {
    parent:
      /\b(?:olej\w*|oleje|oil|oils|tluszcz\w*|fat|fats|ol|ole|pflanzenole?|speiseole?|pflanzenfette?)\b/,
    forms: [
      (p) => `olej ${p}`,
      (p) => `tluszcz ${p}`,
      (p) => `${p} oil`,
      (p) => `${p} fat`,
      (p) => `${p}ol`,
      (p) => `${p}fett`,
    ],
  },
  { parent: /\b(?:witamin\w*|vitamin\w*)\b/, forms: [(p) => `vitamin ${p}`, (p) => `witamina ${p}`] },
];

/** One matched item as the diet verdicts see it: the variants the label names, else the top prior (≥ 0.5). */
interface DietInput {
  path: string;
  ingredient?: IngredientT;
  variantBasis?: "label" | "prior";
  variantIds?: string[];
}

/** Explicit diet.* status, if the entry states one for the variants in play. */
function explicitDietStatus(
  ing: IngredientT,
  code: string,
  variantBasis?: "label" | "prior",
  variantIds: string[] = [],
): Certainty | undefined {
  let explicit = (ing.assertions ?? []).filter((a) =>
    a.code === code && (!a.variant || (variantBasis !== undefined && variantIds.includes(a.variant)))
  );
  // A variant the label names overrides the ingredient-wide default (E471 "pochodzenia roślinnego").
  if (variantBasis === "label") {
    const specific = explicit.filter((a) => a.variant);
    if (specific.length) explicit = specific;
  }
  if (!explicit.length) return undefined;
  // Label-determined or ingredient-wide assertions decide; a prior variant's can only raise doubt.
  const firm = explicit.filter((a) => !a.variant || variantBasis === "label");
  const pool = firm.length ? firm : explicit;
  const statuses = new Set(pool.map((a) => a.certainty));
  if (!firm.length) {
    return statuses.has("no") || statuses.has("maybe")
      ? "maybe"
      : statuses.has("unknown")
      ? "unknown"
      : "yes";
  }
  if (statuses.has("no")) return "no";
  if (statuses.has("maybe")) return "maybe";
  if (statuses.has("unknown")) return "unknown";
  return "yes";
}

/** One ingredient's status for one diet: explicit diet.* assertion first, then derived from origin/allergens. */
export function ingredientDietStatus(
  diet: DietId,
  ing: IngredientT,
  variantBasis?: "label" | "prior",
  variantIds: string[] = [],
): Certainty {
  const explicit = explicitDietStatus(ing, `diet.${diet}`, variantBasis, variantIds);
  if (explicit) return explicit;
  // Vegan implies vegetarian; not vegetarian implies not vegan.
  if (diet === "vegetarian" && explicitDietStatus(ing, "diet.vegan", variantBasis, variantIds) === "yes") {
    return "yes";
  }
  if (diet === "vegan" && explicitDietStatus(ing, "diet.vegetarian", variantBasis, variantIds) === "no") {
    return "no";
  }
  const applicable = (ing.assertions ?? []).filter((a) =>
    !a.variant || (variantBasis !== undefined && variantIds.includes(a.variant))
  );
  const has = (codes: string[], c: Certainty) =>
    applicable.some((a) =>
      codes.includes(a.code) &&
      // A prior variant's "yes" is only a "maybe" for the product.
      (a.variant && variantBasis === "prior"
        ? c === "maybe" && (a.certainty === "yes" || a.certainty === "maybe")
        : a.certainty === c)
    );
  const allergen = (names: string[]) => names.map((n) => `allergen.${n}`);
  switch (diet) {
    case "vegan": {
      const animal = [
        ...ORIGIN_ANIMAL,
        ...ORIGIN_ANIMAL_PRODUCT,
        ...allergen(["milk", "eggs", "fish", "crustaceans", "molluscs"]),
      ];
      if (has(animal, "yes")) return "no";
      if (has(animal, "maybe")) return "maybe";
      break;
    }
    case "vegetarian": {
      const meat = [...ORIGIN_ANIMAL, ...allergen(["fish", "crustaceans", "molluscs"])];
      if (has(meat, "yes")) return "no";
      if (has(meat, "maybe")) return "maybe";
      break;
    }
    case "gluten_free":
      if (has(["allergen.gluten"], "yes")) return "no";
      if (has(["allergen.gluten"], "maybe")) return "maybe";
      if (ing.provenance === "wikidata" && isModifiedStarch(ing.e_number)) return "unknown";
      return "yes";
    case "lactose_free":
      if (has(["allergen.milk"], "yes")) return "no";
      if (has(["allergen.milk"], "maybe")) return "maybe";
      return "yes";
  }
  // Vegan/vegetarian with no animal signal: known if the entry states any origin, else unknown.
  const knownOrigin = applicable.some((a) => a.code.startsWith("origin.") && a.certainty === "yes");
  return knownOrigin ? "yes" : "unknown";
}

function dietVerdict(diet: DietId, inputs: DietInput[]): DietVerdict {
  const because: DietVerdict["because"] = [];
  let status: Certainty = inputs.length ? "yes" : "unknown";
  const rank: Record<Certainty, number> = { yes: 0, unknown: 1, maybe: 2, no: 3 };
  for (const inp of inputs) {
    const s = inp.ingredient
      ? ingredientDietStatus(diet, inp.ingredient, inp.variantBasis, inp.variantIds)
      : "unknown";
    if (s !== "yes") {
      because.push({
        path: inp.path,
        ...(inp.ingredient ? { ingredient_id: inp.ingredient.id } : {}),
        status: s,
      });
    }
    if (rank[s] > rank[status]) status = s;
  }
  because.sort((a, b) => rank[b.status] - rank[a.status]);
  return { status, because: because.slice(0, 20) };
}

function evaluateProfile(
  profile: Profile,
  flags: Flag[],
  mayContain: AnalysisResult["may_contain"],
  diets: Record<DietId, DietVerdict>,
): NonNullable<AnalysisResult["profile"]> {
  const matches = profileMatcher(profile);
  const hits: NonNullable<AnalysisResult["profile"]>["hits"] = [];
  for (const f of flags) {
    if (matches(f.code)) {
      hits.push({
        code: f.code,
        certainty: f.certainty,
        paths: [...new Set(f.triggers.map((t) => t.path))],
        trace: false,
      });
    }
  }
  const traceCodes = new Set(mayContain.flatMap((m) => m.allergens));
  for (const code of traceCodes) {
    if (matches(code) && !hits.some((h) => h.code === code)) {
      hits.push({ code, certainty: "maybe", paths: [], trace: true });
    }
  }
  return {
    hits,
    diets: (profile.diets ?? []).map((d) => ({ diet: d, status: diets[d].status })).filter((d) =>
      d.status !== "yes"
    ),
  };
}

const profileMatcher = (profile?: Profile) => (code: string) =>
  (profile?.avoid ?? []).some((p) => (p.endsWith(".*") ? code.startsWith(p.slice(0, -1)) : code === p));

// ---------------------------------------------------------------- danger ranking
// score = concern × severity × certainty × grade, per reason; an item scores its strongest reason plus a
// tenth of the rest. Severity weights double per step, so one caution outranks a notice with company.
const SEVERITY_WEIGHT: Record<Severity, number> = { info: 1, notice: 2, caution: 4, warning: 8 };
// Sensitivities and preferences rank only when the profile asks about them (then at weight 1): milk is a
// danger to the allergic reader, not to everyone. A quality marker ranks below any hazard of equal severity.
const CONCERN_WEIGHT: Record<Concern, number> = {
  hazard: 1,
  quality: 0.25,
  sensitivity: 0,
  preference: 0,
  info: 0,
};
const CERTAINTY_WEIGHT: Partial<Record<Certainty, number>> = { yes: 1, maybe: 0.5 };
const GRADE_WEIGHT = { A: 1, B: 0.85, C: 0.7, D: 0.55 } as const;

function rankByDanger(
  index: KbIndex,
  items: ItemResult[],
  flags: Flag[],
  diets: Record<DietId, DietVerdict>,
  profile: Profile | undefined,
  lang: Lang,
): RankedItem[] {
  const wants = profileMatcher(profile);
  const byPathItem = new Map<string, ItemResult>();
  const visit = (list: ItemResult[]) => {
    for (const it of list) {
      byPathItem.set(it.path, it);
      visit(it.children);
    }
  };
  visit(items);

  type Reason = RankedItem["reasons"][number] & { weight: number };
  const byPath = new Map<string, { ingredientId: string | null; reasons: Map<string, Reason> }>();
  const offer = (path: string, ingredientId: string | null, r: Reason) => {
    if (r.weight <= 0) return;
    const entry = byPath.get(path) ?? { ingredientId, reasons: new Map<string, Reason>() };
    byPath.set(path, entry);
    const prev = entry.reasons.get(r.code);
    if (!prev || r.weight > prev.weight) entry.reasons.set(r.code, r);
  };

  for (const f of flags) {
    const personal = wants(f.code);
    const concernWeight = personal ? 1 : CONCERN_WEIGHT[f.concern];
    if (!concernWeight) continue;
    for (const t of f.triggers) {
      if (t.basis === "nutrition") continue; // not a label item
      offer(t.path, byPathItem.get(t.path)?.match?.ingredient_id ?? t.ingredient_id ?? null, {
        code: f.code,
        label: f.label,
        concern: f.concern,
        severity: f.severity,
        certainty: t.certainty,
        grade: t.grade,
        personal,
        weight: concernWeight * SEVERITY_WEIGHT[f.severity] * (CERTAINTY_WEIGHT[t.certainty] ?? 0) *
          GRADE_WEIGHT[t.grade],
      });
    }
  }
  // A diet the profile keeps is personal as well: with "lactose_free", milk ranks as a danger for this
  // reader. The reason's certainty is the diet status (no / maybe); "no" ranks as a warning.
  for (const d of profile?.diets ?? []) {
    const impl = index.implications.get(`diet.${d}`);
    if (!impl) continue;
    for (const b of diets[d].because) {
      if (b.status !== "no" && b.status !== "maybe") continue;
      const severity: Severity = b.status === "no" ? "warning" : "caution";
      offer(b.path, byPathItem.get(b.path)?.match?.ingredient_id ?? b.ingredient_id ?? null, {
        code: impl.code,
        label: txt(impl.label, lang),
        concern: impl.concern,
        severity,
        certainty: b.status,
        personal: true,
        weight: SEVERITY_WEIGHT[severity] * (CERTAINTY_WEIGHT[b.status === "no" ? "yes" : "maybe"] ?? 0),
      });
    }
  }

  const labelOrder = [...byPathItem.keys()];
  return [...byPath].map(([path, e]): RankedItem => {
    const reasons = [...e.reasons.values()].sort((a, b) => b.weight - a.weight);
    const rest = reasons.slice(1).reduce((s, r) => s + r.weight, 0);
    return {
      path,
      name: byPathItem.get(path)?.name ?? path,
      ingredient_id: e.ingredientId,
      score: round(reasons[0].weight + 0.1 * rest),
      level: reasons[0].severity,
      personal: reasons[0].personal,
      reasons: reasons.map((r) => ({
        code: r.code,
        label: r.label,
        concern: r.concern,
        severity: r.severity,
        certainty: r.certainty,
        ...(r.grade ? { grade: r.grade } : {}),
        personal: r.personal,
      })),
    };
  }).sort((a, b) => b.score - a.score || labelOrder.indexOf(a.path) - labelOrder.indexOf(b.path));
}

const round = (n: number) => Math.round(n * 1000) / 1000;
export { normName };
