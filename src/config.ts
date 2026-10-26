// Environment → validated config. Fails fast at boot with a readable message.
import { z } from "zod";

const Env = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8029),
  HOST: z.string().default("0.0.0.0"),
  /** postgres://… in production; "pglite:memory" or "pglite:<dir>" for local development and tests. */
  DATABASE_URL: z.string().default("pglite:memory"),
  KB_DIR: z.string().default("./kb"),
  /** Comma-separated origins allowed to call the API from a browser. Empty = CORS off. */
  CORS_ORIGINS: z.string().default(""),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  PUBLIC_BASE_URL: z.url().default("https://ingredients.nextsolutions.studio"),
  /** Seconds a key lookup is cached; bounds how long a revoked key keeps working. */
  KEY_CACHE_SECONDS: z.coerce.number().int().min(0).max(600).default(60),
  USAGE_FLUSH_SECONDS: z.coerce.number().int().min(1).max(600).default(10),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: Record<string, string | undefined> = Deno.env.toObject()): Config {
  const r = Env.safeParse(env);
  if (!r.success) {
    const lines = r.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${lines}`);
  }
  return r.data;
}

export const SERVICE_VERSION = "0.1.0";
export const METHODOLOGY_VERSION = "2026-10-26";
