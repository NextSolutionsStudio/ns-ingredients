# What ns-ingredients returns, and what it deliberately does not

Decided 2026-10-26, after a survey of 16 consumer label-scanner apps and 20 food-data APIs and fact
databases (kept privately; it names commercial products). This page is the product spec: every field group
an ingredient app commonly shows, whether we return it, and why not when we don't.

## Principles

1. **Claims, not a score.** No composite 0–100 product score. One number hides the reason and mixes a
   hazard with a preference. Food makers have taken scanner apps' ratings to court, and what held up on
   appeal was documented evidence, so evidence is what we return. We return each claim
   with its kind (fact, estimate, opinion), evidence grade (A–D), certainty and sources, plus a **danger
   ranking** that itemises why each label item ranks where it does. A client that wants one number can derive
   it from `summary.danger` and `ranking[]`, and owns that choice.
2. **Authorities side by side.** EFSA, the EU Union list, the US FDA and JECFA disagree (titanium dioxide:
   banned in the EU since 2022, permitted in the US, "ADI not limited" at JECFA in 2023). Each assessment
   stays a separate dated entry with its body and scale; we never collapse them.
3. **How it is made is data.** Production variants (birch, corn-cob or fermented xylitol; fermented or
   synthetic malic acid) with their process, residues, label tells and a market prior when the label is
   silent. Almost no product or API models this; it is our main difference.
4. **Amounts when the label gives them.** An ingredient list has no doses. Amount-based flags (high sugar,
   glycaemic load) run only on declared nutrition sent with the request, and say which numbers they used.
5. **Preferences are not hazards.** Seed oils, palm oil, "artificial" colours, sweeteners and GMO sources
   are facts about origin or processing. A reader can make any of them personal through the profile; we do
   not rank them as dangers for everyone.
6. **Every rating is versioned.** `kb_version` on every response; the knowledge base is plain YAML in git,
   so the history of each entry is its change log.

## Field groups

Status: **shipped** (in the API today), **planned** (with the PR it lands in, see
[SCOPE-sugar-gl-sweeteners-colours.md](SCOPE-sugar-gl-sweeteners-colours.md) for A–E), **not planned**.

| Group | What | Status |
|---|---|---|
| Identity and matching | Names (PL/EN/DE), E-number, CAS, Wikidata, ChEBI, PubChem; match type and confidence per label item; coverage and unmatched items. | shipped |
| Function | EU functional classes (sweetener, colour, emulsifier, …), read from class headers on the label. | shipped |
| Production and source | Variants with process, residues and limits, label tells, market prior and rationale; which variant the label names, or the likely one. | shipped; more variants are KB work (citric acid: fermentation vs fruit) |
| Claims | Implication code, label, severity, concern, kind, grade, certainty, population, dose, jurisdiction, sources with locator. | shipped |
| Diets | Vegan, vegetarian, gluten-free, lactose-free as yes / no / maybe / unknown, with the items that decide it. | shipped. Halal and kosher: **not planned**, they are certifications, not ingredient facts |
| Allergens | The EU 14, including `(z MLEKA)`-style emphasis and may-contain clauses, reported separately from contents. | shipped |
| Danger ranking | `ranking[]`, `summary.danger`; profile-aware (`avoid`, `diets`), never stored. | shipped |
| Processing | Ultra-processing marker per ingredient. | shipped. A NOVA-style group estimate with its markers: **planned** later, labelled estimate |
| Regulatory status | Per jurisdiction: status, conditions, date, legal source. | shipped for the EU; US rows where a source was opened, and `regulatory.revoked_elsewhere` (FDA Red No. 3, 2025) |
| Reference values | ADI, TDI and the like, with body and year. | shipped |
| Colours | Southampton-six warning; petrochemical origin (an estimate where no source names the feedstock). | shipped: all six Southampton colours, erythrosine and seven more synthetic colours |
| Sweeteners | WHO's 2023 non-sugar-sweetener definition as `processing.non_sugar_sweetener` (an estimate for ones WHO does not name); polyols keep their laxative statement. | shipped: every EU-authorised sweetener and polyol. A trigger for unmatched items under a sweetener header: **not planned**, it only catches misspellings |
| Added sugar | Free sugars named on the list (`health.added_sugar`), with what the list proves: first ingredient, place, declared %, number of different sugars. | shipped: 19 sugars and syrups |
| Amount flags | Optional `nutrition` input (per 100 g or 100 ml, optional serving): sugar band and `health.high_sugar` on the UK front-of-pack criteria, sugar as % of the EU reference intake. | shipped |
| Glycaemic load | GL range per serving (or per 100) from cited GI values and declared carbohydrate, with coverage and assumptions; always `kind: estimate`, grade D. `health.high_glycemic_load` only when the whole range is high. | shipped |
| Field selection | `fields=` with dot paths (`ranking.reasons.label`), arrays implicit; unknown path → 400 listing valid ones. Default stays the full response. | shipped on `/v1/analyze` and `/v1/ingredients/{id}` |
| Evidence | Sources with title, publisher, year, URL, access date; claim-level locators. | shipped |
| Caching | ETag and `If-None-Match` on knowledge-base reads. | shipped |
| Nutri-Score, eco score | Product-level grades. | **not planned**: Open Food Facts computes them; the explorer shows theirs |
| Alternatives, swaps | "Try this instead". | **not planned**: needs a product catalogue, not an ingredient KB |
| Composite score | One number per product. | **not planned** (principle 1) |
| Lab results, contaminants per product | Heavy metals, PFAS, pesticide tests. | **not planned**: no product-level test data; residues stay per production variant |
| Supplements, anti-doping | Certification checks (batch-tested programmes). | **not planned**: at most a link-out to the certifier |
| Cosmetics | INCI ingredients. | **not planned** |

## How a client picks what it needs

The default response is complete, so the explorer and anyone trying the API see everything. A client with a
payload budget (AIron's mobile app) selects:

```text
POST /v1/analyze?fields=summary,ranking.name,ranking.level,ranking.reasons.label,diets,may_contain
```

Selection is in the query string, also on POST, so the cache key and the logs show it and the body stays the
label text plus the profile.

## How the knowledge base grows

Entries are drafted from sources that were opened and cited, then reviewed; `review_status` and
`provenance` say which stage each is at, and responses carry `ai_generated_content` while any matched entry
is unreviewed. Bulk drafting (more colours, sweeteners, oils) suits cheaper model lanes, with an independent
review pass before merge. The editorial rules in [CONTRIBUTING-KB.md](CONTRIBUTING-KB.md) and the
`kb:validate` checks apply to every entry, however it was drafted.
