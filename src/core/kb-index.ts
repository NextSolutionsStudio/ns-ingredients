// In-memory index over the KB bundle. Label matching and search both use it, so they cannot
// disagree about what a name means. Built once per KB version (a few ms for thousands of names).
import type {
  AssertionT,
  FunctionClassT,
  ImplicationT,
  IngredientT,
  KbBundle,
  Lang,
  NamesT,
  SourceT,
  VariantT,
} from "../kb/schema.ts";
import { baseENumber, canonicalENumber, normName, trigrams, trigramSimilarity } from "./normalize.ts";

export interface NameEntry {
  norm: string;
  display: string;
  lang: string;
  ingredientId: string;
  variantId?: string;
  tri: Set<string>;
}

export type MatchType = "exact" | "e_number" | "variant" | "sub_phrase" | "fuzzy" | "class";

export interface NameMatch {
  ingredientId: string;
  variantId?: string;
  matchType: MatchType;
  confidence: number;
  /** The normalised span that matched (for sub-phrase and fuzzy). */
  matched: string;
}

export interface SearchHit {
  id: string;
  score: number;
  matched: string;
  matchType: "exact" | "e_number" | "prefix" | "word_prefix" | "substring" | "fuzzy" | "text";
}

export interface SearchFilters {
  implication?: string[];
  origin?: string[];
  fn?: string;
  type?: string;
  review?: string;
}

const FUZZY_MIN = 0.55;
const FUZZY_EDIT_MIN_SIM = 0.4;
const SUBPHRASE_MAX_TOKENS = 7;

export class KbIndex {
  readonly version: string;
  readonly ingredients = new Map<string, IngredientT>();
  readonly implications = new Map<string, ImplicationT>();
  readonly sources = new Map<string, SourceT>();
  readonly classes = new Map<string, FunctionClassT>();
  readonly names: NameEntry[] = [];
  private readonly byNorm = new Map<string, NameEntry>();
  private readonly byE = new Map<string, string>();
  private readonly classByNorm = new Map<string, string>();
  private readonly tells = new Map<string, { variant: VariantT; res: RegExp[] }[]>();
  /** code → ingredient ids asserting it (yes/maybe), for facet filters. */
  private readonly tagIndex = new Map<string, Set<string>>();
  private readonly textIndex = new Map<string, string>();
  /** Words a longer name begins with ("gluten", "gluten free", "gluten free wheat"); built on first use. */
  private namePrefixes?: Set<string>;
  /** trigram → indices into names: fuzzy matching only visits names that share a trigram with the query. */
  private readonly postings = new Map<string, number[]>();
  private shared = new Int32Array(0);
  readonly counts: KbBundle["counts"];

  constructor(bundle: KbBundle) {
    this.version = bundle.version;
    this.counts = bundle.counts;
    for (const i of bundle.implications) this.implications.set(i.code, i);
    for (const s of bundle.sources) this.sources.set(s.id, s);
    for (const c of bundle.classes) {
      this.classes.set(c.id, c);
      for (const n of allNames(c.names)) this.classByNorm.set(normName(n.name), c.id);
    }
    for (const ing of bundle.ingredients) {
      this.ingredients.set(ing.id, ing);
      if (ing.e_number) this.byE.set(ing.e_number, ing.id);
      for (const n of allNames(ing.names)) this.addName(n.name, n.lang, ing.id);
      for (const v of ing.variants ?? []) {
        for (const n of allNames(v.names)) this.addName(n.name, n.lang, ing.id, v.id);
        if (v.tells?.length) {
          const list = this.tells.get(ing.id) ?? [];
          list.push({ variant: v, res: v.tells.map((t) => new RegExp(t, "u")) });
          this.tells.set(ing.id, list);
        }
      }
      for (const a of ing.assertions ?? []) {
        if (a.certainty !== "yes" && a.certainty !== "maybe") continue;
        (this.tagIndex.get(a.code) ?? this.tagIndex.set(a.code, new Set()).get(a.code)!).add(ing.id);
      }
      const summary = ing.summary ? Object.values(ing.summary).join(" ") : "";
      const process = (ing.variants ?? []).map((v) => Object.values(v.process).join(" ")).join(" ");
      this.textIndex.set(ing.id, ` ${normName(`${summary} ${process}`)} `);
    }
    this.names.forEach((n, i) => {
      for (const t of n.tri) (this.postings.get(t) ?? this.postings.set(t, []).get(t)!).push(i);
    });
    this.shared = new Int32Array(this.names.length);
  }

