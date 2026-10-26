// HTTP layer: routing, auth, limits, validation, serialisation. Built by a factory with no
// side effects so tests can run the whole API in-process against PGlite.
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import type { Config } from "../config.ts";
import { METHODOLOGY_VERSION, SERVICE_VERSION } from "../config.ts";
import type { ApiKey, KeyStore, Scope } from "../auth/keys.ts";
import type { Db } from "../db/client.ts";
import { analyze } from "../core/analyze.ts";
import type { KbIndex } from "../core/kb-index.ts";
import type { IngredientT, Lang, TextT } from "../kb/schema.ts";
import type { DailyQuota, LimitDecision, RateLimiter } from "./limits.ts";
import type { Logger } from "./log.ts";
import type { UsageRecorder } from "./usage.ts";
import * as S from "./schemas.ts";

export interface AppDeps {
  index: () => KbIndex;
  /** Absent at the edge (Cloudflare Worker), which has no database: /ready then reports the KB only. */
  db?: Pick<Db, "query">;
  keys: Pick<KeyStore, "verify">;
  limiter: Pick<RateLimiter, "take">;
  quota: Pick<DailyQuota, "take">;
  usage: Pick<UsageRecorder, "record">;
  log: Logger;
  config: Pick<Config, "CORS_ORIGINS" | "PUBLIC_BASE_URL">;
  /** Keyless access (the public demo). Without it, every keyed route needs a bearer key. */
  anonymous?: AnonymousAccess;
}

export interface AnonymousAccess {
  scopes: readonly Scope[];
  /** Decides one keyless request. `client` is the caller's IP address as the edge reports it. */
  take(client: string, scope: Scope): Promise<LimitDecision>;
  /** Requests a minute per IP address, by bucket, as /v1/meta reports them. */
  perMinute?: Readonly<Record<string, number>>;
}

type Env = { Variables: { reqId: string; key?: ApiKey } };
type C = Context<Env>;

const PROBLEM_BASE = "https://ingredients.nextsolutions.studio/problems/";
export const ANALYZE_MAX_BYTES = 16 * 1024;

/**
 * RFC 9457 problem response. Typed `any` on purpose: every route declares its problem responses in
 * the OpenAPI spec, but Hono's typed-response unions cannot express a non-JSON body type.
 */
// deno-lint-ignore no-explicit-any
/** Every problem type this API emits, served at its type URI. docs/API.md mirrors this table. */
export const PROBLEM_TYPES: Record<string, { title: string; status: number; description: string }> = {
  "invalid-request": {
    title: "Invalid request",
    status: 400,
    description:
      "Malformed JSON, a parameter out of range, an unknown field or an invalid cursor; `errors` lists the fields.",
  },
  "unauthorized": {
    title: "Unauthorized",
    status: 401,
    description: "The bearer key is missing, malformed, unknown or revoked.",
  },
  "forbidden": {
    title: "Forbidden",
    status: 403,
    description: "The key does not have the scope this route requires.",
  },
  "not-found": { title: "Not found", status: 404, description: "No such ingredient, source or route." },
  "payload-too-large": {
    title: "Body too large",
    status: 413,
    description: "The request body exceeds 16 kB.",
  },
  "unsupported-media-type": {
    title: "Unsupported media type",
    status: 415,
    description: "POST /v1/analyze requires Content-Type: application/json.",
  },
  "rate-limited": {
    title: "Too many requests",
    status: 429,
    description: "The key's per-minute rate is exhausted; retry after Retry-After seconds.",
  },
  "quota-exceeded": {
    title: "Daily quota exceeded",
    status: 429,
    description: "The key's daily quota is exhausted; it resets at 00:00 UTC.",
  },
  "internal": {
    title: "Internal error",
    status: 500,
    description: "An unexpected failure. Quote the instance (request id) when reporting it.",
  },
  "not-ready": {
    title: "Not ready",
    status: 503,
    description: "The database is unreachable; the service cannot serve keyed routes.",
  },
};

