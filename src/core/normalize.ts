// Text normalisation shared by the KB loader, the in-memory matcher and SQL search.
// There is exactly one implementation on purpose: names are stored pre-normalised, so
// Postgres never has to agree with TypeScript about diacritics or punctuation.

const SPECIAL_FOLDS: Record<string, string> = {
  "ł": "l",
  "Ł": "l",
  "ß": "ss",
  "ø": "o",
  "Ø": "o",
  "æ": "ae",
  "Æ": "ae",
  "œ": "oe",
  "Œ": "oe",
  "đ": "d",
  "α": "alpha",
  "β": "beta",
  "γ": "gamma",
  "δ": "delta",
  "µ": "u",
  "μ": "u",
};
const SPECIAL_RE = new RegExp(`[${Object.keys(SPECIAL_FOLDS).join("")}]`, "g");

/** Lowercase, strip diacritics, fold ligatures and Greek letters used in chemical names. */
export function fold(s: string): string {
  return s
    .replace(SPECIAL_RE, (c) => SPECIAL_FOLDS[c] ?? c)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
}

/** Canonical form for name lookup: folded, punctuation → single spaces. */
export function normName(s: string): string {
  return fold(s).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Escape LIKE metacharacters so user input cannot widen a prefix match. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// Letter suffixes in use stop at h (E160a–f, E472a–f, E150a–d); a bare trailing i/ii/iii/iv/v is a
// roman subdivision written without parentheses ("E331i" = E331(i)), common in Wikidata and on labels.
const E_NUMBER_RE =
  /(?<![\p{L}\p{N}])(?:e|ins)[\s\-–]*([1-9]\d{2,3})\s*([a-h])?(?:\s*\(\s*(i{1,3}|iv|vi{0,3})\s*\)|(i{1,3}|iv|vi{0,3})(?![\p{L}]))?(?![\p{N}\p{L}])/giu;

/**
 * Find E-numbers / INS numbers in free text and return canonical codes:
 * "e 160 a (ii)" → "E160a(ii)", "INS 296" → "E296", "E-1422" → "E1422".
 */
export function findENumbers(text: string): { code: string; index: number; length: number }[] {
  const out: { code: string; index: number; length: number }[] = [];
  for (const m of text.matchAll(E_NUMBER_RE)) {
    const n = Number(m[1]);
    if (n < 100 || n > 1599) continue; // EU E-numbers run E100–E1599
    const roman = m[3] ?? m[4];
    const code = `E${m[1]}${m[2] ? m[2].toLowerCase() : ""}${roman ? `(${roman.toLowerCase()})` : ""}`;
    out.push({ code, index: m.index ?? 0, length: m[0].length });
  }
  return out;
}

/** Canonicalise a single E-number string, or null when it is not one. */
export function canonicalENumber(s: string): string | null {
  const found = findENumbers(s.trim());
  if (found.length !== 1) return null;
  const f = found[0];
  // Must cover the whole input (ignoring surrounding whitespace) to count as "an E-number".
  return f.index === 0 && f.length === s.trim().length ? f.code : null;
}

/** E160a(ii) → E160a; E296 → E296. Subdivisions resolve to their parent additive. */
export function baseENumber(code: string): string {
  return code.replace(/\(.*\)$/, "");
}

/** Padded word trigrams, same construction as pg_trgm, so fuzzy scores are comparable. */
export function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (const word of normName(s).split(" ")) {
    if (!word) continue;
    const padded = `  ${word} `;
    for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
  }
  return out;
}

/** pg_trgm similarity(): |A∩B| / |A∪B|. */
export function trigramSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Rough language guess for display purposes only; matching is language-agnostic. */
export function guessLang(text: string): "pl" | "de" | "en" {
  const head = text.slice(0, 600);
  if (/\b(skład|składniki|może zawierać)\b/i.test(head) || /[ąęłńśźż]/i.test(head)) return "pl";
  if (/\b(zutaten|kann spuren|enthält)\b/i.test(head) || /[äöüß]/i.test(head)) return "de";
  return "en";
}