  /**
   * The name with the highest pg_trgm similarity to `norm` (ties: earliest name), among names of a
   * comparable length. Same answer as scoring every name, at the cost of the query's posting lists — a
   * 12 kB label of unknown words must not cost a linear scan per word.
   */
  nearestName(norm: string): { entry: NameEntry; sim: number } | null {
    const q = trigrams(norm);
    const touched: number[] = [];
    for (const t of q) {
      for (const i of this.postings.get(t) ?? []) if (this.shared[i]++ === 0) touched.push(i);
    }
    let best = -1;
    let bestSim = 0;
    const slack = Math.max(4, norm.length * 0.4);
    for (const i of touched) {
      const inter = this.shared[i];
      this.shared[i] = 0;
      const n = this.names[i];
      if (Math.abs(n.norm.length - norm.length) > slack) continue;
      const sim = inter / (q.size + n.tri.size - inter);
      if (sim > bestSim || (sim === bestSim && i < best)) [best, bestSim] = [i, sim];
    }
    return best >= 0 ? { entry: this.names[best], sim: bestSim } : null;
  }

  private addName(name: string, lang: string, ingredientId: string, variantId?: string) {
    const norm = normName(name);
    if (!norm) return;
    const existing = this.byNorm.get(norm);
    // First claim wins (curated entries come first in the bundle); variant names beat plain ones
    // of the same ingredient so "kwas L-jabłkowy" resolves to its variant.
    if (existing && !(existing.ingredientId === ingredientId && variantId && !existing.variantId)) return;
    const entry: NameEntry = { norm, display: name, lang, ingredientId, variantId, tri: trigrams(norm) };
    if (!existing) this.names.push(entry);
    else this.names[this.names.indexOf(existing)] = entry;
    this.byNorm.set(norm, entry);
  }

  get(id: string): IngredientT | undefined {
    const direct = this.ingredients.get(id.toLowerCase());
    if (direct) return direct;
    const e = canonicalENumber(id);
    const byE = e ? this.byE.get(baseENumber(e)) : undefined;
    return byE ? this.ingredients.get(byE) : undefined;
  }

  byENumber(code: string): IngredientT | undefined {
    const id = this.byE.get(baseENumber(code));
    return id ? this.ingredients.get(id) : undefined;
  }

  classOf(text: string): string | undefined {
    return this.classByNorm.get(normName(text));
  }

  /**
   * Whether `norm` (`normName` output) is an ingredient's or a variant's own name, in any language. A direct
   * lookup, never the matcher: the parser asks it of short runs of words around every dash and full stop.
   */
  isName(norm: string): boolean {
    return this.byNorm.has(norm);
  }

  /**
   * Every variant tell in the KB ("gluten ?free", "bezglutenow"), once each, global: the parser keeps a dash or
   * a full stop that a tell spans ("gluten - free rolled oats"), so the variant it declares survives.
   */
  allTells(): RegExp[] {
    if (!this.tellList) {
      const seen = new Map<string, RegExp>();
      for (const list of this.tells.values()) {
        for (const t of list) for (const re of t.res) seen.set(re.source, new RegExp(re.source, "gu"));
      }
      this.tellList = [...seen.values()];
    }
    return this.tellList;
  }
  private tellList?: RegExp[];

  /** Whether a longer name begins with the words `norm` (`normName` output): "gluten free" begins one. */
  beginsName(norm: string): boolean {
    if (!this.namePrefixes) {
      this.namePrefixes = new Set();
      for (const name of this.byNorm.keys()) {
        for (let i = name.indexOf(" "); i > 0; i = name.indexOf(" ", i + 1)) {
          this.namePrefixes.add(name.slice(0, i));
        }
      }
    }
    return this.namePrefixes.has(norm);
  }

