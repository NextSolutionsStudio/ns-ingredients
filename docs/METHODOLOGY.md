# Methodology

**Version 2026-10-26.** `GET /v1/meta` returns `methodology_version`; every analysis is produced under the
version it names. Changes are listed at the end of this document.

This document explains what the API asserts and how it gets from an ingredient list to a flag. It is a
contract: if the API does something this document doesn't describe, that is a bug.

## What the API does and doesn't do

It **describes ingredients**: what they are, how they are made, and what follows from that (allergens, diets,
origin, processing, regulatory status, published health assessments), with the evidence for each statement.

It does **not**:

- **Score or rank products.** There is no healthiness grade and no overall traffic light, and no single
  number can combine an allergen fact with a contested animal study.
- **Guess amounts.** An ingredient list rarely states quantities, and a hazard is not a risk without exposure.
  Amounts come only from nutrition the caller declares (see [Amounts](#amounts)). Where a published
  assessment sets an intake level (ADI, UL), the API cites it; it doesn't estimate your intake.
- **Detect cross-contamination**, beyond what the label's own precautionary statement says.
- **Give medical advice.** "Contains X, which [source] flags for Y" is information. It is never "safe for your
  condition".

## Claims

Every statement in the knowledge base is a **claim** made of:

| Field | Meaning |
|---|---|
| `code` | What is claimed, from a fixed taxonomy (`GET /v1/implications`): `allergen.milk`, `origin.petrochemical_synthetic`, `health.laxative_polyol`… Codes are stable identifiers: they are added, never renamed or reused. |
| `certainty` | `yes`, `no`, `maybe`, `unknown`. `maybe` means plausible but undisclosed (E471 *may* be animal-derived). `unknown` means nobody can tell from the information available. |
| `kind` | `fact`: a regulation, an official specification, or what the label itself declares. `estimate`: an inference, such as the likely source crop or the variant when the label is silent. `opinion`: contested or weak evidence. |
| `grade` | Strength of the cited evidence: **A** regulatory determination · **B** systematic review or meta-analysis · **C** trials or consistent observational evidence · **D** mechanistic, animal, case reports, expert opinion. |
| `population` | Who it concerns, when not everyone: children, pregnancy, coeliac, PKU, athletes, infants. |
| `sources` | One or more cited sources, each with a locator where possible (article, annex, page). Only sources that were actually opened are cited. |
| `variant` | Set when the claim holds for one production route only (below). |

A contested study never appears as a fact. When a regulator and an animal study disagree, both are shown with
their own kind and grade, and the regulator's conclusion is stated first.

## Severity

Each implication code carries a severity, which controls how prominently a client should show it. It is not a
verdict on the ingredient.

| Severity | Used for |
|---|---|
| `warning` | The 14 EU allergens; not authorised as a food additive in the EU. |
| `caution` | Southampton colours; phenylalanine source; IARC group 2B; no safe level established by a regulator; nitrosamine precursors; trans fats and partially hydrogenated fats. |
| `notice` | Origin and processing facts people often ask about (petrochemical synthesis, vegetable-oil-derived, insect, GMO-derived, interesterified, ultra-processing markers); palm oil; polyol laxative effect; caffeine and stimulants; high-dose supplement nutrients; EU restrictions and mandatory warning labels. |
| `info` | Plant, animal, dairy, egg, fish or mineral origin; fermentation; chemical synthesis; refining; contested evidence (e.g. the emulsifier inflammation debate); reported sensitivities; novel food status; batch-quality variability. |

The full mapping is in `kb/implications.yaml`, which is the source of truth.

## Production variants

Many ingredients can be made in more than one way, and the route can matter to a buyer even when regulators
see no safety difference. Malic acid is the example: DL-malic acid is synthesised from petrochemical maleic
anhydride; L-malic acid is made enzymatically or by fermentation. JECFA and EFSA treat both as safe.

Each variant has:

- a **process** description, with the **residues** its specification limits (for DL-malic acid, fumaric and
  maleic acid);
- **tells**: patterns that identify the variant on a label ("DL-", "kwas L-jabłkowy", "z soi", "from lichen");
- optionally a **prior**: the estimated share of the market when the label says nothing, with a written
  rationale. Priors are estimates, and they say so.

How the variant is decided for one label item:

1. **The label names it.** Either the item's name is a variant name, or a tell fires on the item including its
   brackets. That variant's claims apply at their full certainty (`basis: "label_variant"`).
2. **The label names several.** "Tłuszcz roślinny w proszku (olej palmowy, olej kokosowy)" is a blend, so every
   named variant's claims apply.
3. **The label is silent.** The priors are reported as a distribution. Only the most likely variant can raise
   flags, and only when its prior is at least **0.5**. Its claims are downgraded: `yes` becomes `maybe`, `fact`
   becomes `estimate`, and the probability and rationale are attached (`basis: "prior_variant"`).

## From a label to flags

1. **Parse.** Select the ingredient block in the requested language, then split it into items, respecting
   nested brackets, decimal commas and QUID percentages. Read class headers ("emulgator:", "Säuerungsmittel:")
   and their scope, qualifiers ("z soi", "from milk"), capitalised allergen emphasis, the precautionary clause,
   mandatory statements, and trailing text such as storage advice or "cocoa solids 30% minimum".
2. **Match.** Each item is resolved to one knowledge-base entry:
   - an exact name (any language, after normalisation) or E-number;
   - the longest known sub-phrase;
   - a fuzzy match for typos and OCR slips.

   Fuzzy matching has two guards. A compound item with its own ingredient list is never fuzzy-matched by its
   header. Two names that share only a generic word ("sodu", "acid", "extract") must also be similar in what
   remains. A bracketed part that only makes sense with its parent's noun is read with it: "Vegetable oils
   (palm, rapeseed)" means palm oil and rapeseed oil. A bracketed word that names the parent's source is a
   qualifier, not a new ingredient: in "lecytyny (słonecznik)", sunflower is the lecithin's source.
3. **Flag.** For each matched item, every claim that applies (ingredient-wide, or for the decided variant)
   with certainty `yes` or `maybe` becomes a trigger. Allergens named in qualifiers and capitalised emphasis
   add their allergen claims (`basis: "qualifier"` / `"emphasis"`). Triggers are grouped by code into flags; a
   flag's certainty, kind and grade are the strongest among its triggers. Diet codes never become flags;
   they feed the diet verdicts below.
4. **Traces.** Allergens in a precautionary statement ("może zawierać…", "may contain…", "kann Spuren von…
   enthalten") are reported under `may_contain`. They never raise flags. A profile that avoids that allergen
   gets a hit marked `trace: true`.

5. **Added sugars.** Each `health.added_sugar` trigger (a free sugar in WHO's sense, added as an
   ingredient) also states what the list itself proves about amount, and nothing more: that it is the first
   ingredient (EU lists run in descending order of weight, Reg 1169/2011 art. 18; ingredients under 2% may
   close the list in any order), its place in the list, its declared percentage, and how many different added
   sugars the label uses. Only top-level items get a place or percentage; a nested percentage is a share of
   its compound.

## Amounts

Amounts are never inferred from the ingredient list. A request may carry `nutrition`: total sugars as
declared on the label, per 100 g (food) or per 100 ml (drinks), and optionally a serving. The response's
`nutrition` block is plain arithmetic on those numbers:

- **Band**: low, medium or high by the UK front-of-pack criteria (DHSC 2016). Food: low at 5.0 g/100 g or
  less, high above 22.5 g/100 g. Drinks: low at 2.5 g/100 ml or less, high above 11.25 g/100 ml. A portion
  over 100 g (food) or 150 ml (drinks) is also high above 27 g or 13.5 g per portion. EU law defines only
  "low sugars", so the UK tables are the published "high" criterion used.
- **Reference intake**: the percentage of the adult reference intake for sugars, 90 g (Reg 1169/2011 Annex
  XIII Part B), per 100 and per serving.
- **High** raises `health.high_sugar` (caution, hazard, fact) with `basis: "nutrition"` and no
  ingredient; it is not a label item, so it never ranks, but it does set `summary.danger`.

Total sugars include those naturally in milk and fruit, so plain milk or juice can be "high" with nothing
added; `health.added_sugar` is what tells the two apart. The analysis does not check that the declared
numbers belong to the declared list.

### Glycemic load (an estimate, never a measured GI)

When `carbohydrate_g` is declared, `nutrition.glycemic_load` estimates GL = GI × available carbohydrate / 100
(method `gl-weighted-range/1`, `kind: estimate`, grade D):

1. **Fractions.** Available carbohydrate splits into sugars (declared), polyols (declared, else 0) and starch
   and other carbohydrate (the rest). EU labels declare available carbohydrate; a label whose carbohydrate
   includes fibre (`carbohydrate_definition: "total"`) needs `fibre_g`, or the estimate is `unknown`.
2. **GI per fraction.** Each fraction takes the full range (lowest to highest) of the curated GI values of the
   label ingredients that feed it. Each value cites its own study. No weights are guessed: a declared
   percentage does not narrow the range yet.
3. **Coverage.** The share of available carbohydrate whose fraction has a GI source. A fraction without one
   counts as GI 0–100, which widens the range rather than guessing. Below 70% coverage the estimate is
   `unknown`.
4. **Bands**, per serving only: low at 10 or less, high at 20 or more. Without a serving the range is per 100
   and has no band. Bands, the coverage gate and the flag use unrounded values; the published range is
   rounded outward to 0.1 and coverage down to 0.01, so a shown number never crosses a threshold the real one
   did not.
5. **Known bias.** Calculated GI overestimates measured GI: by 22–50% for mixed meals (Dodd et al. 2011).
   The estimate is reported uncorrected, with that assumption stated in the response.
6. **Flag.** `health.high_glycemic_load` (notice, sensitivity, estimate) only when the low end of the range
   is 20 or more per serving. As a sensitivity it ranks and sets `summary.danger` only when the profile asks
   for it.

## Diets

Four diets are evaluated: vegan, vegetarian, gluten-free and lactose-free. Each is `yes`, `no`, `maybe` or
`unknown`, and the response lists which items made it so.

For each item:

1. An **explicit** `diet.*` claim decides. A claim scoped to a variant the label names overrides the
   ingredient-wide one, so "E471 pochodzenia roślinnego" is vegan even though bare E471 is `maybe`. A claim
   from a silent label's top prior can only raise doubt: a `no` becomes `maybe`.
2. Vegan `yes` implies vegetarian `yes`; vegetarian `no` implies vegan `no`.
3. Otherwise the status is **derived**:
   - **Vegan:** animal, dairy, egg, bee-product, fish or insect origin, or an animal allergen (milk, eggs, fish,
     crustaceans, molluscs), makes it `no` (`maybe` if that claim is `maybe`).
   - **Vegetarian:** animal, fish or insect origin, or a fish, crustacean or mollusc allergen, makes it `no`.
   - With no such signal, an entry that states any origin is `yes` for both; one that doesn't is `unknown`.
   - **Gluten-free / lactose-free:** the gluten or milk allergen makes it `no` (`maybe` if the allergen claim
     is `maybe`); without it, `yes`. Modified starches from the identity backbone are `unknown` for gluten,
     since they can be wheat-based.
4. An item that matched nothing is `unknown` for every diet.

The product's status is the worst item status, ordered `no` > `maybe` > `unknown` > `yes`.

## Profiles

A request may carry a profile: implication codes or group wildcards to avoid (`allergen.*`), and diets to
check. It is evaluated for that request only. It is never stored, logged or used for anything else.

## Review status and AI-assisted content

Entries carry `review_status` (`draft`, `reviewed`, `imported`) and `provenance` (`human`, `ai-drafted`,
`wikidata`). Draft entries may have been drafted with AI assistance from sources that were opened and cited.
They stay `draft` until a named human reviewer signs off. Any analysis that relied on an AI-drafted entry says
so with `ai_generated_content: true`.

## Corrections

Anyone, manufacturers included, can request a correction with evidence through the repository's
correction-request form. Corrections are assessed on the cited evidence, and accepted changes appear in the
knowledge-base history with the new `kb_version`.

## Changelog

- **2026-10-26**: `nutrition` input and the [Amounts](#amounts) section (sugar bands, reference intake,
  `health.high_sugar`, the glycemic-load estimate and `health.high_glycemic_load`); position facts on added
  sugars; `origin.bee_product` (honey: not vegan, vegetarian); codes `processing.non_sugar_sweetener`,
  `health.added_sugar`, `health.high_sugar` and `regulatory.revoked_elsewhere`.
- **2026-09-27**: first published version.
