// Amounts from declared nutrition: arithmetic on the numbers the caller sends, banded by published
// criteria. Nothing here is inferred from the ingredient list, which cannot show amounts.
import type { GlycemicT, Lang } from "../kb/schema.ts";

export interface NutritionInput {
  basis: "100g" | "100ml";
  /** Total sugars as declared ("of which sugars"), per the basis. */
  sugars_g: number;
  /** Carbohydrate as declared. EU labels declare available carbohydrate: polyols in, fibre out. */
  carbohydrate_g?: number;
  /** "total" for labels whose carbohydrate includes fibre (US style); fibre_g is then needed. */
  carbohydrate_definition?: "available" | "total";
  polyols_g?: number;
  fibre_g?: number;
  serving?: { amount: number; unit: "g" | "ml" };
}

/** A label ingredient whose carbohydrate has a curated GI. */
export interface GiCarrier {
  ingredient_id: string;
  glycemic: GlycemicT[];
}

type Fraction = GlycemicT["fraction"];
type SourceRef = { id: string; locator?: string };

export interface GlycemicLoad {
  status: "estimated" | "unknown";
  reason?: "fibre_needed" | "low_coverage";
  per: "serving" | "100g" | "100ml";
  /** GL range per `per`; null when unknown. */
  range: [number, number] | null;
  /** Band of each end of the range, per serving only (bands are defined per serving). */
  band: [Band, Band] | null;
  /** Share of the available carbohydrate that has a curated GI source. */
  coverage: number;
  fractions: { fraction: Fraction; grams: number; gi: [number, number] | null; from: string[] }[];
  kind: "estimate";
  grade: "D";
  method: typeof GL_METHOD;
  assumptions: string[];
  sources: SourceRef[];
}

export type Band = "low" | "medium" | "high";

export interface NutritionResult {
  basis: "100g" | "100ml";
  sugars: {
    per_100: number;
    per_serving: number | null;
    band: Band;
    /** Which criterion set the band: the per-100 table, or the per-portion rule for large portions. */
    band_by: "per_100" | "per_portion";
    ri_percent_per_100: number;
    ri_percent_per_serving: number | null;
    criteria: "uk-fop-2016";
    kind: "fact";
    sources: { id: string; locator?: string }[];
  };
  /** Present when carbohydrate was declared. */
  glycemic_load: GlycemicLoad | null;
}

// UK front-of-pack criteria for total sugars (DHSC 2016, table 2 food, table 3 drinks). The portion rule
// applies only to portions over 100 g (food) or 150 ml (drinks). EU law sets no "high" threshold.
export const SUGAR_CRITERIA = {
  "100g": { low: 5, high: 22.5, portionHigh: 27, portionOver: 100 },
  "100ml": { low: 2.5, high: 11.25, portionHigh: 13.5, portionOver: 150 },
} as const;
/** Adult reference intake for sugars, Reg 1169/2011 Annex XIII Part B. */
export const SUGARS_RI_G = 90;
const SOURCES = [
  { id: "nut-uk-fop-2016", locator: "Tables 2 and 3" },
  { id: "reg-1169-2011", locator: "Annex XIII Part B" },
];

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

// GL = GI × available carbohydrate (g) / 100, per serving: low at 10 or less, high at 20 or more.
export const GL_METHOD = "gl-weighted-range/1";
export const GL_BANDS = { low: 10, high: 20 } as const;
/** Below this share of carbohydrate with a GI source, the estimate is "unknown" rather than a number. */
export const GL_MIN_COVERAGE = 0.7;
const GL_SOURCES = [{ id: "gi-gl-bands" }, { id: "gi-dodd-2011" }];
const FRACTIONS: Fraction[] = ["sugars", "starch", "polyols"];

const glBand = (v: number): Band => v >= GL_BANDS.high ? "high" : v > GL_BANDS.low ? "medium" : "low";

