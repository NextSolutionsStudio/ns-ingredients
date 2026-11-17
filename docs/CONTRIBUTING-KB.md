# Contributing to the ingredient knowledge base

The knowledge base (KB) is YAML in `kb/`, licensed **CC BY-SA 4.0**. Every change is a pull request,
every claim carries a source, and CI runs `deno task kb:validate` on it. This page is the whole
rulebook — for people and for AI drafting assistants alike.

## Files

| Path | What |
|---|---|
| `kb/ingredients/<id>.yaml` | one curated ingredient; the file name must equal `id` |
| `kb/implications.yaml` | the controlled vocabulary of implication codes (read it before writing assertions) |
| `kb/classes.yaml` | additive function classes ("emulgator:", "Säureregulator:") |
| `kb/sources.yaml`, `kb/sources/<batch>.yaml` | citations; add new ones in a batch file |
| `kb/generated/*.yaml` | machine-imported identity data (Wikidata, CC0). **Never edit by hand**; a curated file with the same E-number replaces the generated entry |
| `src/kb/schema.ts` | the exact schema (zod) |

`kb/ingredients/malic-acid.yaml` is the reference example.

## The rules

1. **Every assertion cites at least one source you have actually opened.** Regulations by their
   EUR-Lex ELI URL (`https://eur-lex.europa.eu/eli/reg/2008/1333/oj`), EFSA opinions by DOI, studies by
   DOI or PubMed ID. Never cite from memory: a wrong DOI is worse than no claim. If you cannot find a
   source, leave the claim out and write it in `review_notes`.
2. **Write in your own words.** We cite facts; we do not copy text. JECFA (CC BY-NC-SA) and EFSA Journal
   (CC BY-ND) texts must not be adapted into the KB.
3. **Say what kind of claim it is.**
   - `kind: fact` — a regulation, an official specification, or what the label itself declares. Grade `A`.
   - `kind: estimate` — an inference (typical source crop, the variant when a label is silent). Grade `B`–`D`.
   - `kind: opinion` — contested or weak evidence (mechanistic, animal, case reports). Grade `C`–`D`.
   - Grades: `A` regulatory determination · `B` systematic review / meta-analysis · `C` RCT or consistent
     observational evidence · `D` mechanistic, animal, case report, expert opinion.
4. **Certainty is four-state**: `yes`, `no`, `maybe`, `unknown`. Use `maybe` when a route is plausible but
   undisclosed (E471 may be animal-derived → `diet.vegan: maybe`).
5. **Be proportionate.** Never call an ingredient "dangerous", "toxic" or "harmful". State the hazard, the
   dose context and who it concerns: "EFSA could not establish a safe intake level (2021)", "laxative above
   ~X g", "relevant to people with phenylketonuria". Say when regulators found **no** difference (as with L-
   vs DL-malic acid). The disparagement case law this project designs against rewards evidence and
   proportionality.
6. **Origin is not safety.** `origin.petrochemical_synthetic` describes a production route; the molecule may
   be identical to the natural one. Say so in the note when it is.
7. **Two "oil" axes, never merged:** `origin.vegetable_oil_derived` (oil powders, MCT, palm fractions, plant
   mono- and diglycerides) vs `origin.petrochemical_synthetic` (DL-malic acid, synthetic vanillin, BHA/BHT…).
8. **Informational, never clinical.** "Contains a source of phenylalanine" — never "unsafe for PKU patients"
   or "safe in pregnancy".
9. **Polish first.** Curated entries need `names.pl` and `summary.pl`. Use the terms that appear on real Polish
   labels, including plural and inflected forms where labels use them ("lecytyny", "mono- i diglicerydy
   kwasów tłuszczowych"). German names where you know the label term.
10. **Names are unique.** One normalised name belongs to one ingredient. The validator fails on a clash;
    fix your own file, never someone else's.

## Variants and label tells

A **variant** is a production route or source that matters (L- vs DL-malic acid; soy vs sunflower lecithin;
lanolin vs lichen vitamin D3). Give each variant:

- `process` — how it is made, in plain words.
- `residues` — by-products or impurities with the specification that limits them, when known.
- `tells` — regular expressions that recognise the variant **on a label**. They run against the
  *normalised* text: lowercase, no diacritics (ł→l, ä→a, ß→ss, α→alpha), punctuation replaced by single
  spaces. So "kwas L-jabłkowy" is matched as `kwas l jablkowy`, "lecytyna (z soi)" as `lecytyna z soi`.
  Every variant name must be matched by one of its tells (the validator checks this).
- `prior` + `prior_rationale` — the probability of this variant **when the label does not say**, and why.
  Priors of one ingredient sum to at most 1. Silence is informative: makers advertise the premium variant
  (L-form, lichen D3, sunflower lecithin) and stay quiet about the commodity one.

Assertions can target one variant with `variant: <id>`.

## Claim names (`exact_names`)

A label claim such as "bez utwardzonych tłuszczów" or "free from hydrogenated oil" may be an entry's name, so a
standalone claim item or a bracket child "(bez utwardzonych tłuszczów)" resolves to it. List such names under
`exact_names` (same language keys as `names`), not `names`. An exact name resolves only a whole item, exactly or by
fuzzy match. Inside a longer item it is a claim: the matcher reads no sub-phrase that starts inside it, so neither the
claim, nor a word of it ("bez" as elder), nor a name it denies outranks the food ("olej sezamowy bez utwardzonych
tłuszczów" stays sesame oil; "bez utwardzonych tłuszczów olej rzepakowy" is rapeseed oil). Only a name that opens the
item and runs past the claim is read ("nie uwodorniony olej sojowy rafinowany"). Exact names are never search hits,
and the validator rejects one that is any other name, of its own entry or another.

## Checklist before opening a PR

```bash
deno task kb:validate      # must print no ERROR lines
deno task test             # parser/matcher tests use the KB too
```

Set `review_status: draft` and `provenance: ai-drafted` (or `human`). Only a named reviewer changes an entry
to `review_status: reviewed`. Brands disputing an entry: open an issue with the "correction request" template;
corrections follow the same sourcing rules.