export function problem(
  c: C,
  status: number,
  slug: string,
  title: string,
  detail?: string,
  extra: Record<string, unknown> = {},
): any {
  return c.body(
    JSON.stringify({
      type: PROBLEM_BASE + slug,
      title,
      status,
      ...(detail ? { detail } : {}),
      instance: c.get("reqId"),
      ...extra,
    }),
    status as 400,
    { "content-type": "application/problem+json" },
  );
}

function langOf(c: C, q?: string): Lang {
  if (q === "en" || q === "pl" || q === "de") return q;
  const accept = c.req.header("accept-language")?.toLowerCase() ?? "";
  for (const part of accept.split(",")) {
    const tag = part.trim().slice(0, 2);
    if (tag === "pl" || tag === "de" || tag === "en") return tag;
  }
  return "en";
}

const t = (text: TextT | undefined, lang: Lang) => (text ? text[lang] ?? text.en : null);

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function presentIngredient(
  index: KbIndex,
  ing: IngredientT,
  lang: Lang,
): z.infer<typeof S.Ingredient> {
  const cited = new Set<string>();
  const assertions = (ing.assertions ?? []).map((a) => {
    const impl = index.implications.get(a.code)!;
    a.sources.forEach((s) => cited.add(s.id));
    return {
      code: a.code,
      label: t(impl.label, lang)!,
      group: impl.group,
      severity: impl.severity,
      ...(a.variant ? { variant: a.variant } : {}),
      certainty: a.certainty,
      kind: a.kind,
      grade: a.grade,
      ...(a.population ? { population: a.population } : {}),
      ...(a.jurisdiction ? { jurisdiction: a.jurisdiction } : {}),
      ...(a.dose ? { dose: a.dose } : {}),
      note: t(a.note, lang)!,
      sources: a.sources,
    };
  });
  const variants = (ing.variants ?? []).map((v) => {
    v.residues?.forEach((r) => cited.add(r.source));
    return {
      id: v.id,
      name: v.names?.[lang]?.[0] ?? v.names?.en[0] ?? null,
      process: t(v.process, lang)!,
      residues: (v.residues ?? []).map((r) => ({
        substance: t(r.substance, lang)!,
        ...(r.limit ? { limit: r.limit } : {}),
        source: r.source,
      })),
      prior: v.prior ?? null,
      prior_rationale: t(v.prior_rationale, lang),
    };
  });
  (ing.regulatory ?? []).forEach((r) => cited.add(r.source));
  (ing.reference_values ?? []).forEach((r) => cited.add(r.source));
  const sources: Record<string, z.infer<typeof S.SourceSummary>> = {};
  for (const id of [...cited].sort()) {
    const s = index.sources.get(id);
    if (s) {
      sources[id] = {
        title: s.title,
        url: s.url,
        ...(s.year ? { year: s.year } : {}),
        ...(s.publisher ? { publisher: s.publisher } : {}),
      };
    }
  }
  return {
    id: ing.id,
    type: ing.type,
    name: index.displayName(ing, lang),
    ...(ing.e_number ? { e_number: ing.e_number } : {}),
    ...(ing.ids ? { ids: ing.ids as Record<string, string | number> } : {}),
    names: ing.names as Record<string, string[]>,
    functions: (ing.functions ?? []).map((f) => {
      const cls = index.classes.get(f);
      return { id: f, name: cls?.names[lang]?.[0] ?? cls?.names.en[0] ?? f };
    }),
    summary: t(ing.summary, lang),
    variants,
    assertions,
    regulatory: (ing.regulatory ?? []).map((r) => ({
      jurisdiction: r.jurisdiction,
      status: r.status,
      ...(r.conditions ? { conditions: t(r.conditions, lang)! } : {}),
      ...(r.since ? { since: r.since } : {}),
      source: r.source,
    })),
    reference_values: (ing.reference_values ?? []).map((r) => ({
      type: r.type,
      value: r.value,
      ...(r.unit ? { unit: r.unit } : {}),
      body: r.body,
      ...(r.year ? { year: r.year } : {}),
      source: r.source,
    })),
    review_status: ing.review_status,
    provenance: ing.provenance,
    review_notes: ing.review_notes ?? [],
    sources,
    kb_version: index.version,
  };
}

