// Wires config → KB → database → HTTP app. Used by the server, the CLI and the integration tests,
// so what the tests exercise is what production runs.
import type { Config } from "./config.ts";
import { KeyStore } from "./auth/keys.ts";
import { KbIndex } from "./core/kb-index.ts";
import { connect, type Db } from "./db/client.ts";
import { migrate } from "./db/migrate.ts";
import { createApp } from "./http/app.ts";
import { DailyQuota, RateLimiter } from "./http/limits.ts";
import type { Logger } from "./http/log.ts";
import { UsageRecorder } from "./http/usage.ts";
import { readKb } from "./kb/read.ts";

export interface Runtime {
  app: ReturnType<typeof createApp>;
  db: Db;
  index: KbIndex;
  keys: KeyStore;
  usage: UsageRecorder;
  limiter: RateLimiter;
  close(): Promise<void>;
}

const kbCache = new Map<string, KbIndex>();

/** Reads and validates the KB; refuses to start on any error. Cached per directory (tests reuse it). */
export async function loadIndex(dir: string, log?: Logger): Promise<KbIndex> {
  const cached = kbCache.get(dir);
  if (cached) return cached;
  const { bundle, errors, warnings } = await readKb(dir);
  if (!bundle) throw new Error(`Knowledge base in ${dir} is invalid:\n${errors.join("\n")}`);
  if (warnings.length) log?.log("warn", "kb warnings", { count: warnings.length });
  const index = new KbIndex(bundle);
  kbCache.set(dir, index);
  return index;
}

export async function createRuntime(
  cfg: Config,
  log: Logger,
  opts: { db?: Db; index?: KbIndex } = {},
): Promise<Runtime> {
  const index = opts.index ?? await loadIndex(cfg.KB_DIR, log);
  const db = opts.db ?? await connect(cfg.DATABASE_URL);
  const applied = await migrate(db);
  if (applied.length) log.log("info", "migrations applied", { applied });
  const usage = new UsageRecorder(db, (e) => log.log("error", "usage flush failed", { error: String(e) }));
  const keys = new KeyStore(db, cfg.KEY_CACHE_SECONDS);
  const limiter = new RateLimiter();
  const quota = new DailyQuota((id, day) => usage.todayCount(id, day));
  const app = createApp({ index: () => index, db, keys, limiter, quota, usage, log, config: cfg });
  log.log("info", "ready", {
    kb_version: index.version,
    ingredients: index.ingredients.size,
    curated: index.counts.curated,
    db: db.kind,
  });
  return {
    app,
    db,
    index,
    keys,
    usage,
    limiter,
    async close() {
      await usage.stop();
      await db.close();
    },
  };
}
