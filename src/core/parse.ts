// Ingredient-list parser: raw label text → tree of items. Knows nothing about the KB; the
// analyser decides what each item *is*. Handles PL/EN/DE labels: headers, nested brackets,
// QUID percentages, "class: items", source qualifiers, CAPS allergen emphasis, precautionary
// clauses, mandatory statements, and trailing non-ingredient text. Where punctuation is ambiguous
// (a spaced dash, a full stop) it may ask an injected `NameOracle`, and splits only when that agrees.
import { findENumbers, normName } from "./normalize.ts";

/**
 * What the parser may ask about names. Punctuation alone cannot tell "regulator kwasowości - kwas cytrynowy"
 * (a class, then its additive) or "węglany amonu - węglany sodu" (a list) from "syrop glukozowo - fruktozowy"
 * (one hyphenated word); knowing the names can. Without an oracle the parser splits on syntax only.
 */
export interface NameOracle {
  /** The function class a text names ("emulgator" → "emulsifier"), if any. */
  classOf(text: string): string | undefined;
  /** The ingredient an item with this name would be matched to confidently, if any. */
  confident(name: string): string | undefined;
  /**
   * Whether these words are a name the KB holds whole: an ingredient's or a variant's own name, in any
   * language. `words` is `normName` output ("gluten free wheat fibre"), so a hyphen, a spaced dash and a full
   * stop read alike. A dash or a full stop inside such a name is never a separator, however well the words
   * around it match.
   */
  isName(words: string): boolean;
  /** Whether a longer such name begins with these words (`normName` output): "gluten free" begins one. */
  beginsName(words: string): boolean;
  /**
   * The KB's variant tells, global regexes over `normName` text ("gluten ?free"). A tell that spans a dash or a
   * full stop declares a variant ("gluten - free rolled oats" → gluten-free oats), so that separator is kept.
   */
  tells?(): RegExp[];
}

export interface Percent {
  value?: number;
  min?: number;
  max?: number;
  raw: string;
}

export type ItemRole = "ingredient" | "qualifier" | "e_number";

export interface ParsedItem {
  path: string;
  /** Item text including its bracketed part, as printed. */
  raw: string;
  /** Item text without brackets, percentage or header: what gets matched. */
  name: string;
  role: ItemRole;
  percent?: Percent;
  emphasized: string[];
  /** "emulgatory" in "emulgatory: lecytyny, E471" — set on the item that carries the colon. */
  header?: string;
  /** Header of an earlier item in the same sentence; the analyser applies it only if it fits. */
  inheritedHeader?: string;
  children: ParsedItem[];
}

export interface ParsedLabel {
  /** The ingredient-list part that was parsed. */
  list: string;
  items: ParsedItem[];
  /** Text of the precautionary clause ("may contain …"), if any. */
  mayContain: string | null;
  /** Mandatory statements found after the list (phenylalanine, laxative, Southampton). */
  statements: string[];
  /** Text after the list that was not analysed (storage, nutrition, …). */
  trailing: string | null;
  lang: "pl" | "en" | "de" | null;
}

const HEADER_RE =
  /(?:^|[\s.;:|>])((?:lista\s+)?sk[łl]adniki|sk[łl]ad|ingredients?|zutaten|zusammensetzung|ingr[ée]dients)\s*[:：]\s*/giu;
const HEADER_LANG: Record<string, "pl" | "en" | "de"> = {
  "skladniki": "pl",
  "sklad": "pl",
  "lista skladniki": "pl",
  "ingredients": "en",
  "ingredient": "en",
  "zutaten": "de",
  "zusammensetzung": "de",
};

const PRECAUTION_RE = new RegExp(
  [
    String.raw`(?:produkt\s+)?mo[żz]e\s+zawiera[ćc]`,
    String.raw`mog[ąa]\s+wyst[ęe]powa[ćc]`,
    String.raw`wyprodukowano\s+w\s+zak[łl]adzie`,
    String.raw`may\s+contain`,
    String.raw`contains?\s+traces?\s+of`,
    String.raw`(?:produced|manufactured|made)\s+(?:in|on)\s+a?\s*(?:facility|factory|site|line)`,
    String.raw`kann\s+(?:spuren\s+)?`,
    String.raw`enth[äa]lt\s+spuren`,
    String.raw`spuren\s+von`,
  ].map((p) => `(?:${p})`).join("|"),
  "iu",
);

