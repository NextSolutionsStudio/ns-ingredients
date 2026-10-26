// Field selection: ?fields=summary,flags.code,ranking.reasons.label. Dot paths walk objects and arrays are
// implicit (flags.code takes code from every flag). Valid paths come from the published response schema, so a
// typo is a 400 that lists them rather than a silently empty object, and the list cannot drift from the API.
import type { z } from "@hono/zod-openapi";

const MAX_DEPTH = 4;
const MAX_PATHS = 50;
const PATH_RE = /^[a-z_]+(?:\.[a-z_]+)*$/;

type Def = {
  type: string;
  shape?: Record<string, z.ZodType>;
  element?: z.ZodType;
  innerType?: z.ZodType;
  getter?: () => z.ZodType;
};
const defOf = (s: z.ZodType): Def => (s as unknown as { _zod: { def: Def } })._zod.def;

/** Every dot path the schema defines, down to MAX_DEPTH. A record stops at its own key (its keys are data). */
export function schemaPaths(schema: z.ZodType): string[] {
  const out: string[] = [];
  const walk = (s: z.ZodType, prefix: string, depth: number) => {
    const d = defOf(s);
    switch (d.type) {
      case "optional":
      case "nullable":
        return walk(d.innerType!, prefix, depth);
      case "lazy":
        return walk(d.getter!(), prefix, depth);
      case "array":
        return walk(d.element!, prefix, depth);
      case "object":
        if (depth >= MAX_DEPTH) return;
        for (const [k, v] of Object.entries(d.shape!)) {
          const p = prefix ? `${prefix}.${k}` : k;
          out.push(p);
          walk(v, p, depth + 1);
        }
    }
  };
  walk(schema, "", 0);
  return [...new Set(out)];
}

type Tree = { whole: boolean; kids: Map<string, Tree> };

/** Parses ?fields= against the valid paths: the selection tree, or the paths that are not valid. */
export function parseFields(raw: string, valid: readonly string[]): { tree: Tree } | { invalid: string[] } {
  const paths = raw.split(",").map((p) => p.trim()).filter(Boolean);
  const known = new Set(valid);
  const invalid = paths.filter((p) => !PATH_RE.test(p) || !known.has(p));
  if (paths.length > MAX_PATHS) invalid.push(`(${paths.length} paths; at most ${MAX_PATHS})`);
  if (invalid.length || !paths.length) return { invalid: invalid.length ? invalid : ["(empty)"] };
  const root: Tree = { whole: false, kids: new Map() };
  for (const p of paths) {
    let node = root;
    for (const key of p.split(".")) {
      if (node.whole) break; // a parent asked for whole wins over its parts
      const next = node.kids.get(key) ?? { whole: false, kids: new Map() };
      node.kids.set(key, next);
      node = next;
    }
    node.whole = true;
    node.kids.clear();
  }
  return { tree: root };
}

/** The selected part of a response: objects keep the chosen keys, arrays map, scalars and null pass through. */
export function pick(value: unknown, tree: Tree): unknown {
  if (tree.whole || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => pick(v, tree));
  const out: Record<string, unknown> = {};
  for (const [k, sub] of tree.kids) {
    if (k in value) out[k] = pick((value as Record<string, unknown>)[k], sub);
  }
  return out;
}
