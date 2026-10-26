# Scope: sugar, glycemic-load estimate, sweeteners, petroleum-derived colours

**2026-10-26 · scope only, nothing built.** Four additions the operator asked for: flag petroleum-derived
colours, mark sweeteners, flag high sugar, and estimate glycemic load (GL), clearly labelled as an estimate.

Two of them are mostly **curation on codes that already exist** (colours, sweeteners). The other two (sugar
amounts, GL) need a **new optional input**, the declared nutrition values, and a **methodology change**,
because [METHODOLOGY.md](METHODOLOGY.md) currently says the API "doesn't judge amounts".

## 1. Where things stand (checked 2026-10-26)

- **Repo:** there is **no git remote**, so the repo exists only on this PC. `feat/research-api-v1` (b3094f4) is
  not merged into `main`, which still holds only the initial commit. A **311-line uncommitted diff** from
  2026-09-27 13:27 adds `concern` to every implication, `ranking[]` ("label items ordered by danger") and
  `summary.danger`. Everything below builds on that diff, so **step 0 is to commit it and push it to a remote**.
- **Colours:** E102, E110 and E129 are curated with `origin.petrochemical_synthetic` and
  `health.southampton_colour`. **E104, E122 and E124 have only Wikidata identity entries and no claims, so a
  label with E124 raises no Southampton flag today.** The other synthetic colours have no claims either:
  E127, E131, E132, E133, E142, E151, E155 and E180.
- **Sweeteners:** eight are curated (acesulfame K, aspartame, erythritol, maltitol, sorbitol, steviol
  glycosides, sucralose, xylitol). No implication says "this is a sweetener". It shows only as the function
  class and the `sweeteners` label statement. Advantame, cyclamates, neotame and saccharin are not curated,
  and those four complete the list of eight non-sugar sweeteners in WHO's 2023 guideline. Other gaps: thaumatin
  E957, NHDC E959, E962, and the polyols mannitol E421, isomalt E953, polyglycitol E964 and lactitol E966.
- **Sugars:** sugar, dextrose, glucose syrup, lactose and maltodextrin are curated, but only with origin and
  diet claims. Not curated: fructose, glucose-fructose syrup (`syrop glukozowo-fruktozowy`, common in PL),
  invert sugar, honey, brown sugar, molasses, agave and maple syrup, fruit-juice concentrate, and isomaltulose.
- **API:** `POST /v1/analyze` takes `text`, `lang` and `profile`
  ([schemas.ts](../src/http/schemas.ts) `AnalyzeRequest`, `.strict()`). There is no way to send nutrition
  values.

## 2. Licence check: glycemic-index data

**Result: no GI dataset is both open and big enough to import.** GI values will be curated per carbohydrate
ingredient from the primary literature, one citation per value. That follows the existing source rule in
`kb/sources.yaml` ("we cite facts from it and write our own text").

