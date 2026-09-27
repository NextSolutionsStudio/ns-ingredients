# Methodology

**Version 2026-09-27.** `GET /v1/meta` returns `methodology_version`; every analysis is produced under the
version it names. Changes are listed at the end of this document.

This document explains what the API asserts and how it gets from an ingredient list to a flag. It is a
contract: if the API does something this document doesn't describe, that is a bug.

## What the API does and doesn't do

It **describes ingredients**: what they are, how they are made, and what follows from that (allergens, diets,
origin, processing, regulatory status, published health assessments), with the evidence for each statement.

It does **not**:

- **Score or rank products.** There is no healthiness grade and no traffic light, and no single number can
  combine an allergen fact with a contested animal study.
- **Judge amounts.** An ingredient list rarely states quantities, and a hazard is not a risk without exposure.
  Where a published assessment sets an intake level (ADI, UL), the API cites it; it doesn't estimate your
  intake.
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

## Diets

Four diets are evaluated: vegan, vegetarian, gluten-free and lactose-free. Each is `yes`, `no`, `maybe` or
`unknown`, and the response lists which items made it so.

For each item:

1. An **explicit** `diet.*` claim decides. A claim scoped to a variant the label names overrides the
   ingredient-wide one, so "E471 pochodzenia roślinnego" is vegan even though bare E471 is `maybe`. A claim
   from a silent label's top prior can only raise doubt: a `no` becomes `maybe`.
2. Vegan `yes` implies vegetarian `yes`; vegetarian `no` implies vegan `no`.
3. Otherwise the status is **derived**:
   - **Vegan:** animal, dairy, egg, fish or insect origin, or an animal allergen (milk, eggs, fish,
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

- **2026-09-27**: first published version.
