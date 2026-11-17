// In-memory index over the KB bundle. Label matching and search both use it, so they cannot
// disagree about what a name means. Built once per KB version (a few ms for thousands of names).
import type {
  AssertionT,
  ExactNamesT,
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

/**
 * A name an item spells out and denies (`KbIndex.match`): a variant name its tells deny, a claim inside a longer
 * item, or a name inside such a claim. Read like a claim, never the match.
 */
export interface DeniedName {
  ingredientId: string;
  /** The normalised name as the item spells it. */
  matched: string;
  /** Its words, [start, end), in the item's normalised name. */
  start: number;
  end: number;
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
/**
 * The longest normalised item text variant tells are run on; longer text reads none. Tells are written for one item and some backtrack on
 * long input: cocoa's `kakao.*obniz.*tluszcz` over a 12,000-character item took ~4 s. On 1,400 real Polish labels
 * the longest text reaching a tell is 204 characters and every tell hit ends by character 51, so 500 changes no
 * real result and bounds the work.
 */
export const TELL_TEXT_MAX = 500;
/**
 * At most this many words between a negator and the variant name it denies ("without the addition of partially
 * hydrogenated …", "free of the use of hydrogenated …", "free from the addition of any …"), each one of
 * DENIAL_FILLERS.
 */
const DENIAL_GAP_MAX = 5;
/**
 * The words (normalised) that may stand between a negator and the variant name it denies: articles, the connectors
 * the KB's negators take ("free from", "wolny od", "ohne Zusatz von") and the verbs and nouns of an exclusion
 * ("using", "added", "the addition of", "bez stosowania", "bez dodatku"). Any other word, a food ("sugars") or an
 * affirmation ("with"), is no evidence that the negation reaches the name.
 */
const DENIAL_FILLERS = new Set([
  // en
  "a",
  "an",
  "the",
  "any",
  "of",
  "from",
  "using",
  "use",
  "used",
  "added",
  "adding",
  "addition",
  "contain",
  "contains",
  "containing",
  // pl
  "od",
  "stosowania",
  "uzycia",
  "uzywania",
  "dodatku",
  "dodawania",
  "dodania",
  "dodanego",
  "dodanej",
  "dodanych",
  "zadnego",
  "zadnych",
  "zadnej",
  "zawiera",
  "zawieraja",
  "zawierajacy",
  "zawierajace",
  // de
  "von",
  "zusatz",
  "verwendung",
  "zugesetztem",
  "zugesetzten",
]);
/** A prior variant raises its flags only when it is more likely than not (`analyze`). */
export const PRIOR_FLAG_MIN = 0.5;

export class KbIndex {
  readonly version: string;
  readonly ingredients = new Map<string, IngredientT>();
  readonly implications = new Map<string, ImplicationT>();
  readonly sources = new Map<string, SourceT>();
  readonly classes = new Map<string, FunctionClassT>();
  readonly names: NameEntry[] = [];
  private readonly byNorm = new Map<string, NameEntry>();
  /** Normalised `exact_names`: whole-item matches only (exact or fuzzy), never a sub-phrase or a search hit. */
  private readonly exactOnly = new Set<string>();
  /**
   * `<ingredient>/<variant>` for each variant with tells whose drop to its entry's own reading changes nothing it
   * asserts about allergens, diets or origins: the only variants a sub-phrase may name without selecting.
   */
  private readonly droppable = new Set<string>();
  /** The most words a droppable variant name has: how far past SUBPHRASE_MAX_TOKENS a denial is looked for. */
  private denyMaxTokens = 0;
  /** The first word of every exact-only name, and the most words one has: the occurrence scan's bounds. */
  private readonly exactFirst = new Set<string>();
  private exactMaxTokens = 0;
  private readonly byE = new Map<string, string>();
  private readonly classByNorm = new Map<string, string>();
  private readonly tells = new Map<string, { variant: VariantT; res: RegExp[] }[]>();
  /** code → ingredient ids asserting it (yes/maybe), for facet filters. */
  private readonly tagIndex = new Map<string, Set<string>>();
  private readonly textIndex = new Map<string, string>();
  /** Words a longer name begins with ("gluten", "gluten free", "gluten free wheat"); built on first use. */
  private namePrefixes?: Set<string>;
  /**
   * trigram → indices into names, ordered by name length (then index): fuzzy matching only visits names that share a
   * trigram with the query and whose length is within its slack, the only names that can be returned.
   */
  private readonly postings = new Map<string, number[]>();
  /** names[i].norm.length, for the binary search over a posting list. */
  private nameLen = new Int32Array(0);
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
      for (const n of allNames(ing.exact_names)) this.addExactName(n.name, n.lang, ing.id);
      this.markDroppable(ing);
      for (const a of ing.assertions ?? []) {
        if (a.certainty !== "yes" && a.certainty !== "maybe") continue;
        (this.tagIndex.get(a.code) ?? this.tagIndex.set(a.code, new Set()).get(a.code)!).add(ing.id);
      }
      const summary = ing.summary ? Object.values(ing.summary).join(" ") : "";
      const process = (ing.variants ?? []).map((v) => Object.values(v.process).join(" ")).join(" ");
      this.textIndex.set(ing.id, ` ${normName(`${summary} ${process}`)} `);
    }
    this.nameLen = Int32Array.from(this.names, (n) => n.norm.length);
    // Pushing the names in (length, index) order leaves every posting list in that order.
    const order = this.names.map((_, i) => i).sort((a, b) => this.nameLen[a] - this.nameLen[b] || a - b);
    for (const i of order) {
      for (const t of this.names[i].tri) (this.postings.get(t) ?? this.postings.set(t, []).get(t)!).push(i);
    }
    this.shared = new Int32Array(this.names.length);
  }

  /**
   * The name with the highest pg_trgm similarity to `norm` (ties: earliest name), among names of a
   * comparable length (`|length - norm.length| <= slack`, both edges included). Same answer as scoring every
   * name, at the cost of the in-window part of the query's posting lists — a 12 kB label of unknown words must
   * not cost a linear scan per word, nor a walk over every long generated name that shares an "-ny" trigram.
   */
  nearestName(norm: string): { entry: NameEntry; sim: number } | null {
    const q = trigrams(norm);
    const slack = Math.max(4, norm.length * 0.4);
    const lo = norm.length - slack, hi = norm.length + slack;
    const touched: number[] = [];
    for (const t of q) {
      const list = this.postings.get(t);
      if (!list) continue;
      let a = 0, b = list.length; // first name with length >= lo
      while (a < b) {
        const m = (a + b) >> 1;
        if (this.nameLen[list[m]] < lo) a = m + 1;
        else b = m;
      }
      for (let k = a; k < list.length && this.nameLen[list[k]] <= hi; k++) {
        const i = list[k];
        if (this.shared[i]++ === 0) touched.push(i);
      }
    }
    let best = -1;
    let bestSim = 0;
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

  /** An exact-only name, unless the norm is already another name's (the validator reports the clash). */
  private addExactName(name: string, lang: string, ingredientId: string) {
    const norm = normName(name);
    if (!norm || this.byNorm.has(norm)) return;
    const entry: NameEntry = { norm, display: name, lang, ingredientId, tri: trigrams(norm) };
    this.names.push(entry);
    this.byNorm.set(norm, entry);
    this.exactOnly.add(norm);
    const words = norm.split(" ");
    this.exactFirst.add(words[0]);
    this.exactMaxTokens = Math.max(this.exactMaxTokens, words.length);
  }

  /** Whether a plain or variant name starts inside the claim at words [s, e] and runs past its end. */
  private nameRunsPast(tokens: string[], s: number, e: number, longest: number): boolean {
    for (let i = s + 1; i <= e; i++) {
      for (let j = e + 2; j <= Math.min(tokens.length, i + longest); j++) {
        const span = tokens.slice(i, j).join(" ");
        if (this.byNorm.has(span) && !this.exactOnly.has(span)) return true;
      }
    }
    return false;
  }

  /** Each exact-only name that occurs in the item, as word indexes: the longest one at each start. */
  private claimSpans(tokens: string[]): [number, number][] {
    const out: [number, number][] = [];
    if (!this.exactOnly.size) return out;
    for (let s = 0; s < tokens.length; s++) {
      if (!this.exactFirst.has(tokens[s])) continue;
      for (let len = Math.min(tokens.length - s, this.exactMaxTokens); len >= 1; len--) {
        if (this.exactOnly.has(tokens.slice(s, s + len).join(" "))) {
          out.push([s, s + len - 1]);
          break;
        }
      }
    }
    return out;
  }

  /**
   * Whether the sub-phrase pass skips words `start`..`end`, from the item's claims, precomputed once per item so each
   * span costs O(1): a span is skipped when it starts inside a claim, unless it starts at the claim, runs past it, and
   * no food comes before it (a plain name lying wholly before `start`, starting outside every claim).
   */
  private claimGuard(tokens: string[], claims: [number, number][]): (start: number, end: number) => boolean {
    const n = tokens.length;
    const inside = new Uint8Array(n); // after a claim's first word
    const inAny = new Uint8Array(n);
    const endAt = new Int32Array(n).fill(-1); // the end of the claim that starts at a word
    for (const [s, e] of claims) {
      endAt[s] = Math.max(endAt[s], e);
      inAny[s] = 1;
      for (let i = s + 1; i <= e; i++) inside[i] = inAny[i] = 1;
    }
    const before = new Uint8Array(n + 1); // before[k]: a food lies wholly in words 0..k-1
    for (let k = 1; k <= n; k++) {
      before[k] = before[k - 1];
      for (let s = Math.max(0, k - SUBPHRASE_MAX_TOKENS); !before[k] && s < k; s++) {
        if (inAny[s]) continue;
        const span = tokens.slice(s, k).join(" ");
        if (this.byNorm.has(span) && !this.exactOnly.has(span)) before[k] = 1;
      }
    }
    return (start, end) =>
      inside[start] === 1 || (endAt[start] >= 0 && !(end > endAt[start] && !before[start]));
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

  /**
   * Resolve one item's name (no brackets) to an ingredient. `excluded`, when given, receives every variant name the
   * item spells out and denies ("without using partially hydrogenated sesame oil"), whatever else the item matches:
   * such a name is read like a claim, so it is never the match, and a caller keeps only the food's allergens, at
   * "maybe" (b2 policy B).
   */
  match(text: string, excluded?: DeniedName[]): NameMatch | null {
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
    // An exact-only name is a claim ("bez utwardzonych tluszczow", "free from hydrogenated oil"): it matches only a
    // whole item, and no sub-phrase that starts inside it is read, so neither it, nor a word of it ("bez" as elder),
    // nor a name it denies outranks a food before or after it ("olej sezamowy bez utwardzonych tluszczow"). Only a
    // name that starts at the claim and runs past it is read, a food's own negated name ("bio non hydrogenated
    // coconut fat"), and only when no plain name lies before it outside the claims ("sesame oil not partially
    // hydrogenated rapeseed oil" stays sesame oil).
    const claims = this.claimSpans(tokens);
    const skip = claims.length ? this.claimGuard(tokens, claims) : null;
    // A variant name its tells deny ("without using partially hydrogenated poultry fat") is read like a claim: no
    // sub-phrase that starts inside it is read, and no fuzzy match to that food is taken, so neither the variant nor
    // the plain food inside it is the match.
    const blocked = new Uint8Array(tokens.length);
    let blockedIng: Set<string> | undefined;
    // With `excluded`, the scan goes on past the match for denied names only, so a longer name elsewhere in the item
    // ("extra virgin olive oil without using hydrogenated soybean oil") cannot hide one.
    const collect = !!excluded && norm.length <= TELL_TEXT_MAX;
    // The most complete name wins: a name whose words a denied name already covers is part of it, whatever its food
    // ("fully refined soybean oil" inside the refined-soy claim adds no soy).
    const deny = (ingredientId: string, start: number, end: number, span: string) => {
      if (excluded?.some((x) => x.start <= start && end <= x.end)) return;
      excluded?.push({ ingredientId, matched: span, start, end });
    };
    const longest = Math.min(tokens.length - 1, Math.max(SUBPHRASE_MAX_TOKENS, this.denyMaxTokens));
    // A claim inside a longer item ("contains no partially hydrogenated almond oil") denies what it names: its own
    // entry, and below, every name that starts inside it (which the claim guard keeps from being the match). Unless a
    // longer name starts inside the claim and runs past it ("no partially hydrogenated nut oil" inside "… nut oil from
    // peanuts"): that name says which food, so its food stands, not the claim's.
    if (collect) {
      for (const [s, e] of claims) {
        if (this.nameRunsPast(tokens, s, e, longest)) continue;
        const span = tokens.slice(s, e + 1).join(" ");
        const c = this.byNorm.get(span);
        if (c) deny(c.ingredientId, s, e + 1, span);
      }
    }
    let found: NameMatch | null = null;
    let foundAt = 0;
    let foundEnd = 0;
    // Longest known sub-phrase: "koncentrat bialka serwatkowego instant" → "koncentrat bialka serwatkowego". Past
    // SUBPHRASE_MAX_TOKENS, only a denied variant name is looked for: it blocks, and is never the match.
    scan: for (let len = longest; len >= 1; len--) {
      for (let start = 0; start + len <= tokens.length; start++) {
        if (blocked[start]) continue;
        if (skip?.(start, start + len - 1)) {
          const span = tokens.slice(start, start + len).join(" ");
          const e = this.byNorm.get(span);
          if (e && !this.exactOnly.has(span)) {
            // A variant name the item denies blocks its words here too, so the plain food it ends in is not read
            // after the claim ("poultry fat" in "without the use of partially hydrogenated poultry fat").
            if (this.variantReading(e, tokens, start, start + len, norm.length) === "deny") {
              blocked.fill(1, start, start + len);
              (blockedIng ??= new Set()).add(e.ingredientId);
            }
            if (collect) {
              deny(e.ingredientId, start, start + len, span);
              // and, as for a denied variant name, no fuzzy match to that food is taken
              (blockedIng ??= new Set()).add(e.ingredientId);
            }
          }
          continue;
        }
        // a name inside the match is part of it
        if (found && start < foundEnd && start + len > foundAt) continue;
        const span = tokens.slice(start, start + len).join(" ");
        if (span.length < 3 || this.exactOnly.has(span)) continue;
        const e = this.byNorm.get(span);
        if (!e) continue;
        const reading = this.variantReading(e, tokens, start, start + len, norm.length);
        if (reading === "deny") {
          blocked.fill(1, start, start + len);
          deny(e.ingredientId, start, start + len, span);
          (blockedIng ??= new Set()).add(e.ingredientId);
          continue;
        }
        if (found || len > SUBPHRASE_MAX_TOKENS) continue;
        const coverage = span.length / norm.length;
        found = {
          ingredientId: e.ingredientId,
          // a variant whose tells fail where the item does not deny it is the plain entry (#14)
          variantId: reading === "drop" ? undefined : e.variantId,
          matchType: "sub_phrase",
          confidence: Math.round((0.6 + 0.35 * coverage) * 100) / 100,
          matched: span,
        };
        foundAt = start;
        foundEnd = start + len;
        if (!collect) break scan;
      }
    }
    if (found) return found;
    if (norm.length >= 5) {
      const hit = this.nearestName(norm);
      const best =
        hit && distinctivePartsAgree(norm, hit.entry.norm) && !blockedIng?.has(hit.entry.ingredientId)
          ? hit.entry
          : null;
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

  /**
   * How the item reads the variant the name at tokens[start, end) selects. "keep": the variant (no tells, not
   * droppable (`markDroppable`), an item past TELL_TEXT_MAX (`itemLength`), or a tell fires on the item read up to
   * the name's end). Otherwise the tells fail, and the KB's negation guards they carry say why: "deny" when the
   * negation is scoped to the name, so `match` reads it like a claim ("without using partially hydrogenated rapeseed
   * oil"); "drop" (the plain entry, as #14 reads it) when it is not.
   * Scoped means: between the negator (the nearest start from which the tells fail) and the name lie at most
   * DENIAL_GAP_MAX words, each one of DENIAL_FILLERS. So a negator after the name ("… poultry fat without added
   * sugar") keeps the variant, and one that denies something else ("without added sugars with partially
   * hydrogenated poultry fat") leaves the plain food.
   */
  private variantReading(
    e: NameEntry,
    tokens: string[],
    start: number,
    end: number,
    itemLength: number,
  ): "keep" | "drop" | "deny" {
    if (
      !e.variantId || itemLength > TELL_TEXT_MAX || !this.droppable.has(`${e.ingredientId}/${e.variantId}`)
    ) {
      return "keep";
    }
    const t = this.tells.get(e.ingredientId)?.find((x) => x.variant.id === e.variantId);
    if (!t) return "keep";
    // read as `markDroppable` reads a name: between neutral words
    const fires = (from: number) => t.res.some((re) => re.test(`x ${tokens.slice(from, end).join(" ")} x`));
    if (fires(0)) return "keep";
    let k = start - 1;
    while (k > 0 && fires(k)) k--;
    const gap = tokens.slice(k + 1, start);
    return gap.length <= DENIAL_GAP_MAX && gap.every((w) => DENIAL_FILLERS.has(w)) ? "deny" : "drop";
  }

  /**
   * The variants with tells that an item may deny or drop (`variantReading`): every allergen, diet and origin assertion of the
   * variant is made, with the same certainty, by the entry's own reading (its unscoped assertions, else its most
   * likely prior variant's, at most "maybe"), so a denial never loses an allergen or turns a diet verdict: "soy
   * lecithin" or "wheat starch" keeps its variant even where its tells do not fire. And its tells must fire on each
   * of its names inside a longer neutral item ("x <name> x"), so a denial is always a negation the tells read.
   */
  private markDroppable(ing: IngredientT) {
    const scoped = (id?: string) =>
      (ing.assertions ?? []).filter((a) => a.variant === id && /^(allergen|diet|origin)\./.test(a.code));
    let top: VariantT | undefined;
    for (const v of ing.variants ?? []) if (v.prior !== undefined && (!top || v.prior > top.prior!)) top = v;
    const own = new Map(scoped(undefined).map((a) => [a.code, a.certainty as string]));
    if (top && top.prior! >= PRIOR_FLAG_MIN) {
      for (const a of scoped(top.id)) {
        if (!own.has(a.code)) own.set(a.code, a.certainty === "yes" ? "maybe" : a.certainty);
      }
    }
    for (const v of ing.variants ?? []) {
      if (!v.tells?.length || !scoped(v.id).every((a) => own.get(a.code) === a.certainty)) continue;
      // and only if its tells fire on each of its names inside a longer neutral item, so a denial is a negation
      // the tells read, never an anchored tell that a neutral item cannot meet
      const res = v.tells.map((s) => new RegExp(s, "u"));
      const names = allNames(v.names).map((n) => normName(n.name)).filter(Boolean);
      if (!names.every((n) => res.some((re) => re.test(`x ${n} x`)))) continue;
      this.droppable.add(`${ing.id}/${v.id}`);
      for (const n of names) this.denyMaxTokens = Math.max(this.denyMaxTokens, n.split(" ").length);
    }
  }

  /** Variants whose label tells fire on this text (normalised). */
  tellsFor(ingredientId: string, text: string): VariantT[] {
    const norm = normName(text);
    // Longer than any real item: no tell is read, so no variant is declared. A cut window cannot be read safely:
    // a word cut short fires the wrong tell ("fishmint" → \bfish\b), and a tell that excludes a phrase
    // (`(?!.*extra virgin)`) passes when the phrase falls past the cut. Unknown, never a wrong variant.
    if (norm.length > TELL_TEXT_MAX) return [];
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
      if (this.exactOnly.has(n.norm)) continue;
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

function allNames(names: NamesT | ExactNamesT | undefined): { name: string; lang: string }[] {
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
