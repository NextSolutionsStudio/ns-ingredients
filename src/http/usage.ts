// Usage counters aggregated in memory and upserted every few seconds: one write per key/route
// per flush instead of one per request. Nothing about the request body is recorded.
import type { Db } from "../db/client.ts";

export class UsageRecorder {
  private pending = new Map<
    string,
    { keyId: number; day: string; route: string; count: number; errors: number }
  >();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private db: Db, private onError: (e: unknown) => void = () => {}) {}

  record(keyId: number, route: string, failed: boolean, now = Date.now()) {
    const day = new Date(now).toISOString().slice(0, 10);
    const k = `${keyId}|${day}|${route}`;
    const e = this.pending.get(k) ?? { keyId, day, route, count: 0, errors: 0 };
    e.count++;
    if (failed) e.errors++;
    this.pending.set(k, e);
  }

  start(seconds: number) {
    this.timer = setInterval(() => this.flush().catch(this.onError), seconds * 1000);
    Deno.unrefTimer(this.timer as unknown as number);
  }

  async stop() {
    if (this.timer !== undefined) clearInterval(this.timer);
    await this.flush();
  }

  async flush() {
    if (!this.pending.size) return;
    const batch = [...this.pending.values()];
    this.pending.clear();
    try {
      // jsonb_to_recordset keeps it one statement and identical on postgres.js and PGlite.
      await this.db.query(
        `insert into api_usage (key_id, day, route, count, errors)
         select key_id, day, route, count, errors
         from jsonb_to_recordset($1::jsonb) as x(key_id bigint, day date, route text, count int, errors int)
         on conflict (key_id, day, route) do update
         set count = api_usage.count + excluded.count, errors = api_usage.errors + excluded.errors`,
        [JSON.stringify(
          batch.map((b) => ({
            key_id: b.keyId,
            day: b.day,
            route: b.route,
            count: b.count,
            errors: b.errors,
          })),
        )],
      );
    } catch (e) {
      // Put the counts back so a transient DB error loses nothing.
      for (const b of batch) {
        const k = `${b.keyId}|${b.day}|${b.route}`;
        const cur = this.pending.get(k);
        if (cur) {
          cur.count += b.count;
          cur.errors += b.errors;
        } else this.pending.set(k, b);
      }
      throw e;
    }
  }

  async todayCount(keyId: number, day: string): Promise<number> {
    const rows = await this.db.query<{ n: number | string | null }>(
      "select coalesce(sum(count), 0)::int as n from api_usage where key_id = $1 and day = $2",
      [keyId, day],
    );
    const pendingToday = [...this.pending.values()].filter((p) => p.keyId === keyId && p.day === day)
      .reduce((n, p) => n + p.count, 0);
    return Number(rows[0]?.n ?? 0) + pendingToday;
  }
}