const ASSUMPTIONS: Record<Lang, {
  calculated: string;
  range: string;
  bias: string;
  unmapped: (pct: number) => string;
}> = {
  en: {
    calculated: "Not a measured GI: calculated from the GI of the carbohydrate ingredients on the label.",
    range:
      "Each fraction takes the full GI range of the label ingredients that feed it; sugars from ingredients " +
      "without a GI value (such as milk) are not seen.",
    bias: "Calculated GI tends to overestimate measured GI: by 22–50% for mixed meals (Dodd et al. 2011).",
    unmapped: (pct) => `${pct}% of the carbohydrate has no GI source and is counted as GI 0–100.`,
  },
  pl: {
    calculated: "To nie zmierzony IG: obliczony z IG składników węglowodanowych z etykiety.",
    range:
      "Każda frakcja przyjmuje pełny zakres IG składników z etykiety, które ją tworzą; cukry ze składników " +
      "bez wartości IG (np. mleka) nie są widoczne.",
    bias: "Obliczony IG zwykle zawyża zmierzony: o 22–50% dla posiłków mieszanych (Dodd i in. 2011).",
    unmapped: (pct) => `${pct}% węglowodanów nie ma źródła IG i liczy się je jako IG 0–100.`,
  },
  de: {
    calculated: "Kein gemessener GI: berechnet aus dem GI der kohlenhydrathaltigen Zutaten auf dem Etikett.",
    range:
      "Jede Fraktion übernimmt die volle GI-Spanne der Zutaten, die sie liefern; Zucker aus Zutaten ohne " +
      "GI-Wert (etwa Milch) wird nicht erfasst.",
    bias:
      "Berechnete GI-Werte überschätzen gemessene meist: um 22–50% bei gemischten Mahlzeiten (Dodd u. a. 2011).",
    unmapped: (pct) => `${pct}% der Kohlenhydrate haben keine GI-Quelle und zählen als GI 0–100.`,
  },
};

/** Weighted-range GL estimate from declared carbohydrate and the GI of the label's carbohydrate sources. */
export function estimateGlycemicLoad(
  n: NutritionInput,
  carriers: GiCarrier[],
  lang: Lang,
): GlycemicLoad | null {
  if (n.carbohydrate_g === undefined) return null;
  const per = n.serving ? "serving" : n.basis;
  const scale = n.serving ? n.serving.amount / 100 : 1;
  const a = ASSUMPTIONS[lang];
  const base = { per, kind: "estimate", grade: "D", method: GL_METHOD } as const;
  if (n.carbohydrate_definition === "total" && n.fibre_g === undefined) {
    return {
      ...base,
      status: "unknown",
      reason: "fibre_needed",
      range: null,
      band: null,
      coverage: 0,
      fractions: [],
      assumptions: [],
      sources: [],
    };
  }
  const available = Math.max(0, n.carbohydrate_g - (n.carbohydrate_definition === "total" ? n.fibre_g! : 0));
  const sugars = Math.min(n.sugars_g, available);
  const polyols = Math.min(n.polyols_g ?? 0, available - sugars);
  const grams: Record<Fraction, number> = { sugars, polyols, starch: available - sugars - polyols };

  const sources = new Map<string, SourceRef>();
  let mapped = 0, lo = 0, hi = 0;
  const fractions: GlycemicLoad["fractions"] = [];
  for (const fraction of FRACTIONS) {
    const g = round1(grams[fraction] * scale);
    if (g <= 0) continue;
    const feeds = carriers.flatMap((c) =>
      c.glycemic.filter((x) => x.fraction === fraction).map((x) => ({ id: c.ingredient_id, x }))
    );
    const gi: [number, number] | null = feeds.length
      ? [Math.min(...feeds.map((f) => f.x.range[0])), Math.max(...feeds.map((f) => f.x.range[1]))]
      : null;
    for (const f of feeds) {
      sources.set(f.x.source, { id: f.x.source, ...(f.x.locator ? { locator: f.x.locator } : {}) });
    }
    if (gi) mapped += grams[fraction];
    // A fraction with no GI source counts as GI 0–100: the range widens instead of guessing.
    lo += gi ? g * gi[0] / 100 : 0;
    hi += g * (gi ? gi[1] : 100) / 100;
    fractions.push({ fraction, grams: g, gi, from: [...new Set(feeds.map((f) => f.id))] });
  }
  const coverage = available ? round2(mapped / available) : 1;
  const assumptions = [a.calculated, a.range, a.bias];
  if (coverage < 1) assumptions.push(a.unmapped(Math.round((1 - coverage) * 100)));
  for (const s of GL_SOURCES) sources.set(s.id, s);
  if (coverage < GL_MIN_COVERAGE) {
    return {
      ...base,
      status: "unknown",
      reason: "low_coverage",
      range: null,
      band: null,
      coverage,
      fractions,
      assumptions,
      sources: [...sources.values()],
    };
  }
  const range: [number, number] = [round1(lo), round1(hi)];
  return {
    ...base,
    status: "estimated",
    range,
    band: per === "serving" ? [glBand(range[0]), glBand(range[1])] : null,
    coverage,
    fractions,
    assumptions,
    sources: [...sources.values()],
  };
}

