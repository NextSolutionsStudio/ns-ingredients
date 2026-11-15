// The inverted trigram index must give exactly the answer a scan over every name would give.
import { assertEquals } from "@std/assert";
import fc from "fast-check";
import { KbIndex } from "../../src/core/kb-index.ts";
import { normName, trigrams, trigramSimilarity } from "../../src/core/normalize.ts";
import { readKb } from "../../src/kb/read.ts";
import { KB_DIR } from "../helpers.ts";

const { bundle } = await readKb(KB_DIR);
const index = new KbIndex(bundle!);
const names = index.names.map((n) => n.norm);

/** The linear scan the index replaced. */
function bruteForce(norm: string): { norm: string; sim: number } | null {
  const q = trigrams(norm);
  let best: { norm: string; sim: number } | null = null;
  for (const n of index.names) {
    if (Math.abs(n.norm.length - norm.length) > Math.max(4, norm.length * 0.4)) continue;
    const sim = trigramSimilarity(q, n.tri);
    if (sim > (best?.sim ?? 0)) best = { norm: n.norm, sim };
  }
  return best;
}

// Real names with typos, deletions and insertions — the inputs fuzzy matching exists for.
const perturbed = fc.tuple(fc.constantFrom(...names), fc.nat(), fc.constantFrom("", "a", "y", "z", "sz", " "))
  .map(([name, at, ins]) => {
    const i = name.length ? at % name.length : 0;
    return normName(name.slice(0, i) + ins + name.slice(i + 1));
  })
  .filter((s) => s.length >= 5);

Deno.test("nearestName equals the brute-force scan (similarity and name)", () => {
  fc.assert(
    fc.property(fc.oneof(perturbed, fc.string({ minLength: 5, maxLength: 30 }).map(normName)), (q) => {
      if (!q) return;
      const got = index.nearestName(q);
      const want = bruteForce(q);
      assertEquals(got ? { norm: got.entry.norm, sim: got.sim } : null, want);
    }),
    { numRuns: 400 },
  );
});
