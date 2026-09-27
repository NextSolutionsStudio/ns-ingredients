// API keys: nsi_<8-char prefix>_<32-char secret>. Only a SHA-256 of the whole token is stored;
// the prefix is the lookup handle and is safe to log.
import { encodeHex } from "@std/encoding/hex";
import type { Db } from "../db/client.ts";

export const SCOPES = ["kb:read", "analyze"] as const;
export type Scope = (typeof SCOPES)[number];

export interface ApiKey {
  id: number;
  prefix: string;
  label: string;
  owner: string | null;
  scopes: Scope[];
  rate_per_min: number;
  daily_quota: number;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const TOKEN_RE = /^nsi_([0-9A-Za-z]{8})_([0-9A-Za-z]{32})$/;

function randomBase62(n: number): string {
  // Rejection sampling keeps the distribution uniform (256 is not a multiple of 62).
  let out = "";
  while (out.length < n) {
    for (const b of crypto.getRandomValues(new Uint8Array(n * 2))) {
      if (b < 248 && out.length < n) out += ALPHABET[b % 62];
    }
  }
  return out;
}

export async function sha256Hex(s: string): Promise<string> {
  return encodeHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
}

/** Constant-time comparison of two equal-length hex strings. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function parseToken(token: string): { prefix: string } | null {
  const m = token.match(TOKEN_RE);
  return m ? { prefix: m[1] } : null;
}

export interface CreateKeyInput {
  label: string;
  owner?: string;
  scopes: Scope[];
  ratePerMin?: number;
  dailyQuota?: number;
}

export async function createKey(db: Db, input: CreateKeyInput): Promise<{ token: string; key: ApiKey }> {
  for (const s of input.scopes) if (!SCOPES.includes(s)) throw new Error(`unknown scope ${s}`);
  if (!input.scopes.length) throw new Error("at least one scope is required");
  const prefix = randomBase62(8);
  const token = `nsi_${prefix}_${randomBase62(32)}`;
  const rows = await db.query<Record<string, unknown>>(
    `insert into api_key (prefix, hash, label, owner, scopes, rate_per_min, daily_quota)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning id, prefix, label, owner, scopes, rate_per_min, daily_quota, created_at, last_used_at, revoked_at`,
    [
      prefix,
      await sha256Hex(token),
      input.label,
      input.owner ?? null,
      input.scopes.join(" "),
      input.ratePerMin ?? 60,
      input.dailyQuota ?? 10000,
    ],
  );
  return { token, key: rowToKey(rows[0]) };
}

export async function listKeys(db: Db): Promise<ApiKey[]> {
  const rows = await db.query<Record<string, unknown>>(
    `select id, prefix, label, owner, scopes, rate_per_min, daily_quota, created_at, last_used_at, revoked_at
     from api_key order by id`,
  );
  return rows.map(rowToKey);
}

export async function revokeKey(db: Db, prefix: string): Promise<boolean> {
  const rows = await db.query(
    "update api_key set revoked_at = now() where prefix = $1 and revoked_at is null returning id",
    [prefix],
  );
  return rows.length > 0;
}

function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

function rowToKey(r: Record<string, unknown>): ApiKey {
  return {
    id: Number(r.id),
    prefix: String(r.prefix),
    label: String(r.label),
    owner: (r.owner as string | null) ?? null,
    scopes: String(r.scopes).split(" ").filter(Boolean) as Scope[],
    rate_per_min: Number(r.rate_per_min),
    daily_quota: Number(r.daily_quota),
    created_at: iso(r.created_at)!,
    last_used_at: iso(r.last_used_at),
    revoked_at: iso(r.revoked_at),
  };
}

/**
 * Verifies bearer tokens against the database with a short cache. A revoked key keeps working
 * for at most `cacheSeconds`; misses are cached too, so garbage tokens cannot hammer Postgres.
 */
export class KeyStore {
  private cache = new Map<string, { at: number; row: { key: ApiKey; hash: string } | null }>();
  private touched = new Map<number, number>();

  constructor(private db: Db, private cacheSeconds = 60, private now = () => Date.now()) {}

  async verify(token: string): Promise<ApiKey | null> {
    const parsed = parseToken(token);
    if (!parsed) return null;
    const hash = await sha256Hex(token);
    let entry = this.cache.get(parsed.prefix);
    if (!entry || this.now() - entry.at > this.cacheSeconds * 1000) {
      const rows = await this.db.query<Record<string, unknown>>(
        `select id, prefix, hash, label, owner, scopes, rate_per_min, daily_quota, created_at, last_used_at, revoked_at
         from api_key where prefix = $1`,
        [parsed.prefix],
      );
      entry = {
        at: this.now(),
        row: rows[0] ? { key: rowToKey(rows[0]), hash: String(rows[0].hash) } : null,
      };
      this.cache.set(parsed.prefix, entry);
      if (this.cache.size > 10_000) this.cache.delete(this.cache.keys().next().value!);
    }
    const row = entry.row;
    if (!row || row.key.revoked_at || !timingSafeEqual(row.hash, hash)) return null;
    this.touch(row.key.id);
    return row.key;
  }

  /** last_used_at, written at most once a minute per key and never awaited by the request. */
  private touch(id: number) {
    const last = this.touched.get(id) ?? 0;
    if (this.now() - last < 60_000) return;
    this.touched.set(id, this.now());
    this.db.query("update api_key set last_used_at = now() where id = $1", [id]).catch(() => {});
  }

  invalidate(prefix?: string) {
    if (prefix) this.cache.delete(prefix);
    else this.cache.clear();
  }
}
