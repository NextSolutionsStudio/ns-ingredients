// Local explorer: look up products on Open Food Facts by EAN or name, search the KB, and run ingredient
// lists through the real API.   deno task explorer   →   http://127.0.0.1:8030
//
// Serves the same page as the public Cloudflare deployment (web/index.html). The API runs in-process on
// an in-memory database with a throwaway key. The key lives only in this process — it is never printed or
// sent to the browser; the proxy below attaches it. Binds to loopback only.
import { createKey } from "../src/auth/keys.ts";
import { loadConfig } from "../src/config.ts";
import { jsonLogger } from "../src/http/log.ts";
import { createOffClient, routeOff } from "../src/off/off.ts";
import { createRuntime } from "../src/runtime.ts";

const PORT = Number(Deno.env.get("EXPLORER_PORT") ?? 8030);

const rt = await createRuntime(
  loadConfig({ DATABASE_URL: "pglite:memory", LOG_LEVEL: "warn" }),
  jsonLogger("warn"),
);
const { token } = await createKey(rt.db, {
  label: "explorer",
  scopes: ["kb:read", "analyze"],
  ratePerMin: 600,
  dailyQuota: 100_000,
});
const off = createOffClient("ns-ingredients-explorer/0.1 (NextSolutions; local development tool)");
const WEB = new URL("../web/", import.meta.url); // re-read per request: edits show on reload

// ---------------------------------------------------------------- API proxy
const API_PATHS = /^\/(?:v1\/|problems\/|docs$|health$|ready$)/;
const FORWARD_HEADERS = ["content-type", "if-none-match", "accept", "accept-language"];

async function toApi(req: Request, url: URL): Promise<Response> {
  const headers = new Headers({ authorization: `Bearer ${token}` });
  for (const h of FORWARD_HEADERS) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
  return await rt.app.request(url.pathname + url.search, { method: req.method, headers, body });
}

// ---------------------------------------------------------------- server
const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  svg: "image/svg+xml",
};

/** The headers web/_headers gives every page on Cloudflare, so the page runs locally under the same CSP. */
async function pageHeaders(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const text = await Deno.readTextFile(new URL("_headers", WEB));
  for (const line of text.split("\n")) {
    const m = line.match(/^\s+([A-Za-z-]+):\s*(.+)$/);
    if (m) out[m[1].toLowerCase()] = m[2].trim();
  }
  return out;
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const type = /^[\w-]+\.(\w+)$/.test(file) ? TYPES[file.split(".").pop()!] : undefined;
  if (type && req.method === "GET") {
    try {
      return new Response(await Deno.readTextFile(new URL(file, WEB)), {
        headers: { ...await pageHeaders(), "content-type": type, "cache-control": "no-store" },
      });
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }
  if (API_PATHS.test(url.pathname)) return await toApi(req, url);
  return await routeOff(off, req, url) ??
    new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
}

Deno.serve({
  hostname: "127.0.0.1",
  port: PORT,
  onListen: ({ port }) =>
    console.log(
      `ns-ingredients explorer on http://127.0.0.1:${port}  (KB ${rt.index.version}, ${rt.index.ingredients.size} ingredients)`,
    ),
}, async (req) => {
  try {
    return await handle(req);
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