// Mandatory label statements (Reg 1169/2011 Annex III, Reg 1333/2008 Annex V): recorded, not parsed.
const STATEMENTS: { id: string; re: RegExp }[] = [
  {
    id: "phenylalanine",
    re: /zawiera\s+[źz]r[óo]d[łl]o\s+fenyloalaniny|source\s+of\s+phenylalanine|phenylalaninquelle/iu,
  },
  {
    id: "laxative",
    re: /efekt\s+przeczyszczaj|dzia[łl]anie\s+przeczyszczaj|laxative\s+effect|abf[üu]hrend/iu,
  },
  {
    id: "southampton",
    re:
      /aktywno[śs][ćc]\s+i\s+skupienie\s+uwagi|activity\s+and\s+attention\s+in\s+children|aktivit[äa]t\s+und\s+aufmerksamkeit/iu,
  },
  {
    id: "sweeteners",
    re:
      /zawiera\s+substancj[eę]\s+s[łl]odz|with\s+sweeteners?|contains\s+sweeteners?|mit\s+s[üu][ßs]ungsmittel/iu,
  },
  {
    id: "caffeine_high",
    re: /wysoka\s+zawarto[śs][ćc]\s+kofeiny|high\s+caffeine\s+content|erh[öo]hter\s+koffeingehalt/iu,
  },
];

const TRAILING_MARKERS = [
  // pl
  "przechowywa",
  "przechowuj",
  "najlepiej spo",
  "nale[żz]y spo",
  "warto[śs][ćc] od[żz]ywcz",
  "warto[śs]ci od[żz]ywcz",
  "spos[óo]b przygotowania",
  "spos[óo]b u[żz]ycia",
  "zalecan",
  "ostrze[żz]eni",
  "nie przekracza",
  "masa netto",
  "wyprodukowano dla",
  "producent",
  "importer",
  "dystrybutor",
  "zawiera [źz]r[óo]d[łl]o",
  "nadmierne spo[żz]ycie",
  "zawiera substancj",
  "przed u[żz]yciem",
  // en
  "store ",
  "storage",
  "keep in",
  "best before",
  "nutrition",
  "directions",
  "suggested use",
  "warning",
  "net weight",
  "manufactured for",
  "distributed by",
  "excessive consumption",
  "contains a source of",
  // de
  "n[äa]hrwert",
  "lagerung",
  "k[üu]hl und trocken",
  "mindestens haltbar",
  "verzehrempfehlung",
  "hinweis",
  "nettof[üu]llmenge",
  "hergestellt f[üu]r",
  "bei [üu]berm[äa][ßs]igem",
];
const TRAILING_RE = new RegExp(`(?:^|[.!\\n])\\s*(?:${TRAILING_MARKERS.join("|")})`, "iu");

const QUALIFIER_RE =
  /^(?:z|ze|from|of|aus|von|pochodzeni[ae]|of\s+vegetable|vegetable|plant|roslinn|zwierzec|animal|pflanzlich|tierisch|non\s+gmo|bez\s+gmo)\b/u;
const PERCENT_ONLY_RE =
  /^(?:(min|max|mind|minimum|maximum|ca|około|okolo|approx)\.?\s*)?(<|>|≤|≥)?\s*(\d+(?:[.,]\d+)?)\s*%$/iu;
const PERCENT_RE = /(?:(min|max|mind|minimum|maximum)\.?\s*)?(<|>|≤|≥)?\s*(\d+(?:[.,]\d+)?)\s*%/iu;
const LESS_THAN_RE = /^contains\s+(?:2|two)\s*%\s+or\s+less\s+of\s*:?\s*/iu;

function toPercent(m: RegExpMatchArray): Percent {
  const n = Number(m[3].replace(",", "."));
  const qual = (m[1] ?? "").toLowerCase();
  const cmp = m[2];
  if (qual.startsWith("min") || cmp === ">" || cmp === "≥") return { min: n, raw: m[0].trim() };
  if (qual.startsWith("max") || cmp === "<" || cmp === "≤") return { max: n, raw: m[0].trim() };
  return { value: n, min: n, max: n, raw: m[0].trim() };
}