const bearer = [{ bearerAuth: [] }];
const problemResponses = (...codes: number[]) =>
  Object.fromEntries(codes.map((code) => [code, {
    description: {
      400: "Invalid request",
      401: "Missing or invalid API key",
      403: "Key lacks the required scope",
      404: "Not found",
      413: "Body too large",
      415: "Content-Type must be application/json",
      429: "Rate limit or daily quota exceeded",
    }[code] ?? "Error",
    content: { "application/problem+json": { schema: S.Problem } },
  }]));

export function createApp(deps: AppDeps) {
  // With keyless access on, the key is optional: `{}` is the OpenAPI way to say "no auth also works".
  const security = deps.anonymous ? [...bearer, {}] : bearer;
  const app = new OpenAPIHono<Env>({
    defaultHook: (result, c) => {
      if (!result.success) {
        const errors = result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
        return problem(c as C, 400, "invalid-request", "Invalid request", undefined, { errors });
      }
    },
  });

  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    description: "API key: `Authorization: Bearer nsi_…`",
  });

  // ---------------------------------------------------------------- global middleware
  app.use("*", async (c, next) => {
    const incoming = c.req.header("x-request-id");
    c.set("reqId", incoming && /^[A-Za-z0-9._-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID());
    const started = performance.now();
    await next();
    c.header("x-request-id", c.get("reqId"));
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "no-referrer");
    if (!c.res.headers.has("cache-control")) c.header("cache-control", "no-store");
    const key = c.get("key");
    deps.log.log(c.res.status >= 500 ? "error" : "info", "request", {
      req_id: c.get("reqId"),
      method: c.req.method,
      route: c.req.routePath,
      status: c.res.status,
      ms: Math.round((performance.now() - started) * 10) / 10,
      ...(key ? { key: key.prefix } : {}),
    });
  });

  const origins = deps.config.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
  if (origins.length) {
    app.use("/v1/*", cors({ origin: origins, allowHeaders: ["authorization", "content-type"], maxAge: 600 }));
  }

  const limitHeaders = (c: C, d: LimitDecision) => {
    c.header("ratelimit-limit", String(d.limit));
    c.header("ratelimit-remaining", String(d.remaining));
    c.header("ratelimit-reset", String(d.resetSeconds));
    if (!d.allowed) c.header("retry-after", String(d.resetSeconds));
  };

  const requireScope = (scope: Scope): MiddlewareHandler<Env> => async (c, next) => {
    const auth = c.req.header("authorization") ?? "";
    const token = auth.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!token && !auth && deps.anonymous?.scopes.includes(scope)) {
      const d = await deps.anonymous.take(c.req.header("cf-connecting-ip") ?? "unknown", scope);
      limitHeaders(c, d);
      if (!d.allowed) {
        return problem(
          c,
          429,
          "rate-limited",
          "Too many requests",
          `Keyless access allows ${d.limit} requests a minute per IP address. Try again in ${d.resetSeconds} s.`,
        );
      }
      return await next();
    }
    if (!token) {
      c.header("www-authenticate", 'Bearer realm="ns-ingredients"');
      return problem(c, 401, "unauthorized", "Missing API key", "Send Authorization: Bearer <key>.");
    }
    const key = await deps.keys.verify(token);
    if (!key) {
      c.header("www-authenticate", 'Bearer realm="ns-ingredients", error="invalid_token"');
      return problem(c, 401, "unauthorized", "Invalid or revoked API key");
    }
    c.set("key", key);
    if (!key.scopes.includes(scope)) {
      return problem(c, 403, "forbidden", "Insufficient scope", `This route needs ${scope}.`);
    }

    const rate = deps.limiter.take(key.id, key.rate_per_min);
    const quota: LimitDecision = rate.allowed ? await deps.quota.take(key.id, key.daily_quota) : rate;
    const binding = !rate.allowed
      ? rate
      : !quota.allowed
      ? quota
      : rate.remaining <= quota.remaining
      ? rate
      : quota;
    limitHeaders(c, { ...binding, allowed: rate.allowed && quota.allowed });
    if (!rate.allowed || !quota.allowed) {
      deps.usage.record(key.id, c.req.routePath, true);
      return problem(
        c,
        429,
        binding.reason === "quota" ? "quota-exceeded" : "rate-limited",
        binding.reason === "quota" ? "Daily quota exceeded" : "Too many requests",
      );
    }
    await next();
    deps.usage.record(key.id, c.req.routePath, c.res.status >= 400);
  };

  /** Conditional GET: KB responses depend only on kb_version, URL and language. */
  const etag: MiddlewareHandler<Env> = async (c, next) => {
    const tag = `W/"${deps.index().version}.${
      fnv1a(c.req.url + "|" + (c.req.header("accept-language") ?? ""))
    }"`;
    if (c.req.header("if-none-match") === tag) {
      return c.body(null, 304, { etag: tag, "cache-control": "private, max-age=300" });
    }
    await next();
    if (c.res.status === 200) {
      c.header("etag", tag);
      c.header("cache-control", "private, max-age=300");
      c.header("x-kb-version", deps.index().version);
    }
  };

  // "/v1/ingredients/*" would also match "/v1/ingredients" and run the limiter twice per search.
  for (const p of ["/v1/ingredients", "/v1/ingredients/:id", "/v1/implications", "/v1/sources/:id"]) {
    app.use(p, requireScope("kb:read"), etag);
  }
  app.use("/v1/analyze", requireScope("analyze"));
  app.use(
    "/v1/analyze",
    bodyLimit({
      maxSize: ANALYZE_MAX_BYTES,
      onError: (c) =>
        problem(c as C, 413, "payload-too-large", "Body too large", `Limit is ${ANALYZE_MAX_BYTES} bytes.`),
    }),
  );
  app.use("/v1/analyze", async (c, next) => {
    if (c.req.method === "POST" && !/^application\/json\b/i.test(c.req.header("content-type") ?? "")) {
      return problem(c, 415, "unsupported-media-type", "Content-Type must be application/json");
    }
    await next();
  });

  // ---------------------------------------------------------------- public routes
  app.get("/health", (c) => c.json({ status: "ok" }));

  app.get("/ready", async (c) => {
    try {
      await deps.db?.query("select 1");
      return c.json({ status: "ready", kb_version: deps.index().version });
    } catch {
      return problem(c, 503, "not-ready", "Database unavailable");
    }
  });

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/meta",
      tags: ["meta"],
      summary: "Service, knowledge-base version, licences and attribution",
      responses: {
        200: { description: "Metadata", content: { "application/json": { schema: S.MetaResponse } } },
      },
    }),
    (c) => {
      const idx = deps.index();
      return c.json({
        service: "ns-ingredients",
        version: SERVICE_VERSION,
        kb_version: idx.version,
        methodology_version: METHODOLOGY_VERSION,
        counts: {
          ingredients: idx.ingredients.size,
          curated: idx.counts.curated,
          generated: idx.counts.generated,
          implications: idx.implications.size,
          sources: idx.sources.size,
          classes: idx.classes.size,
        },
        licences: {
          code: "AGPL-3.0-only",
          knowledge_base: "CC-BY-SA-4.0",
          generated_identity: "CC0-1.0 (Wikidata)",
        },
        attribution: [
          "Powered by ns-ingredients (NextSolutions): https://github.com/NextSolutionsStudio/ns-ingredients",
          "Ingredient knowledge base © NextSolutions and contributors, CC BY-SA 4.0.",
          "Additive identity data from Wikidata (CC0).",
          "Regulatory facts cite EU legislation (EUR-Lex, reuse under Commission Decision 2011/833/EU).",
        ],
        ...(deps.anonymous?.perMinute
          ? { keyless: { scopes: [...deps.anonymous.scopes], per_minute: { ...deps.anonymous.perMinute } } }
          : {}),
        docs: `${deps.config.PUBLIC_BASE_URL}/docs`,
        openapi: `${deps.config.PUBLIC_BASE_URL}/v1/openapi.json`,
      }, 200);
    },
  );

  // ---------------------------------------------------------------- knowledge base
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/ingredients",
      tags: ["knowledge base"],
      summary: "Search ingredients by name (PL/EN/DE), E-number or keywords, with facet filters",
      security,
      request: { query: S.SearchQuery },
      responses: {
        200: { description: "Ranked results", content: { "application/json": { schema: S.SearchResponse } } },
        ...problemResponses(400, 401, 403, 429),
      },
    }),
    (c) => {
      const q = c.req.valid("query");
      const lang = langOf(c, q.lang);
      const idx = deps.index();
      const list = (s?: string) => s?.split(",").map((x) => x.trim()).filter(Boolean);
      const hits = idx.search(q.q ?? "", {
        implication: list(q.implication),
        origin: list(q.origin),
        fn: q.function,
        type: q.type,
        review: q.review_status,
      });
      let offset = 0;
      if (q.cursor) {
        let decoded = NaN;
        try {
          decoded = Number(atob(q.cursor.replace(/-/g, "+").replace(/_/g, "/")));
        } catch {
          // not base64 — falls through to the 400 below
        }
        if (!Number.isInteger(decoded) || decoded < 0) {
          return problem(c, 400, "invalid-request", "Invalid cursor");
        }
        offset = decoded;
      }
      const page = hits.slice(offset, offset + q.limit);
      const next = offset + q.limit < hits.length ? btoa(String(offset + q.limit)).replace(/=+$/, "") : null;
      return c.json({
        items: page.map((h) => {
          const ing = idx.ingredients.get(h.id)!;
          const tags = [
            ...new Set(
              (ing.assertions ?? []).filter((a) => a.certainty === "yes" || a.certainty === "maybe").map((
                a,
              ) => a.code),
            ),
          ];
          return {
            id: ing.id,
            name: idx.displayName(ing, lang),
            ...(ing.e_number ? { e_number: ing.e_number } : {}),
            type: ing.type,
            match: { type: h.matchType, matched: h.matched, score: Math.round(h.score * 1000) / 1000 },
            tags,
            review_status: ing.review_status,
            provenance: ing.provenance,
          };
        }),
        total: hits.length,
        next_cursor: next,
        kb_version: idx.version,
      }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/ingredients/{id}",
      tags: ["knowledge base"],
      summary: "Full ingredient record: identity, production variants, cited assertions, regulatory status",
      security,
      request: {
        params: z.object({
          id: z.string().max(80).openapi({ description: "Ingredient id or E-number", example: "E296" }),
        }),
        query: z.object({ lang: S.LangParam }),
      },
      responses: {
        200: { description: "Ingredient", content: { "application/json": { schema: S.Ingredient } } },
        ...problemResponses(401, 403, 404, 429),
      },
    }),
    (c) => {
      const { id } = c.req.valid("param");
      const idx = deps.index();
      const ing = idx.get(id);
      if (!ing) {
        return problem(c, 404, "not-found", "Unknown ingredient", `No ingredient or E-number "${id}".`);
      }
      return c.json(presentIngredient(idx, ing, langOf(c, c.req.valid("query").lang)), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/implications",
      tags: ["knowledge base"],
      summary: "The implication taxonomy (standardised codes an ingredient can imply)",
      security,
      request: { query: z.object({ lang: S.LangParam }) },
      responses: {
        200: { description: "Taxonomy", content: { "application/json": { schema: S.ImplicationsResponse } } },
        ...problemResponses(401, 403, 429),
      },
    }),
    (c) => {
      const lang = langOf(c, c.req.valid("query").lang);
      const idx = deps.index();
      return c.json({
        items: [...idx.implications.values()].map((i) => ({
          code: i.code,
          group: i.group,
          severity: i.severity,
          concern: i.concern,
          kind: i.kind,
          label: t(i.label, lang)!,
          definition: t(i.definition, lang)!,
          evidence_required: i.evidence_required,
        })),
        kb_version: idx.version,
      }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/sources/{id}",
      tags: ["knowledge base"],
      summary: "A cited source",
      security,
      request: { params: z.object({ id: z.string().max(80) }) },
      responses: {
        200: { description: "Source", content: { "application/json": { schema: S.SourceResponse } } },
        ...problemResponses(401, 403, 404, 429),
      },
    }),
    (c) => {
      const s = deps.index().sources.get(c.req.valid("param").id);
      if (!s) return problem(c, 404, "not-found", "Unknown source");
      return c.json(s, 200);
    },
  );

  // ---------------------------------------------------------------- analysis
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/analyze",
      tags: ["analysis"],
      summary:
        "Analyse an ingredient list: matches, production variants, flags with sources, diets, optional profile check",
      description: "The optional `profile` is evaluated for this request only. It is never stored or logged.",
      security,
      request: { body: { required: true, content: { "application/json": { schema: S.AnalyzeRequest } } } },
      responses: {
        200: { description: "Analysis", content: { "application/json": { schema: S.AnalysisResponse } } },
        ...problemResponses(400, 401, 403, 413, 415, 429),
      },
    }),
    (c) => {
      const body = c.req.valid("json");
      const result = analyze(deps.index(), body.text, {
        lang: body.lang ?? langOf(c),
        profile: body.profile,
      });
      c.header("x-kb-version", result.kb_version);
      return c.json(result, 200);
    },
  );

  // ---------------------------------------------------------------- docs
  app.doc31("/v1/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "NextSolutions Ingredients API",
      version: SERVICE_VERSION,
      description:
        "Open ingredient knowledge base and label analysis: what an ingredient is, how it is made " +
        "(natural vs synthetic production variants), what it implies (allergens, diets, origin, processing, " +
        "regulatory status, health notes) — every claim with its kind, evidence grade and sources.\n\n" +
        "Informational only, not medical advice. Code AGPL-3.0 (with an attribution term, see NOTICE); " +
        "knowledge base CC BY-SA 4.0.",
      license: { name: "AGPL-3.0-only", url: "https://www.gnu.org/licenses/agpl-3.0.html" },
    },
    servers: [{ url: deps.config.PUBLIC_BASE_URL }],
  });

  app.get("/docs", (c) =>
    c.html(
      `<!doctype html><html><head><meta charset="utf-8"><title>Ingredients API</title>` +
        `<meta name="viewport" content="width=device-width,initial-scale=1"></head><body>` +
        `<script id="api-reference" data-url="/v1/openapi.json"></script>` +
        `<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1"></script></body></html>`,
      200,
      { "cache-control": "public, max-age=3600" },
    ));

  app.get("/", (c) => c.redirect("/docs", 302));

  // RFC 9457 type URIs resolve to their own description.
  app.get("/problems/:slug", (c) => {
    const p = PROBLEM_TYPES[c.req.param("slug")];
    if (!p) return problem(c as C, 404, "not-found", "Not found");
    return c.json({ type: PROBLEM_BASE + c.req.param("slug"), ...p }, 200, {
      "cache-control": "public, max-age=86400",
    });
  });

  app.notFound((c) => problem(c as C, 404, "not-found", "Not found"));
  app.onError((err, c) => {
    // Malformed JSON bodies surface here as a parse error or an HTTPException from the validator.
    const status = err instanceof HTTPException ? err.status : err instanceof SyntaxError ? 400 : 500;
    if (status < 500) {
      return problem(c as C, status, "invalid-request", "Invalid request", "The body is not valid JSON.");
    }
    deps.log.log("error", "unhandled", { req_id: c.get("reqId"), error: String(err?.message ?? err) });
    return problem(c as C, 500, "internal", "Internal error");
  });

  return app;
}