  /** Resolve one item's name (no brackets) to an ingredient. */
  match(text: string): NameMatch | null {
    const norm = normName(text);
    if (!norm) return null;
    const exact = this.byNorm.get(norm);
    if (exact) {
      return {
        ingredientId: exact.ingredientId,
        variantId: exact.variantId,
        matchType: exact.variantId ? "variant" : "exact",
        confidence: 1,
        matched: norm,
      };
    }
    const tokens = norm.split(" ");
    // Longest known sub-phrase: "koncentrat bialka serwatkowego instant" → "koncentrat bialka serwatkowego".
    for (let len = Math.min(tokens.length - 1, SUBPHRASE_MAX_TOKENS); len >= 1; len--) {
      for (let start = 0; start + len <= tokens.length; start++) {
        const span = tokens.slice(start, start + len).join(" ");
        if (span.length < 3) continue;
        const e = this.byNorm.get(span);
        if (e) {
          const coverage = span.length / norm.length;
          return {
            ingredientId: e.ingredientId,
            variantId: e.variantId,
            matchType: "sub_phrase",
            confidence: Math.round((0.6 + 0.35 * coverage) * 100) / 100,
            matched: span,
          };
        }
      }
    }
    if (norm.length >= 5) {
      const hit = this.nearestName(norm);
      const best = hit && distinctivePartsAgree(norm, hit.entry.norm) ? hit.entry : null;
      const bestSim = hit?.sim ?? 0;
      if (best && bestSim >= FUZZY_MIN) {
        return {
          ingredientId: best.ingredientId,
          variantId: best.variantId,
          matchType: "fuzzy",
          confidence: Math.round(bestSim * 100) / 100,
          matched: best.norm,
        };
      }
      // One OCR slip in a short word ("sukralosa") costs a lot of trigrams; accept a small edit
      // distance among the closest trigram candidates, at a confidence below the exact tiers.
      if (best && bestSim >= FUZZY_EDIT_MIN_SIM) {
        const maxEdits = 1 + Math.floor(norm.length / 10);
        const d = editDistance(norm, best.norm, maxEdits);
        if (d <= maxEdits) {
          return {
            ingredientId: best.ingredientId,
            variantId: best.variantId,
            matchType: "fuzzy",
            confidence: Math.round((0.9 - 0.15 * d) * 100) / 100,
            matched: best.norm,
          };
        }
      }
    }
    return null;
  }

  /** Variants whose label tells fire on this text (normalised). */
  tellsFor(ingredientId: string, text: string): VariantT[] {
    const norm = normName(text);
    return (this.tells.get(ingredientId) ?? []).filter((t) => t.res.some((re) => re.test(norm))).map((t) =>
      t.variant
    );
  }

  displayName(ing: IngredientT, lang: Lang): string {
    return ing.names[lang]?.[0] ?? ing.names.en[0];
  }

  search(q: string, filters: SearchFilters = {}): SearchHit[] {
    const allowed = this.filter(filters);
    const norm = normName(q);
    if (!norm) {
      return [...allowed].sort().map((id) => ({ id, score: 0, matched: "", matchType: "text" as const }));
    }
    const best = new Map<string, SearchHit>();
    const offer = (hit: SearchHit) => {
      if (!allowed.has(hit.id)) return;
      const prev = best.get(hit.id);
      if (!prev || hit.score > prev.score) best.set(hit.id, hit);
    };
    const e = canonicalENumber(q);
    if (e) {
      const id = this.byE.get(baseENumber(e));
      if (id) offer({ id, score: 1.01, matched: e, matchType: "e_number" });
    }
    const q3 = trigrams(norm);
    for (const n of this.names) {
      let score = 0;
      let type: SearchHit["matchType"] = "fuzzy";
      if (n.norm === norm) [score, type] = [1, "exact"];
      else if (n.norm.startsWith(norm)) {
        [score, type] = [0.9 - Math.min(n.norm.length - norm.length, 40) * 0.004, "prefix"];
      } else if (norm.length >= 3 && n.norm.includes(` ${norm}`)) [score, type] = [0.78, "word_prefix"];
      else if (norm.length >= 4 && n.norm.includes(norm)) [score, type] = [0.7, "substring"];
      else {
        const sim = trigramSimilarity(q3, n.tri);
        if (sim >= 0.35) score = sim * 0.8;
      }
      if (score > 0) offer({ id: n.ingredientId, score, matched: n.display, matchType: type });
    }
    // Research queries ("petrochemical sweetener") also look at summaries and process text.
    const words = norm.split(" ").filter((w) => w.length >= 4);
    if (words.length) {
      for (const [id, text] of this.textIndex) {
        const hits = words.filter((w) => text.includes(` ${w}`)).length;
        if (hits) offer({ id, score: 0.3 * (hits / words.length), matched: "", matchType: "text" });
      }
    }
    const curatedRank = (id: string) => (this.ingredients.get(id)?.provenance === "wikidata" ? 1 : 0);
    return [...best.values()].sort((a, b) =>
      b.score - a.score || curatedRank(a.id) - curatedRank(b.id) || a.id.localeCompare(b.id)
    );
  }

