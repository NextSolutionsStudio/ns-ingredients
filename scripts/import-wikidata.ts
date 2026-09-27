// deno task kb:wikidata — regenerate kb/generated/wikidata-additives.yaml from Wikidata (CC0).
// It gives every EU E-number an identity (PL/EN/DE names, CAS, ChEBI, PubChem) so labels
// resolve even before a curated entry exists. Curated files supersede these by E-number.
import { stringify } from "@std/yaml";
import { baseENumber, canonicalENumber, normName } from "../src/core/normalize.ts";

// Three light queries instead of one UNION + OPTIONAL join, which times out server-side and
// streams back truncated JSON.
const Q_IDS = `SELECT ?item ?e ?cas ?chebi ?cid WHERE { ?item wdt:P628 ?e .
  OPTIONAL { ?item wdt:P231 ?cas } OPTIONAL { ?item wdt:P683 ?chebi } OPTIONAL { ?item wdt:P662 ?cid } }`;
const Q_LABELS = `SELECT ?item ?label WHERE { ?item wdt:P628 [] ; rdfs:label ?label .
  FILTER(LANG(?label) IN ("en", "pl", "de")) }`;
const Q_ALIASES = `SELECT ?item ?label WHERE { ?item wdt:P628 [] ; skos:altLabel ?label .
  FILTER(LANG(?label) IN ("en", "pl", "de")) }`;
const QUERY = [Q_IDS, Q_LABELS, Q_ALIASES].join(" ;; ");

type Row = Record<string, { value: string; "xml:lang"?: string } | undefined>;
async function sparql(q: string): Promise<Row[]> {
  const res = await fetch(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(q)}`, {
    headers: {
      "accept": "application/sparql-results+json",
      "user-agent": "ns-ingredients/0.1 (open food-ingredient knowledge base; https://nextsolutions.studio)",
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Wikidata ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text).results.bindings;
}
const idRows = await sparql(Q_IDS);
const codeOf = new Map(idRows.map((r) => [r.item!.value, r.e!.value]));
const rows: Row[] = [
  ...idRows,
  ...(await sparql(Q_LABELS)).map((r) => ({
    ...r,
    e: { value: codeOf.get(r.item!.value)! },
    kind: { value: "label" },
  })),
  ...(await sparql(Q_ALIASES)).map((r) => ({
    ...r,
    e: { value: codeOf.get(r.item!.value)! },
    kind: { value: "alias" },
  })),
];

interface Acc {
  qid: string;
  code: string;
  exact: boolean;
  labels: Record<string, string[]>;
  aliases: Record<string, string[]>;
  cas?: string;
  chebi?: string;
  cid?: number;
}
const byItem = new Map<string, Acc>();
for (const r of rows) {
  const qid = r.item!.value.replace(/^.*\//, "");
  const code = canonicalENumber(r.e!.value);
  if (!code) continue;
  const acc = byItem.get(qid) ?? { qid, code, exact: code === baseENumber(code), labels: {}, aliases: {} };
  if (r.label) {
    const lang = r.label["xml:lang"] ?? "en";
    const label = r.label.value.trim();
    const bucket = r.kind!.value === "label" ? acc.labels : acc.aliases;
    (bucket[lang] ??= []).includes(label) || bucket[lang].push(label);
  }
  if (r.cas && /^\d{2,7}-\d{2}-\d$/.test(r.cas.value)) acc.cas ??= r.cas.value;
  if (r.chebi && /^\d+$/.test(r.chebi.value)) acc.chebi ??= `CHEBI:${r.chebi.value}`;
  if (r.cid && /^\d+$/.test(r.cid.value)) acc.cid ??= Number(r.cid.value);
  byItem.set(qid, acc);
}

// One entry per base E-number: prefer the item whose code is exactly the base (E160a over E160a(ii)).
const byBase = new Map<string, Acc[]>();
for (const acc of byItem.values()) {
  const base = baseENumber(acc.code);
  (byBase.get(base) ?? byBase.set(base, []).get(base)!).push(acc);
}

const keepName = (n: string) =>
  n.length >= 3 && n.length <= 70 && !canonicalENumber(n) && !/^\d/.test(n) && normName(n).length >= 3;

const ingredients = [];
for (
  const [base, accs] of [...byBase.entries()].sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true }))
) {
  accs.sort((a, b) => Number(b.exact) - Number(a.exact) || a.qid.localeCompare(b.qid));
  const primary = accs[0];
  const names: Record<string, string[]> = {};
  for (const lang of ["en", "pl", "de"]) {
    const seen = new Set<string>();
    const list: string[] = [];
    // Primary item's labels first, then its aliases, then other items sharing the base number.
    for (const acc of accs) {
      for (const n of [...(acc.labels[lang] ?? []), ...(acc.aliases[lang] ?? [])]) {
        const k = normName(n);
        if (keepName(n) && !seen.has(k)) {
          seen.add(k);
          list.push(n);
        }
      }
    }
    if (list.length) names[lang] = list.slice(0, 8);
  }
  if (!names.en) continue; // schema requires an English name; skip the handful without one
  ingredients.push({
    id: base.toLowerCase(),
    type: "additive",
    e_number: base,
    ids: Object.fromEntries(
      Object.entries({ wikidata: primary.qid, cas: primary.cas, chebi: primary.chebi, pubchem: primary.cid })
        .filter(([, v]) => v !== undefined),
    ),
    names,
    review_status: "imported",
    provenance: "wikidata",
  });
}

const out = {
  generated: {
    source: "Wikidata — items with property P628 (E number)",
    licence: "CC0-1.0",
    fetched: new Date().toISOString().slice(0, 10),
    query: QUERY.replace(/\s+/g, " "),
  },
  ingredients,
};
const header = "# GENERATED by scripts/import-wikidata.ts — do not edit by hand. Data: Wikidata, CC0.\n" +
  "# Identity only (names, identifiers). Claims about an additive belong in a curated kb/ingredients/ file.\n";
await Deno.writeTextFile(
  new URL("../kb/generated/wikidata-additives.yaml", import.meta.url),
  header + stringify(out, { lineWidth: -1 }),
);
const withPl = ingredients.filter((i) => i.names.pl).length;
console.log(
  `${ingredients.length} E-numbers (${withPl} with Polish names) from ${byItem.size} Wikidata items`,
);