| Source | What it holds | Licence | Verdict |
|---|---|---|---|
| Sydney International GI Database ([glycemicindex.com](https://glycemicindex.com/copyright-and-permission/)) | the reference GI collection | © University of Sydney, "all rights reserved"; commercial use or use in a product needs permission | **No bulk use.** A licence via the GI Foundation is possible; the cost is unknown (decision 2) |
| International Tables 2021 (Atkinson et al., AJCN 114:1625) | > 4,000 items in supplementary tables 1 (ISO method) and 2 (non-ISO) | journal copyright; no open licence found | **Cite single values only.** Importing the tables in bulk is out; EU database-right exposure is **[UNVERIFIED]**, so get a legal check before using more than a handful |
| AUSNUT GI assignment (Louie, Barclay, Brand-Miller 2016) | GI for 5,644 Australian foods, plus a 6-step assignment method | the paper says a licence from the GI Foundation is required | **No data.** The method is citable, and §3d borrows step 5, the weighted mean of ingredients |
| DataHub "glycemic-index-glycemic-load-foods" | small list of common foods | labelled PDDL, but the provenance is unclear | **No.** A PDDL label cannot clear upstream rights |
| PredictGL-NC (IEEE DataPort) | composition plus GL | built partly from the Sydney database | **No.** It inherits the Sydney terms |
| Wikidata | — | CC0 | **Nothing to use.** I found no GI property |
| Livesey 2003, Nutr Res Rev 16:163 | polyol GIs: erythritol 0, mannitol 0, lactitol 6, isomalt 9, sorbitol 9, xylitol 13, maltitol 35, polyglycitol 39; sucrose 65 | Cambridge copyright | **Cite per value.** These numbers come from the abstract; open the paper before curating them |
| Primary single-ingredient GI studies | one value each | journal copyright | **Cite per value** |
| Open Food Facts | nutrients, serving size, categories | ODbL | **OK**, in the separate `off` schema (licence partitioning, plan §1.7) |
| USDA FoodData Central | composition, including starch | public domain (CC0) | **OK** for composition defaults if needed |
| Reg 1169/2011, Reg 1924/2006 | carbohydrate definitions, Reference Intakes, nutrition-claim thresholds | EU reuse policy, CC BY 4.0 | **OK** |
| UK front-of-pack guidance | "high sugars" thresholds | Open Government Licence **[UNVERIFIED]** | **OK** to cite; open the gov.uk page before coding the numbers |
| WHO non-sugar-sweetener guideline (2023) | the NSS definition and recommendation | CC BY-NC-SA 3.0 IGO | **Cite facts and write our own text** (no prose copied from NC sources) |

## 3. Method

### 3a. Petroleum-derived colours: curation, no code change

- Curate **E104, E122 and E124 first**: until they have claims, the Southampton flag misses three of its six
  colours. Then curate E127, E131, E132, E133, E142, E151, E155 and E180. Each needs
  `origin.petrochemical_synthetic`, with evidence from a manufacturing description (Reg 231/2012 specification
  or a JECFA monograph), plus its EU `regulatory` row.
- New code **`regulatory.revoked_elsewhere`**: severity `caution`, concern `hazard`, kind `fact`. Meaning: a
  major regulator outside the EU revoked the authorisation. First use: **E127 erythrosine**, whose FDA
  authorisation was revoked on 15 Jan 2025, with a food deadline of 15 Jan 2027. The US request to phase out
  the six remaining petroleum-based dyes by the end of 2026 is **voluntary**, so it stays a note on the
  petrochemical claim, as `tartrazine.yaml` already does. It does not become a flag.
- **Wording stays the regulator's.** `origin.petrochemical_synthetic` remains `notice` / `quality`, because how
  a colour is made says nothing about its safety. The "dangerous" signal comes from the danger ranking. In
  that ranking, a Southampton colour (`caution`, `hazard`) ranks at the top, and the label text says what EU law
  requires: "may have an adverse effect on activity and attention in children". This keeps plan principle 2
  ("never 'dangerous' for a class", after the Yuka disparagement case) unless the operator overrides it
  (decision 3).

### 3b. Sweeteners

- New code **`processing.non_sugar_sweetener`**: severity `notice`, concern `quality`, kind `fact`. It uses WHO's
  definition, which names eight: acesulfame K, aspartame, advantame, cyclamates, neotame, saccharin, sucralose
  and steviol glycosides. Each of those eight gets the assertion. WHO excludes polyols, which keep
  `health.laxative_polyol`.
- Each NSS also gets a note on the WHO 2023 guideline: a **conditional** recommendation against using NSS for
  weight control, based on **low-certainty** evidence, and not covering people who already have diabetes. The
  EU regulator's ADI comes first, as METHODOLOGY already requires.
- **Unknown sweeteners under a header:** an item under "substancje słodzące:" that matches no curated entry
  gets a `maybe` trigger with a new basis, `function_class`. This also covers identity-only E-numbers.
- **Limit:** a label gives no milligram amounts, so the API cannot compare intake with an ADI. It cites the
  ADI, as it already does.

### 3c. Sugar

Sugar works at two tiers.

1. **Ingredient list only.** New code **`health.added_sugar`**: severity `notice`, concern `quality`, kind
   `fact`, with one trigger per added-sugar ingredient. These are the "free sugars" in WHO's sense: sugar,
   dextrose, glucose syrup and glucose-fructose syrup, fructose, invert sugar, honey, molasses and syrups,
   fruit-juice concentrate, and lactose when it is added as an ingredient. Each trigger note states position
   facts that need no amounts:
   - it is the **first ingredient** (EU lists ingredients in descending order of weight, Reg 1169/2011 art. 18);
   - its declared QUID percentage;
   - "**N different sugars**" when there are several.
2. **Declared nutrition, from the new `nutrition` input.** New code **`health.high_sugar`**: severity
   `caution`, concern `hazard`, kind `fact`. It fires when total sugars exceed the UK front-of-pack "high"
   threshold: > 22.5 g/100 g for food, > 11.25 g/100 ml for drinks, or > 27 g per portion. Verify these numbers
   on gov.uk first. EU law sets only a "low sugars" threshold (≤ 5 g/100 g, ≤ 2.5 g/100 ml, Reg 1924/2006), so
   the UK numbers are the only published "high" cut-off in the region.
   - The response also gives sugars per serving and **% of the EU Reference Intake** (90 g/day, Reg 1169/2011
     Annex XIII Part B). Both are plain arithmetic on declared numbers.
   - The trigger note says these are total sugars **including naturally present ones**. Plain milk and fruit
     can therefore be "high" without any added sugar, and the `added_sugar` flag is what tells the two apart.
   - The thresholds live in a new versioned file, `kb/thresholds.yaml`, with a source for each number.

### 3d. Glycemic-load estimate

**GL = GI × available carbohydrate (g per serving) / 100.** The bands are low ≤ 10, medium 11–19 and high
≥ 20 per serving; cite Atkinson 2021 for them during curation.

1. **Split the available carbohydrate into three fractions,** using the declared nutrition values.
   - EU labels: "carbohydrate" is already *available* carbohydrate. It includes polyols and excludes fibre,
     and "sugars" excludes polyols (Reg 1169/2011 Annex I).
   - US labels: "total carbohydrate" includes fibre, so subtract fibre (`carbohydrate_definition: "total"`).
   - The fractions:
     - **sugars** = declared sugars;
     - **polyols** = declared polyols, or 0;
     - **starch and other** = carbohydrate − sugars − polyols, or the declared starch value.
2. **Give each fraction a GI range** from the ingredients that feed it. Each carbohydrate ingredient carries a
   `GI` reference value with a range and a source, plus a fraction hint: sugars, starch, polyol, or mixed
   (glucose syrup feeds two fractions).
   - Glucose (dextrose) is 100 by definition.
   - Polyols come from Livesey.
   - Starches are ingredient-specific and get **wide ranges**, because processing dominates.
   - When a fraction has several sources and **no QUID percentages**, take the min–max range across those
     sources; don't guess weights. With QUID, use the weighted mean, which is step 5 of the AUSNUT method.
3. **Compute** GL_low and GL_high as the sum over fractions of grams × GI / 100. The band is a span, for
   example `"medium–high"`, whenever the range crosses a band boundary.
4. **Coverage.** Coverage is the share of available carbohydrate that was mapped to a curated GI source. Below
   **0.7**, return `unknown` with the reason instead of a number.
5. **Known bias, stated in the response.** Weighted-sum calculations **overestimate** the measured GI of mixed
   meals: by 12–19 GI units (22–50 %) in Dodd et al., AJCN 2011, because fat, protein, fibre and acidity
   blunt the response. The estimate is reported **uncorrected**, with that note. It is never presented as a
   measured GI, which is an in-vivo ISO 26642 test.
6. **Labels on every output:** `kind: "estimate"`, `grade: "D"`, `method: "gl-weighted-range/1"`, the
   assumptions used, and the per-fraction breakdown.
7. **Flag.** New code **`health.high_glycemic_load`**: severity `notice`, concern **`sensitivity`**, kind
   `estimate`. It fires only when **GL_low ≥ 20**, meaning the whole range is high, so an uncertain range never
   raises a flag. Because it is a sensitivity, the danger ranking counts it only when the profile asks for it,
   for example a reader managing blood glucose who sends `avoid: ["health.high_glycemic_load"]`.

**Where it is good, and where it is weak.** The estimate is tight for products with a single carbohydrate
source: sports carb powders (maltodextrin, dextrose, cyclic dextrin, isomaltulose), sugars and syrups, plain
cereals. For mixed foods the range is wide, and the honest output is that wide range.

**Starting GI values to curate (about 40).** Glucose, sucrose, fructose, lactose, maltose, honey, glucose
syrup, glucose-fructose syrup, maltodextrin, cyclic dextrin, isomaltulose, trehalose, the eight polyols, and
the starches and flours: refined wheat, wholegrain wheat, rye, oats, rice, potato, maize and tapioca. Every
value is opened and cited before it is entered. The numbers in this document are not KB values.

## 4. API changes (all additive within v1)

**Request.** `AnalyzeRequest` gets an optional, strict `nutrition` block:

```json
{
  "text": "Składniki: maltodekstryna 70%, dekstroza 25%, regulator kwasowości: kwas cytrynowy, aromat, substancja słodząca: sukraloza.",
  "lang": "pl",
  "nutrition": {
    "basis": "100g",
    "carbohydrate_g": 94, "sugars_g": 28, "polyols_g": 0, "fibre_g": 0,
    "serving": { "amount": 50, "unit": "g" },
    "carbohydrate_definition": "available"
  }
}
```

**Response.** A new `nutrition` block, `null` when no nutrition was sent. The GI ranges below are
illustrative only:

```json
"nutrition": {
  "sugars": { "per_100": 28, "per_serving": 14, "band": "high", "ri_percent_per_serving": 16,
              "thresholds": "uk-fop", "kind": "fact" },
  "glycemic_load": {
    "per": "serving", "range": [42, 49], "band": "high", "coverage": 1.0,
    "kind": "estimate", "grade": "D", "method": "gl-weighted-range/1",
    "fractions": [
      { "fraction": "sugars", "grams": 14, "gi": [100, 100], "from": ["dextrose"] },
      { "fraction": "starch_other", "grams": 33, "gi": [85, 105], "from": ["maltodextrin"] }
    ],
    "assumptions": ["Not a measured GI.", "Calculated GL tends to overestimate measured GL for foods with fat or protein."],
    "sources": [{ "id": "…" }]
  }
}
```

That example label would raise `health.high_sugar`, `health.high_glycemic_load` and
`processing.non_sugar_sweetener` (from sucralose).

**Files touched**

| File | Change |
|---|---|
| `kb/implications.yaml` | 5 new codes: `processing.non_sugar_sweetener`, `health.added_sugar`, `health.high_sugar`, `health.high_glycemic_load`, `regulatory.revoked_elsewhere` (each with `concern`) |
| `kb/thresholds.yaml` (new) | sugar thresholds, GL and GI bands, EU RI, each with a source |
| `kb/ingredients/*.yaml` | the curation in §1 and §3; `GI` reference values on carbohydrate ingredients |
| `src/kb/schema.ts` | `ReferenceValue.type` adds `"GI"`, with `range` and `method` (ISO / non-ISO); a schema for the thresholds file |
| `src/kb/read.ts` | load and validate `thresholds.yaml` |
| `src/core/nutrition.ts` (new) | fractions, GL range, bands, coverage, sugar thresholds. Pure functions, called from `analyze.ts` |
| `src/core/analyze.ts` | trigger bases `nutrition` and `function_class`; position notes for `added_sugar` |
| `src/http/schemas.ts` | `nutrition` in `AnalyzeRequest` and `AnalysisResponse`; new trigger basis values |
| `docs/METHODOLOGY.md` | a new "Amounts" section, a version bump and a changelog entry. Still no product grade; amounts come only from values the caller declares |
| `docs/API.md` | document the new input and output |

**The barcode path doesn't change.** AIron's planned `analyzeFoodQuality` function (or a later Phase 2
`/v1/products/{barcode}`) maps OFF `nutriments` to the new block: `carbohydrates_100g`, `sugars_100g`,
`polyols_100g`, `fiber_100g`, `starch_100g`, `serving_quantity`. The product API v2 still returns legacy
`nutriments`. The bulk export moved to `nutrition.aggregated_set`, so any bulk ingest must merge (coalesce)
both schemas.

## 5. Tests

- **Unit tests** in `nutrition_test.ts`:
  - fraction split, with EU vs US carbohydrate;
  - GL range and bands;
  - a band span across a boundary;
  - the coverage cutoff, giving `unknown`;
  - sugar threshold edges (22.5 does not fire, 22.6 fires; drinks per 100 ml);
  - a missing serving size, which reports per 100 g with a note.
- **Golden labels:**
  - a sports carb powder (single source, tight range);
  - a PL chocolate bar with sugar as the first ingredient;
  - a diet cola (NSS × 2, no sugar flag);
  - sugar-free gum (polyols: laxative flag, low GL);
  - coloured sweets with E104/E122/E124/E129, where **all four must raise Southampton**.
- **KB tests:**
  - every `GI` value has a source with a locator;
  - all eight WHO NSS carry `processing.non_sugar_sweetener`;
  - all six Southampton colours carry `health.southampton_colour`.

## 6. Order of work (one PR each)

| # | PR | Size | Gate |
|---|---|---|---|
| 0 | Commit the danger-ranking diff and add a remote | XS | operator creates the GitHub repo |
| A | Colours: E104/E122/E124 first, then the rest, plus `regulatory.revoked_elsewhere` | S, KB only | none; it fixes a live miss |
| B | Sweeteners: the code, the 4 missing NSS, the remaining polyols, the `function_class` basis | S | none |
| C | `health.added_sugar` from the ingredient list (no amounts) | S–M | none |
| D | `nutrition` input, `high_sugar`, % RI, METHODOLOGY "Amounts" | M | decision 1, then a plan-roast |
| E | About 40 GI reference values and the GL estimate | M–L (curation is the bulk) | decisions 1 and 2 |

## 7. Decisions owed by the operator

1. **Allow amount-based flags?** METHODOLOGY says the API "doesn't judge amounts". *Recommendation: yes,
   but only from nutrition values the caller declares, with published thresholds and no product score.*
2. **GI data.** *Recommendation: cite a value per ingredient from the literature (enough for single-source
   products).* The Sydney database licence through the GI Foundation matters only later, for whole-food or
   category GI.
3. **"Dangerous" wording.** *Recommendation: keep the regulator's wording on flags.* "Ordered by danger"
   lives in the ranking and in `summary.danger`, not in the flag copy.
4. **Remote.** Create a private GitHub repo for ns-ingredients, so the code and the uncommitted diff stop
   living only on this PC.

## 8. Out of scope

- Contaminants (mycotoxins, metals, pesticide residues): they are not on labels.
- Measured GI per product.
- Estimating ADI intake: labels give no milligram amounts.
- The erythritol cardiovascular debate (Witkowski 2023), a later candidate as an `opinion` claim.
- Caramel colours E150c/E150d and 4-MEI: a later candidate; they are not petrochemical.
- The Polish beverage sugar levy.

## Sources opened or found for this scope

- glycemicindex.com, [Copyright and permission](https://glycemicindex.com/copyright-and-permission/) · [Research Data Australia record](https://researchdata.edu.au/international-glycemic-index-gi-database/11115)
- Atkinson et al. 2021, [AJCN announcement](https://nutrition.org/ajcn-publishes-international-tables-of-glycemic-index-and-glycemic-load-values-2021-a-systematic-review/)
- Louie et al., [GI assignment for AUSNUT](https://www.nutritics.com/downloads/resources/Louie_GI%20assignment_2015.pdf)
- Livesey 2003, [Nutrition Research Reviews](https://www.cambridge.org/core/journals/nutrition-research-reviews/article/health-potential-of-polyols-as-sugar-replacers-with-emphasis-on-low-glycaemic-properties/51B0744C8573925A7A74FF2AD87429F9)
- Dodd et al. 2011, [Otago archive](https://ourarchive.otago.ac.nz/esploro/outputs/journalArticle/Calculating-meal-glycemic-index-by-using/9926517695401891)
- [FDA phase-out of petroleum-based dyes](https://www.fda.gov/news-events/press-announcements/hhs-fda-phase-out-petroleum-based-synthetic-dyes-nations-food-supply) · [FDA pledge tracker](https://www.fda.gov/food/color-additives-information-consumers/tracking-food-industry-pledges-remove-petroleum-based-food-dyes)
- WHO NSS guideline 2023, [PAHO release](https://www.paho.org/en/news/15-5-2023-who-advises-not-use-non-sugar-sweeteners-weight-control-newly-released-guideline) · [NCBI Bookshelf](https://ncbi.nlm.nih.gov/books/NBK592245)
- UK front-of-pack thresholds (secondary sources only; verify on gov.uk): [Scottish Government framework](https://www.gov.scot/publications/supporting-healthy-choices-framework-voluntary-action/pages/13/) · [PMC table](https://pmc.ncbi.nlm.nih.gov/articles/PMC9094442/table/T1)
- [DataHub GI/GL dataset](https://datahub.io/daniellappv/glucose-matters-4/glycemic-index-glycemic-load-foods) · [PredictGL-NC](https://ieee-dataport.org/documents/predictgl-nc-nutritional-composition-dataset-glycemic-load-prediction-and-digital)