  private filter(f: SearchFilters): Set<string> {
    let ids = new Set(this.ingredients.keys());
    const codes = [
      ...(f.implication ?? []),
      ...(f.origin ?? []).map((o) => (o.startsWith("origin.") ? o : `origin.${o}`)),
    ];
    for (const code of codes) {
      const tagged = this.tagIndex.get(code) ?? new Set<string>();
      ids = new Set([...ids].filter((id) => tagged.has(id)));
    }
    if (f.fn) ids = new Set([...ids].filter((id) => this.ingredients.get(id)!.functions?.includes(f.fn!)));
    if (f.type) ids = new Set([...ids].filter((id) => this.ingredients.get(id)!.type === f.type));
    if (f.review) {
      ids = new Set([...ids].filter((id) => this.ingredients.get(id)!.review_status === f.review));
    }
    return ids;
  }

  assertionsFor(ing: IngredientT, variantId?: string): AssertionT[] {
    return (ing.assertions ?? []).filter((a) => !a.variant || a.variant === variantId);
  }
}

function allNames(names: NamesT | undefined): { name: string; lang: string }[] {
  if (!names) return [];
  const out: { name: string; lang: string }[] = [];
  for (const [lang, list] of Object.entries(names)) for (const name of list ?? []) out.push({ name, lang });
  return out;
}

/** Levenshtein distance with an early exit once every path exceeds `max`. */
/**
 * Counter-ions and generic nouns that many additive names share. Two names agreeing only on these are
 * not similar: "kazeinian sodu" must not fuzzy-match "jablczany sodu" (sodium malates).
 */
const GENERIC_TOKENS = new Set([
  "sodu",
  "potasu",
  "wapnia",
  "magnezu",
  "amonu",
  "zelaza",
  "cynku",
  "sodium",
  "potassium",
  "calcium",
  "magnesium",
  "ammonium",
  "iron",
  "zinc",
  "natrium",
  "kalium",
  "magnesium",
  "ammonium",
  "eisen",
  "zink",
  "kwas",
  "kwasy",
  "kwasu",
  "acid",
  "acids",
  "saure",
  "sauren",
  "ekstrakt",
  "extract",
  "extrakt",
  "olej",
  "oil",
  "ol",
  "maka",
  "flour",
  "mehl",
  "w",
  "z",
  "ze",
  "i",
  "of",
  "and",
  "from",
  "und",
  "aus",
  "proszku",
  "powder",
  "pulver",
]);

/** When both names share generic tokens, what remains of each must still look alike. */
export function distinctivePartsAgree(a: string, b: string): boolean {
  const ta = a.split(" "), tb = b.split(" ");
  const shared = new Set(ta.filter((t) => GENERIC_TOKENS.has(t) && tb.includes(t)));
  if (!shared.size) return true;
  const ra = ta.filter((t) => !shared.has(t)).join(" ");
  const rb = tb.filter((t) => !shared.has(t)).join(" ");
  if (!ra || !rb) return true;
  if (trigramSimilarity(trigrams(ra), trigrams(rb)) >= FUZZY_MIN) return true;
  const maxEdits = 1 + Math.floor(ra.length / 10);
  return editDistance(ra, rb, maxEdits) <= maxEdits;
}

export function editDistance(a: string, b: string, max = Infinity): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