/** The note on a health.high_glycemic_load trigger. */
export function highGlNote(
  gl: GlycemicLoad,
  serving: NonNullable<NutritionInput["serving"]>,
  lang: Lang,
): string {
  const num = (v: number) => new Intl.NumberFormat(lang).format(v);
  const [lo, hi] = gl.range!.map(num);
  const amount = `${num(serving.amount)} ${serving.unit}`;
  return {
    en: `Estimated glycemic load ${lo}–${hi} per ${amount} serving: the whole range is high (20 or more). ` +
      "An estimate from the GI of the label's carbohydrate sources, not a measured value.",
    pl:
      `Szacowany ładunek glikemiczny ${lo}–${hi} w porcji ${amount}: cały zakres jest wysoki (20 lub więcej). ` +
      "Szacunek z IG źródeł węglowodanów z etykiety, nie wartość zmierzona.",
    de:
      `Geschätzte glykämische Last ${lo}–${hi} je Portion von ${amount}: die ganze Spanne ist hoch (20 oder mehr). ` +
      "Eine Schätzung aus dem GI der Kohlenhydratquellen auf dem Etikett, kein Messwert.",
  }[lang];
}

export function assessNutrition(
  n: NutritionInput,
  carriers: GiCarrier[] = [],
  lang: Lang = "en",
): NutritionResult {
  const c = SUGAR_CRITERIA[n.basis];
  const perServing = n.serving ? round1(n.sugars_g * n.serving.amount / 100) : null;
  const band100: Band = n.sugars_g > c.high ? "high" : n.sugars_g > c.low ? "medium" : "low";
  const byPortion = band100 !== "high" && n.serving && n.serving.amount > c.portionOver &&
    perServing! > c.portionHigh;
  return {
    basis: n.basis,
    sugars: {
      per_100: n.sugars_g,
      per_serving: perServing,
      band: byPortion ? "high" : band100,
      band_by: byPortion ? "per_portion" : "per_100",
      ri_percent_per_100: Math.round(n.sugars_g / SUGARS_RI_G * 100),
      ri_percent_per_serving: perServing === null ? null : Math.round(perServing / SUGARS_RI_G * 100),
      criteria: "uk-fop-2016",
      kind: "fact",
      sources: SOURCES,
    },
    glycemic_load: estimateGlycemicLoad(n, carriers, lang),
  };
}

/** The note on a health.high_sugar trigger. */
export function highSugarNote(r: NutritionResult, serving: NutritionInput["serving"], lang: Lang): string {
  const s = r.sugars;
  const c = SUGAR_CRITERIA[r.basis];
  const unit = r.basis === "100g" ? "g" : "ml";
  const num = (v: number) => new Intl.NumberFormat(lang).format(v);
  const portion = s.band_by === "per_portion";
  const amount = portion ? s.per_serving! : s.per_100;
  const ri = portion ? s.ri_percent_per_serving! : s.ri_percent_per_100;
  const where = {
    en: portion ? `per ${num(serving!.amount)} ${unit} serving` : `per 100 ${unit}`,
    pl: portion ? `w porcji ${num(serving!.amount)} ${unit}` : `na 100 ${unit}`,
    de: portion ? `je Portion von ${num(serving!.amount)} ${unit}` : `je 100 ${unit}`,
  }[lang];
  const limit = num(portion ? c.portionHigh : c.high);
  return {
    en: `Total sugars ${num(amount)} g ${where}: above the UK front-of-pack "high" threshold of ${limit} g` +
      ` (${ri}% of the adult reference intake of 90 g). Total sugars include those naturally in milk and` +
      ` fruit; the added-sugar flag shows whether any were added.`,
    pl:
      `Cukry ogółem: ${num(amount)} g ${where}, powyżej brytyjskiego progu „wysoka zawartość” (${limit} g)` +
      ` z oznakowania z przodu opakowania (${ri}% referencyjnego spożycia 90 g dla dorosłych). Cukry ogółem` +
      ` obejmują też cukry naturalnie obecne w mleku i owocach; flaga cukru dodanego pokazuje, czy go dodano.`,
    de:
      `Zucker gesamt ${num(amount)} g ${where}: über dem britischen Front-of-Pack-Schwellenwert „hoch“ von` +
      ` ${limit} g (${ri}% der Referenzmenge von 90 g für Erwachsene). Zucker gesamt umfasst auch den` +
      ` natürlichen Zucker aus Milch und Obst; das Merkmal „Zugesetzter Zucker“ zeigt, ob Zucker zugesetzt wurde.`,
  }[lang];
}
