// Server entry point: deno task start
import { loadConfig } from "./config.ts";
import { jsonLogger } from "./http/log.ts";
import { createRuntime } from "./runtime.ts";

const cfg = loadConfig();
const log = jsonLogger(cfg.LOG_LEVEL);
if (cfg.DATABASE_URL.startsWith("pglite:memory")) {
  log.log("warn", "using an in-memory database — keys and usage are lost on restart (development only)");
}
const rt = await createRuntime(cfg, log);
rt.usage.start(cfg.USAGE_FLUSH_SECONDS);

const server = Deno.serve(
  {
    port: cfg.PORT,
    hostname: cfg.HOST,
    onListen: ({ hostname, port }) => log.log("info", "listening", { hostname, port }),
  },
  rt.app.fetch,
);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.log("info", "shutting down", { signal });
  await server.shutdown();
  await rt.close(); // flushes pending usage counters
  Deno.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  try {
    Deno.addSignalListener(sig, () => shutdown(sig));
  } catch {
    // SIGTERM is not supported on Windows; SIGINT is enough for local runs there.
  }
}
