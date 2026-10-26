// Amounts from declared nutrition: arithmetic on the numbers the caller sends, banded by published
// criteria. Nothing here is inferred from the ingredient list, which cannot show amounts.
import type { Lang } from "../kb/schema.ts";

export interface NutritionInput {
  basis: "100g" | "100ml";
  /** Total sugars as declared ("of which sugars"), per the basis. */
  sugars_g: number;
  serving?: { amount: number; unit: "g" | "ml" };
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

export function assessNutrition(n: NutritionInput): NutritionResult {
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