/** Unify brackets, quotes, dashes and whitespace; keep newlines for boundary detection. */
export function prepare(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\[{]/g, "(")
    .replace(/[\]}]/g, ")")
    .replace(/[“”„«»"]/g, "")
    .replace(/[‘’`´]/g, "'")
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

/** Pick the ingredient block: the one whose header matches `lang`, else the first header, else everything. */
function selectBlock(text: string, lang?: string): { block: string; lang: "pl" | "en" | "de" | null } {
  const headers = [...text.matchAll(HEADER_RE)].map((m) => ({
    start: (m.index ?? 0) + m[0].indexOf(m[1]),
    end: (m.index ?? 0) + m[0].length,
    lang: HEADER_LANG[normName(m[1])] ?? null,
  }));
  if (!headers.length) return { block: text, lang: null };
  const chosen = headers.find((h) => h.lang === lang) ?? headers[0];
  const next = headers.find((h) => h.start > chosen.start);
  return { block: text.slice(chosen.end, next ? next.start : undefined), lang: chosen.lang };
}

/**
 * A full stop ends an item only when a new sentence follows ("sól. Emulgator: …") or the text ends —
 * never inside "min. 20%", "ok. 5 g" or "tzw. aromat".
 */
function isSentenceEnd(s: string, i: number): boolean {
  const rest = s.slice(i + 1);
  if (rest.trim() === "") return true;
  const m = rest.match(/^\s+(\S)/u);
  return !!m && /\p{Lu}/u.test(m[1]);
}

/** Split on top-level separators, respecting brackets and decimal commas. */
export function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    const isDecimal = c === "," && /\d/.test(s[i - 1] ?? "") && /\d/.test(s[i + 1] ?? "");
    const isSep = depth === 0 && !isDecimal &&
      (c === "," || c === ";" || c === "\n" || c === "•" || c === "·" || c === "|" ||
        (c === "." && isSentenceEnd(s, i)));
    if (isSep) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Separate an item's own text from its bracketed parts: "whey (milk) 80%" → own "whey 80%", groups ["milk"]. */
function splitBrackets(s: string): { own: string; groups: string[] } {
  let depth = 0;
  let own = "";
  let cur = "";
  const groups: string[] = [];
  for (const c of s) {
    if (c === "(") {
      if (depth === 0) {
        cur = "";
        own += " "; // "a(b)c" leaves "a c", never "ac"
      } else cur += c;
      depth++;
    } else if (c === ")" && depth > 0) {
      depth--;
      if (depth === 0) groups.push(cur.trim());
      else cur += c;
    } else if (c === ")") {
      own += " "; // stray closing bracket at top level: a space, so "a)b" does not become "ab"
    } else if (depth > 0) cur += c;
    else own += c;
  }
  if (depth > 0 && cur.trim()) groups.push(cur.trim()); // unclosed bracket at the end of the label
  return { own: own.replace(/\s+/g, " ").trim(), groups };
}

/**
 * Open Food Facts marks the allergens of a typed-in list with underscores: "_mleko_", "_ser twarogowy_".
 * The marks are explicit, so they count even on an all-caps label. One run of non-underscores between
 * the marks, so an unclosed "_" costs linear time; a span counts only if it holds a letter.
 */
const OFF_EMPHASIS_RE = /(?<![\p{L}\p{N}_])_+([^_]+)_+(?![\p{L}\p{N}_])/gu;
const hasLetter = (s: string) => /\p{L}/u.test(s);

/** The item's name without OFF's underscore marks: "_twaróg_ ziarnisty" → "twaróg ziarnisty". */
function stripOffEmphasis(s: string): string {
  return s.replace(OFF_EMPHASIS_RE, (whole: string, inner: string) => hasLetter(inner) ? inner : whole);
}

function emphasis(raw: string, allCaps: boolean): string[] {
  const marked: string[] = [];
  const spans: [number, number][] = [];
  for (const m of raw.matchAll(OFF_EMPHASIS_RE)) {
    if (!hasLetter(m[1])) continue;
    marked.push(m[1].trim());
    spans.push([m.index, m.index + m[0].length]);
  }
  // Capitals inside a marked span are that span's emphasis already: "_MLEKO W PROSZKU_" is one, not three.
  const inMark = (i: number) => spans.some(([a, b]) => i >= a && i < b);
  const caps = allCaps ? [] : [...raw.matchAll(/(?<![\p{L}])[\p{Lu}]{3,}(?![\p{L}])/gu)]
    .filter((m) => !inMark(m.index))
    .map((m) => m[0])
    .filter((w) =>
      !/^E\d/.test(w) &&
      // Acronyms, colour-name suffixes (FCF), organic and protected-origin markers are not allergen emphasis.
      !/^(?:INS|DL|RRR|MCT|WPC|WPI|BHA|BHT|CMC|UHT|GMO|FCF|BIO|EKO|ÖKO|DOP|IGP|AOP|PDO|PGI)$/.test(w)
    );
  return [...new Set([...marked, ...caps])];
}

/** "emulgatory: lecytyny" — a short, bracket-free prefix before a colon. */
function colonHeader(text: string): RegExpMatchArray | null {
  const hm = text.match(/^([^():]{2,48}?)\s*:\s*(.+)$/su);
  return hm && hm[1].trim().split(/\s+/).length <= 5 ? hm : null;
}

type Span = [number, number];
// Not after a lone letter: "L. acidophilus", "B. lactis" abbreviate a genus ("E 150d. kwas" is no initial).
const STOP_SEP = /(?<!(?:^|[\s(])\p{L})\.\s+/uy;
const DASH_SEP = / - /y;
const JOINED_RE = / - |\.\s/;
// A word as `normName` sees one: what lies between its separators (marks stay with their letter).
const WORD_RE = /[\p{L}\p{N}\p{M}]+/uy;
/** Words read on each side of a separator when testing variant tells across it (see `nameSpans`). */
const TELL_WORDS = 6;
/** And at most this many characters a side: one long word must not pass the word limit. */
const TELL_CHARS = 60;

/**
 * Where s prints a name the KB holds whole: each run of two or more words, outside brackets, that normalises
 * to an ingredient's or a variant's own name. "gluten - free wheat fibre" in "BIO gluten - free wheat fibre"
 * and "coconut - milk" in "coconut - milk powder" are names, so their dashes are hyphens; the words around
 * them may still be cut off. A hyphenated name printed whole ("syrop glukozowo - fruktozowy") is one such
 * run. A sub-phrase or an E-number match is no name: "wzmacniacz smaku - glutaminian monosodowy" is a class
 * and its additive. A run grows only while a longer name begins with it: a few set lookups per word.
 */
function nameSpans(s: string, kb: NameOracle): Span[] {
  const words: { a: number; b: number; w: string }[] = [];
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      WORD_RE.lastIndex = i;
      const m = WORD_RE.exec(s);
      if (!m) continue;
      const w = normName(m[0]);
      if (w) words.push({ a: i, b: i + m[0].length, w });
      i += m[0].length - 1;
    }
  }
  const spans: Span[] = [];
  for (let i = 0; i < words.length; i++) {
    let run = words[i].w;
    for (let j = i + 1; j < words.length && kb.beginsName(run); j++) {
      run += ` ${words[j].w}`;
      if (kb.isName(run)) spans.push([words[i].a, words[j].b]);
    }
  }
  // Variant tells ("gluten ?free" declares gluten-free oats). They are written for one item's text, often with
  // `.*` or `^`, so they are never run over the whole segment: a separator is kept when a tell fires on the two
  // parts it joins, read as one, and on neither part alone. Only TELL_WORDS words, at most TELL_CHARS characters, on each side are read: a
  // declaration printed across a separator is a short phrase, and a `.*` tell over an unbounded part
  // backtracks ("kakao obniz " × 991 took seconds). So the work per separator is bounded.
  const tells = kb.tells?.() ?? [];
  if (tells.length && words.length > 1) {
    const gaps = [0]; // word indices that start a part: after a dash or a full stop between words
    for (let k = 1; k < words.length; k++) {
      if (/ [-–] |\.\s/.test(s.slice(words[k - 1].b - 1, words[k].a + 1))) gaps.push(k);
    }
    gaps.push(words.length);
    const text = (from: number, to: number) => words.slice(from, to).map((w) => w.w).join(" ");
    const fires = (t: string) => tells.some((re) => (re.lastIndex = 0, re.test(t)));
    for (let g = 1; g < gaps.length - 1; g++) {
      const from = Math.max(gaps[g - 1], gaps[g] - TELL_WORDS),
        to = Math.min(gaps[g + 1], gaps[g] + TELL_WORDS);
      const left = text(from, gaps[g]).slice(-TELL_CHARS), right = text(gaps[g], to).slice(0, TELL_CHARS);
      if (fires(`${left} ${right}`) && !fires(left) && !fires(right)) {
        spans.push([words[from].a, words[to - 1].b]);
      }
    }
    spans.sort((x, y) => x[0] - y[0]); // cutTopLevel walks them by start
  }
  return spans;
}

/**
 * Trimmed, non-empty spans of s[from, to) between top-level (unbracketed) matches of the sticky `sep`. A
 * match inside one of the `names` (from `nameSpans`, in order) is part of that name, not a separator.
 */
function cutTopLevel(s: string, sep: RegExp, names: Span[] = [], from = 0, to = s.length): Span[] {
  const spans: Span[] = [];
  let depth = 0;
  let start = from;
  let next = 0; // names before `next` start before i, and the furthest of them ends at `reach`
  let reach = -1;
  const push = (end: number) => {
    const part = s.slice(start, end);
    const a = start + part.length - part.trimStart().length;
    const b = start + part.trimEnd().length;
    if (b > a) spans.push([a, b]);
  };
  for (let i = from; i < to; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      sep.lastIndex = i;
      const m = sep.exec(s);
      if (!m || i + m[0].length > to) continue;
      while (next < names.length && names[next][0] < i) reach = Math.max(reach, names[next++][1]);
      if (reach > i) continue;
      push(i);
      start = i + m[0].length;
      i = start - 1;
    }
  }
  push(to);
  return spans;
}

/**
 * One item's own text parsed without the KB: its colon header and the name the analyser will match. Its brackets
 * are not its name: parsing them here would re-parse every level below, once per level.
 */
const ownItem = (text: string) => parseItem(splitBrackets(text).own, "", false, false);

/**
 * The ingredient one item names by its own name, when the analyser will match it confidently. A source
 * qualifier ("z mleka") belongs to the item before it, never stands alone; `headed` allows a colon header.
 */
function ownId(text: string, kb: NameOracle, headed: boolean): string | undefined {
  const it = ownItem(text);
  if (!it.name || (it.header && !headed) || QUALIFIER_RE.test(normName(it.name))) return undefined;
  return kb.confident(it.name);
}

/** The ingredient one item names: by its own name, or as "class - item". */
const itemId = (text: string, kb: NameOracle, headed = true) =>
  ownId(text, kb, headed) ?? classLead(text, kb)?.id;

/**
 * "regulator kwasowości - kwas cytrynowy", "emulgator. lecytyny": a known class, a spaced dash or a full stop,
 * then one known item — the colon form "regulator kwasowości: kwas cytrynowy" printed with other punctuation.
 * A full stop is looked for first, so "emulgator. mono - i diglicerydy" keeps its hyphenated word whole. The
 * class must stand on its own: in "acid - proof caramel" the dash is inside a name, so nothing is cut.
 */
function classLead(text: string, kb: NameOracle): { header: string; rest: string; id: string } | null {
  if (!JOINED_RE.test(text)) return null;
  const names = nameSpans(text, kb);
  let parts = cutTopLevel(text, STOP_SEP, names);
  if (parts.length < 2) parts = cutTopLevel(text, DASH_SEP, names);
  if (parts.length < 2) return null;
  const header = text.slice(...parts[0]);
  const rest = text.slice(parts[1][0]).trim();
  const id = kb.classOf(header) ? ownId(rest, kb, false) : undefined;
  return id ? { header, rest, id } : null;
}

/**
 * Accept a cut when the KB agrees: a class heading known items (kept with the first), or every part known.
 * The parts must name different ingredients: "E330 - kwas cytrynowy" is one ingredient named twice. The first
 * part that fails ends the asking, so a long list of unknown words costs one fuzzy match, not one per word.
 */
function joinSpans(s: string, parts: Span[], kb: NameOracle): Span[] | null {
  if (parts.length < 2) return null;
  const distinct = (list: Span[], headed: boolean) => {
    const seen = new Set<string>();
    for (const [a, b] of list) {
      const id = itemId(s.slice(a, b), kb, headed);
      if (!id || seen.has(id)) return false;
      seen.add(id);
    }
    return true;
  };
  if (kb.classOf(s.slice(...parts[0])) && distinct(parts.slice(1), false)) {
    return [[parts[0][0], parts[1][1]], ...parts.slice(2)];
  }
  return distinct(parts, true) ? parts : null;
}

/**
 * A spaced dash or a full stop used as a list separator: "węglany amonu - węglany sodu - difosforany",
 * "ocet. cukier". Cut only where every part is known, so a hyphenated word ("syrop glukozowo - fruktozowy"),
 * a Latin name ("Ryba - Katsuwonus pelamis") or a qualifier ("serwatka - z mleka") stays one item.
 * Full stops first, then dashes inside each part; a part that is a known class stays with the item it heads.
 * A separator inside a name the KB holds whole is never cut ("glucose - fructose syrup", "BIO gluten - free
 * wheat fibre"): see `nameSpans`.
 */
function splitJoined(seg: string, kb?: NameOracle): string[] {
  if (!kb || !JOINED_RE.test(seg)) return [seg];
  const names = nameSpans(seg, kb);
  const stops = cutTopLevel(seg, STOP_SEP, names);
  const pieces = stops.flatMap((s) =>
    joinSpans(seg, cutTopLevel(seg, DASH_SEP, names, s[0], s[1]), kb) ?? [s]
  );
  const out = stops.length > 1 ? joinSpans(seg, pieces, kb) : pieces;
  return out && out.length > 1 ? out.map(([a, b]) => seg.slice(a, b)) : [seg];
}

/**
 * Which header each item stands under. At the label's top level a class printed with a colon opens a list that
 * runs to the next header ("emulgatory: lecytyny, E471"), and so does a full stop typed for one ("stabilizatory.
 * mączka chleba świętojańskiego, guma guar"). A class printed with a dash heads only what is printed with it, to
 * the end of its comma part ("regulator kwasowości - kwas cytrynowy, hydrolizat białka"). The newest header's
 * punctuation decides: a colon after a dashed class still opens a list. In brackets, see `parseItem`.
 */
function headerScope() {
  let header: string | undefined;
  let dashed = false;
  return {
    /** The next item, parsed from `seg`. */
    add(item: ParsedItem, seg: string) {
      if (item.header) {
        header = item.header;
        dashed = /^ - /.test(seg.slice(seg.indexOf(header) + header.length));
      } else if (header) item.inheritedHeader = header;
    },
    /** The end of a comma part. */
    endPart() {
      if (dashed) header = undefined;
      dashed = false;
    },
  };
}

function parseItem(
  raw: string,
  path: string,
  allCaps: boolean,
  lessThan: boolean,
  kb?: NameOracle,
): ParsedItem {
  let text = raw.trim().replace(/^[-*]\s*/, "");
  let header: string | undefined;
  const hm = colonHeader(text);
  if (hm) {
    header = hm[1].trim();
    text = hm[2].trim();
  } else if (kb) {
    const lead = classLead(text, kb);
    if (lead) [header, text] = [lead.header, lead.rest];
  }
  const { own, groups } = splitBrackets(text);
  let percent: Percent | undefined;
  let name = own;
  const pm = own.match(PERCENT_RE);
  if (pm) {
    percent = toPercent(pm);
    name = own.replace(pm[0], " ").replace(/\s+/g, " ").trim();
  }
  const children: ParsedItem[] = [];
  const bareE: ParsedItem[] = [];
  let childIndex = 0;
  for (const g of groups) {
    const pOnly = g.match(PERCENT_ONLY_RE);
    if (pOnly) {
      percent ??= toPercent(pOnly);
      continue;
    }
    // Index loops: every bracket level is a frame of this function, and two nested iterators made that frame too
    // big for 2000-deep nesting (tests/property/parse_property_test.ts).
    const siblings = splitTopLevel(g);
    for (let s = 0; s < siblings.length; s++) {
      // In brackets a header heads its own comma part, however it is printed: the parts split from one dashed list
      // share it ("(substancje spulchniające - węglany amonu - węglany sodu)"), the next sibling does not. Running
      // a colon list on to the bracket's end, as at the top level, put "wanilia" under "emulgator: lecytyny;" and
      // withheld 6 airon skład scores in its two corpora, with nothing gained.
      const scope = headerScope();
      const parts = splitJoined(siblings[s], kb);
      for (let p = 0; p < parts.length; p++) {
        const part = parts[p];
        childIndex++;
        const child = parseItem(part, `${path}.${childIndex}`, allCaps, false, kb);
        scope.add(child, part);
        const n = normName(child.name);
        const es = findENumbers(child.name);
        if (
          es.length === 1 &&
          normName(child.name.replace(/(?:e|ins)[\s-]*\d{3,4}\s*[a-h]?(?:\s*\([ivx]+\))?/giu, "")) === ""
        ) {
          bareE.push(child);
        } else if (QUALIFIER_RE.test(n) && !child.children.length) {
          child.role = "qualifier";
        }
        children.push(child);
      }
    }
  }
  // A bare E-number annotates its parent ("kwas cytrynowy (E330)", "lecytyny (z soi) (E322)", "barwnik (E120)")
  // only when nothing but source qualifiers shares the brackets. In "czekolada (miazga kakaowa, …, E492, …)" it
  // is one of the chocolate's ingredients: as an annotation it named the chocolate E492 and lost its own facts.
  if (bareE.length === 1 && children.every((c) => c === bareE[0] || c.role === "qualifier")) {
    bareE[0].role = "e_number";
  }
  if (lessThan && !percent) percent = { max: 2, raw: "≤2%" };
  return {
    path,
    raw: raw.trim(),
    name: stripOffEmphasis(name).replace(/^[\s:*-]+|[\s:*.-]+$/g, ""),
    role: "ingredient",
    ...(percent ? { percent } : {}),
    emphasized: emphasis(raw, allCaps),
    ...(header ? { header } : {}),
    children,
  };
}

export function parseLabel(input: string, opts: { lang?: string; kb?: NameOracle } = {}): ParsedLabel {
  const prepared = prepare(input);
  const { block, lang } = selectBlock(prepared, opts.lang);

  let list = block;
  let trailing: string | null = null;
  let mayContain: string | null = null;

  // Statements are searched in the whole block (they usually follow the list).
  const statements = STATEMENTS.filter((s) => s.re.test(block)).map((s) => s.id);

  const pre = list.match(new RegExp(`(?:^|[,.;(\\n])\\s*(?:${PRECAUTION_RE.source})`, "iu"));
  if (pre && pre.index !== undefined) {
    const after = list.slice(pre.index).replace(/^[,.;(\n\s]+/, "");
    list = list.slice(0, pre.index);
    const t = after.match(TRAILING_RE);
    mayContain = (t?.index !== undefined ? after.slice(0, t.index) : after).replace(/[.\s]+$/, "").trim() ||
      null;
    if (t?.index !== undefined) trailing = after.slice(t.index).replace(/^[.!\n\s]+/, "").trim() || null;
  }
  const tm = list.match(TRAILING_RE);
  if (tm && tm.index !== undefined && tm.index > 0) {
    trailing = [list.slice(tm.index).replace(/^[.!\n\s]+/, "").trim(), trailing].filter(Boolean).join(" ") ||
      null;
    list = list.slice(0, tm.index);
  }
  list = list.replace(/\n+/g, ", ").replace(/[\s.,;]+$/, "").trim();

  // A label printed in capitals emphasises nothing. Count words, not letters: one long emphasised word
  // (MAGERMILCHPULVER) in a short list must not make the whole list read as capitals.
  const words = list.match(/\p{L}{2,}/gu) ?? [];
  const allCaps = words.length > 0 && words.filter((w) => !/\p{Ll}/u.test(w)).length / words.length >= 0.85;

  const items: ParsedItem[] = [];
  let lessThan = false;
  const scope = headerScope();
  let n = 0;
  for (const part of splitTopLevel(list)) {
    for (let seg of splitJoined(part, opts.kb)) {
      if (LESS_THAN_RE.test(seg)) {
        lessThan = true;
        seg = seg.replace(LESS_THAN_RE, "");
        if (!seg) continue;
      }
      n++;
      const item = parseItem(seg, String(n), allCaps, lessThan, opts.kb);
      if (!item.name && !item.children.length) {
        n--;
        continue;
      }
      scope.add(item, seg);
      items.push(item);
    }
    scope.endPart();
  }
  return { list, items, mayContain, statements, trailing, lang };
}

/** Depth-first walk over every item. */
export function* walk(items: ParsedItem[]): Generator<ParsedItem> {
  for (const it of items) {
    yield it;
    yield* walk(it.children);
  }
}
