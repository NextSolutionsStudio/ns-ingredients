# Research API v1

Base URL: `https://ingredients.nextsolutions.studio`. The interactive reference is at `/docs`, and the
machine-readable contract is at `/v1/openapi.json` (OpenAPI 3.1, generated from the schemas that validate
requests).

## Authentication

Send a key as a bearer token:

```
Authorization: Bearer nsi_XXXXXXXX_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

Keys have **scopes**: `kb:read` for the knowledge-base routes, `analyze` for `POST /v1/analyze`. The server
stores only a SHA-256 hash of each key; the key itself is shown once, when it is created. A revoked key stops
working within 60 seconds.

Public, no key needed: `/health`, `/ready`, `/v1/meta`, `/v1/openapi.json`, `/docs`, `/problems/{type}`.

## Limits

Each key has a per-minute rate (token bucket, default 60) and a daily quota (default 10,000 requests; resets
at 00:00 UTC). Every keyed response carries `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`
for whichever limit is closer. A `429` also carries `Retry-After` in seconds.

`POST /v1/analyze` accepts JSON only (`415` otherwise), with a body of at most 16 kB (`413`) and text of at
most 12,000 characters.

## Errors

Errors are `application/problem+json` ([RFC 9457](https://www.rfc-editor.org/rfc/rfc9457)):

```json
{ "type": "https://ingredients.nextsolutions.studio/problems/rate-limited", "title": "Too many requests",
  "status": 429, "instance": "7f7c…" }
