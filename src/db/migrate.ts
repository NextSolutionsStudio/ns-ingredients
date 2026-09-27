// Forward-only migrations, applied at boot inside one transaction under an advisory lock, so
// several replicas starting together cannot race and a deploy never runs code ahead of its schema.
// The database and its owner role are created once by the operator (docs/DEPLOY.md); nothing
// here needs superuser or extensions.
import type { Db } from "./client.ts";

export const MIGRATIONS: { version: string; sql: string }[] = [
  {
    version: "0001_keys_and_usage",
    sql: `
      create table api_key (
        id bigint generated always as identity primary key,
        prefix text not null unique,
        hash text not null,
        label text not null,
        owner text,
        scopes text not null,
        rate_per_min integer not null default 60 check (rate_per_min > 0),
        daily_quota integer not null default 10000 check (daily_quota > 0),
        created_at timestamptz not null default now(),
        last_used_at timestamptz,
        revoked_at timestamptz
      );
      create table api_usage (
        key_id bigint not null references api_key(id),
        day date not null,
        route text not null,
        count integer not null default 0,
        errors integer not null default 0,
        primary key (key_id, day, route)
      );
      create index api_usage_day on api_usage (day);
    `,
  },
];

const LOCK_ID = 726_354_001;

export async function migrate(db: Db): Promise<string[]> {
  return await db.tx(async (tx) => {
    await tx.query("select pg_advisory_xact_lock($1)", [LOCK_ID]);
    await tx.exec(`create table if not exists schema_migrations (
      version text primary key,
      applied_at timestamptz not null default now()
    )`);
    const done = new Set(
      (await tx.query<{ version: string }>("select version from schema_migrations")).map((r) => r.version),
    );
    const applied: string[] = [];
    for (const m of MIGRATIONS) {
      if (done.has(m.version)) continue;
      await tx.exec(m.sql);
      await tx.query("insert into schema_migrations (version) values ($1)", [m.version]);
      applied.push(m.version);
    }
    return applied;
  });
}
