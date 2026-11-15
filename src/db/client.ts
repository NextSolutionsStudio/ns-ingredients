// One small interface over two drivers: postgres.js in production, PGlite (PostgreSQL 17 in
// WASM) for tests and local development. Same SQL runs on both.
import postgres from "postgres";

export interface Db {
  readonly kind: "postgres" | "pglite";
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Multi-statement SQL without parameters (migrations). */
  exec(sql: string): Promise<void>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function connect(url: string): Promise<Db> {
  if (url.startsWith("pglite:")) return await connectPglite(url.slice("pglite:".length));
  return connectPostgres(url);
}

type Sql = postgres.Sql | postgres.TransactionSql;

function wrapPostgres(sql: Sql, root: postgres.Sql): Db {
  return {
    kind: "postgres",
    async query<T>(text: string, params: unknown[] = []) {
      return (await sql.unsafe(text, params as postgres.ParameterOrJSON<never>[])) as unknown as T[];
    },
    async exec(text: string) {
      await sql.unsafe(text);
    },
    tx<T>(fn: (db: Db) => Promise<T>) {
      return root.begin((t) => fn(wrapPostgres(t, root))) as Promise<T>;
    },
    async close() {
      await root.end({ timeout: 5 });
    },
  };
}

export function connectPostgres(url: string): Db {
  const sql = postgres(url, {
    max: 10,
    idle_timeout: 30,
    connect_timeout: 10,
    onnotice: () => {},
    // bigint/int8 → number is safe for our counters and ids.
    types: { bigint: postgres.BigInt },
    transform: { undefined: null },
  });
  return wrapPostgres(sql, sql);
}

async function connectPglite(dir: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = dir && dir !== "memory" ? new PGlite(dir) : new PGlite();
  await pg.waitReady;
  const wrap = (q: { query: typeof pg.query; exec: typeof pg.exec }, isRoot: boolean): Db => ({
    kind: "pglite",
    async query<T>(text: string, params: unknown[] = []) {
      return (await q.query<T>(text, params)).rows;
    },
    async exec(text: string) {
      await q.exec(text);
    },
    tx<T>(fn: (db: Db) => Promise<T>) {
      if (!isRoot) return fn(wrap(q, false));
      return pg.transaction((t) => fn(wrap(t as unknown as typeof q, false)));
    },
    async close() {
      if (isRoot) await pg.close();
    },
  });
  return wrap(pg, true);
}
