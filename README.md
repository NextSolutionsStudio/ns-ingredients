# ns-ingredients

An open ingredient knowledge base and label-analysis API. It tells you **what an ingredient is, how it is
made, and what it implies**: allergens, diets, origin, processing, regulatory status and the evidence
behind each claim. Every claim carries its source.

It is built for the questions most ingredient apps can't answer:

- **Natural or synthetic?** Malic acid on a label is usually the petrochemical DL form. "L-malic acid" is the
  enzymatic or fermentation route. The API reads the label for such tells and, when the label is silent,
  says which variant is likely and why.
- **Oil derivatives in a protein powder.** MCT oil, vegetable-fat powders and E471 are flagged as
  vegetable-oil-derived, with palm origin called out when the label (or the market prior) points to it.
- **Allergens, including hidden ones.** "lecytyny (z soi)", "koncentrat białek serwatkowych (z MLEKA)" and
  precautionary "może zawierać…" clauses are read in Polish, English and German.

> **Status: v0.1, pre-release.** Every curated entry is `review_status: draft`. Most were drafted with AI
> assistance from sources that were opened and cited, and none has had specialist review yet. Responses say
> so (`ai_generated_content: true`). Informational only, not medical advice.

## What's inside

| Part | What |
|---|---|
| `kb/` | The knowledge base as YAML: about 100 curated ingredients with production variants and graded claims, a ~470-entry E-number identity backbone from Wikidata (CC0), 52 implication codes, 25 EU function classes and about 100 cited sources (live counts: `GET /v1/meta`). |
| `src/core/` | Parser (PL/EN/DE labels: nested brackets, QUID percentages, class headers, precautionary clauses), matcher (exact → variant → sub-phrase → fuzzy), analyser (flags, diets, profile). Deterministic, no network. |
| `src/http/` | The Research API: Hono + zod-openapi, OpenAPI 3.1 generated from the validating schemas, token auth, rate limits, RFC 9457 errors, ETags. |
| `tests/` | Unit, property (fast-check), integration (PGlite and PostgreSQL 17), KB editorial rules, and a golden corpus of 37 real-style labels gated on precision/recall. |

## Quick start

Requires [Deno](https://deno.com) 2.9+. With no database configured the server uses an in-process
PostgreSQL (PGlite), so nothing else is needed to try it:

```bash
deno task dev                       # http://localhost:8029/docs
```

API keys need a persistent database:

```bash
export DATABASE_URL=pglite:./.data  # or postgresql://user:pw@host:5432/db
deno task keys create --label local --scopes "kb:read analyze"
```

```bash
curl -s localhost:8029/v1/analyze -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"text":"Składniki: koncentrat białek serwatkowych (z MLEKA), kwas jabłkowy, emulgator: lecytyna sojowa","lang":"pl"}'
```

## API at a glance

| Endpoint | Auth | |
|---|---|---|
| `GET /v1/ingredients?q=` | `kb:read` | Search by name (PL/EN/DE), E-number or keyword; filter by implication, origin, function. |
| `GET /v1/ingredients/{id}` | `kb:read` | Full entry: variants, production process, residues, graded claims, regulatory status, sources. |
| `GET /v1/implications` | `kb:read` | The standardised implication taxonomy. |
| `GET /v1/sources/{id}` | `kb:read` | A cited source. |
| `POST /v1/analyze` | `analyze` | Analyse an ingredient list, optionally against a per-request profile (never stored). |
| `GET /v1/meta`, `/v1/openapi.json`, `/docs` | public | Versions, counts, licences; the OpenAPI document; interactive reference. |

Details: [docs/API.md](docs/API.md). How claims are graded and flags computed: [docs/METHODOLOGY.md](docs/METHODOLOGY.md).

## Development

```bash
deno task test            # everything; integration tests use PGlite unless TEST_DATABASE_URL is set
deno task test:golden     # golden-corpus report: metrics, ratchet hints, every open problem
deno task kb:validate     # schema, cross-references, tells, name collisions
deno task bench           # analysis and search latency on the real KB
deno task openapi         # print the OpenAPI document
deno task explorer        # local UI on http://127.0.0.1:8030: look up an EAN or product name on Open Food Facts,
                          # search the KB, paste a label; runs the API in-process with a throwaway key
```

Contributing to the knowledge base: [docs/CONTRIBUTING-KB.md](docs/CONTRIBUTING-KB.md). Architecture:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Running it: [docs/DEPLOY.md](docs/DEPLOY.md).

If you are a manufacturer or an expert and think an entry is wrong, open a
[correction request](.github/ISSUE_TEMPLATE/correction-request.yml). Corrections are reviewed on the evidence.

## Licences

- Code: [Apache-2.0](LICENSE).
- Curated knowledge base (`kb/` except `kb/generated/`): [CC BY 4.0](kb/LICENSE). Attribute "NextSolutions ns-ingredients".
- `kb/generated/`: identity data derived from [Wikidata](https://www.wikidata.org) (CC0).
- Cited sources keep their own licences; the KB links to them and does not reproduce them.
