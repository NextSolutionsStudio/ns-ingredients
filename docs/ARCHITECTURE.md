# Architecture

```
kb/*.yaml ──readKb (zod + cross-reference checks)──► KbBundle ──► KbIndex (in memory, per kb_version)
                                                                    │
label text ──parseLabel──► items ──match──► variants ──claims──► flags · diets · may_contain · profile
                                                                    │
                         Hono app: auth · rate limits · quota · usage · ETag · RFC 9457 · OpenAPI 3.1
                                                                    │
                                PostgreSQL: api_key, api_usage (nothing about label content or people)
```

## Decisions

**Knowledge as code.** The knowledge base is YAML in git. Pull requests are the review process, the audit
trail and the correction channel. `readKb` validates everything at boot, and the server refuses to start on
an invalid knowledge base. `kb_version` is a hash of the files' contents, so every response names the exact
knowledge it was computed from.

**Everything that decides meaning runs in memory.** Matching and search both go through `KbIndex`, so they
can't disagree about what a name means, and no text normalisation lives in SQL. The database holds only API
keys and usage counters. A few thousand names index in milliseconds.

**Deterministic core.** `src/core/` has no I/O, no clock and no randomness: the same text and `kb_version`
always give the same analysis. That is what makes the golden corpus and property tests meaningful, and it
lets analyses be cached by `kb_version`.

**Fuzzy matching is indexed.** Similarity is pg_trgm's trigram Jaccard, computed through an inverted trigram
index. It visits only names that share a trigram with the query, which keeps a 12 kB request of unknown words
at around 15 ms. A property test checks that the index returns exactly what a full scan would.

**The contract is the schema.** Request and response schemas are zod, and the OpenAPI 3.1 document is
generated from the schemas that validate requests. Every analysis in the unit tests is parsed against the
published response schema.

**Stateless about people.** Profiles live and die with a request. Logs record the route template, status,
latency and key prefix: no bodies, no query strings, no profiles.

## Layout

| Path | |
|---|---|
| `src/core/normalize.ts` | Case/diacritic folding, E-number recognition, trigrams. |
| `src/core/parse.ts` | Label → items (brackets, percentages, headers, qualifiers, statements, precautionary clause). |
| `src/core/kb-index.ts` | Name index, matching, search, facets. |
| `src/core/analyze.ts` | Variants, claims → flags, diets, profile. |
| `src/kb/` | Schema and loader for `kb/`. |
| `src/auth/`, `src/http/` | Keys (SHA-256, constant-time compare), limits, usage, logging, the Hono app. |
| `src/db/` | One `Db` interface over postgres.js and PGlite; migrations under an advisory lock. |
| `kb/` | Ingredients, implication taxonomy, function classes, sources, generated Wikidata backbone. |
| `tests/golden/` | Realistic labels with expected matches, variants, flags, diets and traces; a ratcheting gate. |

## Tests

| Suite | Proves |
|---|---|
| `tests/unit` | Parser, matcher and analyser rules, each tied to the case that motivated it. |
| `tests/property` | Nothing throws on hostile input; the response contract always holds; the trigram index equals a full scan. |
| `tests/integration` | The HTTP surface: auth, scopes, revocation, limits, quotas, validation, ETags, usage persistence, log privacy, CORS; on PGlite and PostgreSQL 17. |
| `tests/kb` | The real knowledge base validates; editorial rules (proportionate language, EU status on E-numbers, every name resolves to its own entry). |
| `tests/golden` | Precision and recall on realistic labels, gated by floors in `thresholds.json` that only move up; a CPU budget for the worst-case request. |
