// Prints the OpenAPI 3.1 document without binding a port:  deno task openapi > openapi.json
// The document is generated from the same zod schemas that validate requests, so it cannot drift.
import { loadConfig } from "../src/config.ts";
import { memoryLogger } from "../src/http/log.ts";
import { createRuntime } from "../src/runtime.ts";

const rt = await createRuntime(loadConfig({ DATABASE_URL: "pglite:memory" }), memoryLogger());
try {
  const res = await rt.app.request("/v1/openapi.json");
  if (res.status !== 200) throw new Error(`openapi.json returned ${res.status}`);
  console.log(JSON.stringify(await res.json(), null, 2));
} finally {
  await rt.close();
}
