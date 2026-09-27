// Migrations and SQL behaviour. PGlite by default; the same file runs against real Postgres in CI
// (TEST_DATABASE_URL=postgres://… on postgres:17-alpine), which is the live major on postgres-ns.
import { assert, assertEquals } from "@std/assert";
import { connect } from "../../src/db/client.ts";
import { migrate, MIGRATIONS } from "../../src/db/migrate.ts";

const url = Deno.env.get("TEST_DATABASE_URL") ?? "pglite:memory";

async function fresh() {
  const db = await connect(url);
  if (db.kind === "postgres") {
    await db.exec("drop table if exists api_usage, api_key, schema_migrations cascade");
  }
  return db;
}

Deno.test("migrations apply from zero, record themselves, and are idempotent", async () => {
  const db = await fresh();
  try {
    assertEquals(await migrate(db), MIGRATIONS.map((m) => m.version));
    assertEquals(await migrate(db), []);
    const rows = await db.query<{ version: string }>(
      "select version from schema_migrations order by version",
    );
    assertEquals(rows.map((r) => r.version), MIGRATIONS.map((m) => m.version));
  } finally {
    await db.close();
  }
});

Deno.test("concurrent boots serialise on the advisory lock", async () => {
  if (url === "pglite:memory") return; // one PGlite instance = one connection; nothing to race
  const a = await fresh();
  const b = await connect(url);
  try {
    const results = await Promise.all([migrate(a), migrate(b)]);
    assertEquals(results.flat().sort(), MIGRATIONS.map((m) => m.version).sort());
  } finally {
    await a.close();
    await b.close();
  }
});

Deno.test("constraints hold: positive limits, unique prefix", async () => {
  const db = await fresh();
  try {
    await migrate(db);
    await db.query(
      "insert into api_key (prefix, hash, label, scopes) values ('AAAAAAAA', 'h', 'l', 'kb:read')",
    );
    let dup = false;
    try {
      await db.query(
        "insert into api_key (prefix, hash, label, scopes) values ('AAAAAAAA', 'h2', 'l2', 'kb:read')",
      );
    } catch {
      dup = true;
    }
    assert(dup, "duplicate prefix rejected");
    let neg = false;
    try {
      await db.query(
        "insert into api_key (prefix, hash, label, scopes, rate_per_min) values ('BBBBBBBB', 'h', 'l', 'kb:read', 0)",
      );
    } catch {
      neg = true;
    }
    assert(neg, "rate_per_min must be positive");
  } finally {
    await db.close();
  }
});

Deno.test("transactions roll back on error", async () => {
  const db = await fresh();
  try {
    await migrate(db);
    try {
      await db.tx(async (tx) => {
        await tx.query(
          "insert into api_key (prefix, hash, label, scopes) values ('CCCCCCCC', 'h', 'l', 'kb:read')",
        );
        throw new Error("boom");
      });
    } catch {
      // expected
    }
    const rows = await db.query("select 1 from api_key where prefix = 'CCCCCCCC'");
    assertEquals(rows.length, 0);
  } finally {
    await db.close();
  }
});