```

`instance` is the request id, also returned as `X-Request-Id`. Send your own `X-Request-Id` to correlate
logs.

| `type` | Status | Meaning |
|---|---|---|
| `invalid-request` | 400 | Malformed JSON, a parameter out of range, an unknown field, or an invalid cursor. `errors` lists the fields. |
| `unauthorized` | 401 | Missing, malformed, unknown or revoked key. |
| `forbidden` | 403 | The key lacks the scope this route needs. |
| `not-found` | 404 | No such ingredient, source or route. |
| `payload-too-large` | 413 | Body over 16 kB. |
| `unsupported-media-type` | 415 | `POST /v1/analyze` without `Content-Type: application/json`. |
| `rate-limited` | 429 | Per-minute rate exceeded. Wait `Retry-After` seconds. |
| `quota-exceeded` | 429 | Daily quota exceeded. |
| `internal` | 500 | A bug. The response never contains a stack trace; quote `instance` when reporting it. |
| `not-ready` | 503 | `/ready` only: the database is unreachable. |

## Language

Text fields are localised to `pl`, `en` or `de`. Pass `?lang=` (or `"lang"` in the analyze body), or send
`Accept-Language`; the default is English. Label parsing works in all three languages whatever the output
language.

## Caching

Knowledge-base responses carry `ETag`, `X-KB-Version` and `Cache-Control: private, max-age=300`. Send
`If-None-Match` to get `304 Not Modified`. ETags change whenever the knowledge base changes.

## Endpoints

### `GET /v1/ingredients` (`kb:read`)

Search and filter.

| Parameter | |
|---|---|
| `q` | Name in any language, an E-number in any form (`E296`, `e 296`, `E-296`), or keywords from summaries and production processes. Typos are tolerated. |
| `implication` | Comma-separated codes; results must assert every one (`yes` or `maybe`). `implication=origin.petrochemical_synthetic` lists petrochemical ingredients. |
| `origin` | Shorthand: `origin=petrochemical_synthetic` is the same as `implication=origin.petrochemical_synthetic`. |
| `function` | An additive function class id: `emulsifier`, `sweetener`, `colour`… |
| `type`, `review_status` | Filter by entry type or review status. |
| `limit`, `cursor` | Page size (1–50, default 20) and the `next_cursor` from the previous page. |

Curated entries rank above identity-only ones.

### `GET /v1/ingredients/{id}` (`kb:read`)

`{id}` is an ingredient id (`malic-acid`) or an E-number (`E296`). Returns names, summary, functions,
**variants** (process, residues, priors with their rationale), **assertions** (code, certainty, kind, grade,
population, note, sources), regulatory status, reference values, review status and the sources it cites.

### `GET /v1/implications` (`kb:read`)

The taxonomy: code, group, severity, default kind, label and definition.

### `GET /v1/sources/{id}` (`kb:read`)

Title, publisher, year, URL and licence of a cited source.

### `POST /v1/analyze` (`analyze`)

```json
{
  "text": "Składniki: koncentrat białek serwatkowych (z MLEKA) 80%, kwas jabłkowy, emulgator: lecytyna sojowa. Może zawierać JAJA.",
  "lang": "pl",
  "profile": { "avoid": ["allergen.*", "origin.petrochemical_synthetic"], "diets": ["vegan"] },
  "nutrition": { "basis": "100g", "sugars_g": 28, "serving": { "amount": 30, "unit": "g" } }
}
```

`nutrition` is optional: total sugars as declared, per `100g` or `100ml` (drinks), and an optional serving whose
unit matches the basis. Add `carbohydrate_g` (and `polyols_g`, or `fibre_g` with
`"carbohydrate_definition": "total"` for US-style labels) for the glycemic-load estimate.

**Field selection.** `?fields=summary,flags.code,ranking.reasons.label` returns only those dot paths (arrays are
implicit; a parent path returns the whole subtree). An unknown path is a 400 whose `valid_fields` lists every
path. Also on `GET /v1/ingredients/{id}`.

The response:

- **`items`**: the parsed list as a tree. For each item: `match` (ingredient, match type, confidence), `variant`
  (read from the label, or a prior distribution), `function` (additive class), `percent`, and children.
- **`flags`**: one per implication code, with severity, certainty, kind, grade and the **triggers** that
  raised it. Each trigger gives the item path, ingredient, variant, basis (`ingredient`, `label_variant`,
  `prior_variant`, `qualifier`, `emphasis`, `nutrition`), note and sources. A `nutrition` trigger has the path
  `nutrition.sugars_g` and no ingredient. `allergen.unrecognised_emphasis` (basis `emphasis`) marks a capitalised
  item the knowledge base does not recognise; its trigger has no ingredient when the item is unmatched.
- **`nutrition`**: `null` unless nutrition was sent. Sugars per 100 and per serving, the band (`low`/`medium`/
  `high`, UK front-of-pack criteria), `band_by`, and the percentage of the 90 g reference intake; with
  carbohydrate declared, `glycemic_load`: status, range, band per serving, coverage, the per-fraction GI ranges
  and their ingredients, assumptions and sources. Always an estimate.
- **`diets`**: vegan, vegetarian, gluten-free and lactose-free, each `yes`/`no`/`maybe`/`unknown`, with the
  items responsible.
- **`may_contain`**: the precautionary statement, resolved to allergens.
- **`label_statements`**: mandatory statements found (`phenylalanine`, `laxative`, `southampton`,
  `sweeteners`, `caffeine_high`).
- **`coverage`**: how many items matched, and how many only with low confidence. **`unanalysed_text`**: what
  followed the ingredient list.
- **`profile`**: present when a profile was sent. It lists the avoided codes that were hit (traces marked) and
  the requested diets.
- **`sources`**, **`disclaimer`**, **`ai_generated_content`**, **`kb_version`**.

How flags and diets are derived: [METHODOLOGY.md](METHODOLOGY.md). The profile is used for this response only
and is never stored or logged.

### `GET /v1/meta` (public)

Service and knowledge-base versions, methodology version, counts, licences and required attribution.

## Versioning

Breaking changes get a new path prefix (`/v2`). Within `v1`, fields and implication codes are only added.
Clients should ignore unknown fields and treat unknown implication codes by their `group` and `severity`.
