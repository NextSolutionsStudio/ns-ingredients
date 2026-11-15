// deno task keys create --label airon --scopes kb:read,analyze [--owner x] [--rate 120] [--quota 50000]
// deno task keys list
// deno task keys revoke <prefix>
// Talks to DATABASE_URL directly; there is deliberately no admin HTTP surface.
import { parseArgs } from "@std/cli/parse-args";
import { createKey, listKeys, revokeKey, type Scope } from "../auth/keys.ts";
import { loadConfig } from "../config.ts";
import { connect } from "../db/client.ts";
import { migrate } from "../db/migrate.ts";

const args = parseArgs(Deno.args, { string: ["label", "owner", "scopes", "rate", "quota"] });
const [cmd, arg] = args._.map(String);
const cfg = loadConfig();
if (cfg.DATABASE_URL === "pglite:memory") {
  console.error(
    "DATABASE_URL points at an in-memory database; a key created there would vanish. Set DATABASE_URL.",
  );
  Deno.exit(2);
}
const db = await connect(cfg.DATABASE_URL);
await migrate(db);
try {
  if (cmd === "create") {
    if (!args.label) throw new Error("--label is required");
    const { token, key } = await createKey(db, {
      label: args.label,
      owner: args.owner,
      scopes: (args.scopes ?? "kb:read,analyze").split(",").map((s) => s.trim()) as Scope[],
      ratePerMin: args.rate ? Number(args.rate) : undefined,
      dailyQuota: args.quota ? Number(args.quota) : undefined,
    });
    console.log(
      `created ${key.prefix} (${key.label}) scopes=${
        key.scopes.join(",")
      } rate=${key.rate_per_min}/min quota=${key.daily_quota}/day`,
    );
    console.log("token (shown once — store it in the consumer's secret store):");
    console.log(token);
  } else if (cmd === "list") {
    for (const k of await listKeys(db)) {
      console.log(
        [
          k.prefix,
          k.label,
          k.owner ?? "-",
          k.scopes.join(","),
          `${k.rate_per_min}/min`,
          `${k.daily_quota}/day`,
          k.revoked_at ? `REVOKED ${k.revoked_at}` : `last used ${k.last_used_at ?? "never"}`,
        ].join("\t"),
      );
    }
  } else if (cmd === "revoke") {
    if (!arg) throw new Error("usage: keys revoke <prefix>");
    console.log(
      (await revokeKey(db, arg))
        ? `revoked ${arg} (takes effect within KEY_CACHE_SECONDS)`
        : `no active key ${arg}`,
    );
  } else {
    console.log(
      "usage: keys create --label <l> [--scopes kb:read,analyze] [--owner o] [--rate n] [--quota n] | list | revoke <prefix>",
    );
    Deno.exitCode = 2;
  }
} catch (e) {
  console.error((e as Error).message);
  Deno.exitCode = 1;
} finally {
  await db.close();
}
