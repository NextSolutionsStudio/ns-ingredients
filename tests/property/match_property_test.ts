// The inverted trigram index must give exactly the answer a scan over every name would give.
import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import { KbIndex } from "../../src/core/kb-index.ts";
import { normName, trigrams, trigramSimilarity } from "../../src/core/normalize.ts";
import { readKb } from "../../src/kb/read.ts";
import type { KbBundle } from "../../src/kb/schema.ts";
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

/** An index over these names only, one ingredient each, in this order. */
function tinyIndex(list: string[]): KbIndex {
  return new KbIndex({
    version: "t",
    counts: {},
    implications: [],
    sources: [],
    classes: [],
    ingredients: list.map((n, k) => ({ id: `t${k}`, names: { en: [n] } })),
  } as unknown as KbBundle);
}

Deno.test("nearestName's length window includes both edges and nothing past them", () => {
  // query length 20: slack 8, so names of length 12 and 28 are in, 11 and 29 are out
  const q = "abcdefghijklmnopqrst";
  for (
    const [name, inWindow] of [
      ["abcdefghijkl", true], // 12
      ["abcdefghijk", false], // 11
      ["abcdefghijklmnopqrstuvwxyzab", true], // 28
      ["abcdefghijklmnopqrstuvwxyzabc", false], // 29
    ] as [string, boolean][]
  ) {
    const got = tinyIndex([name]).nearestName(q);
    assertEquals(got?.entry.norm ?? null, inWindow ? name : null, `${name.length}`);
  }
  // query length 8: slack is the floor of 4, so 4 and 12 are in, 3 and 13 are out
  const s = "abcdefgh";
  for (
    const [name, inWindow] of [["abcd", true], ["abc", false], ["abcdefghijkl", true], [
      "abcdefghijklm",
      false,
    ]] as [
      string,
      boolean,
    ][]
  ) {
    assertEquals(
      tinyIndex([name]).nearestName(s)?.entry.norm ?? null,
      inWindow ? name : null,
      `${name.length}`,
    );
  }
});

Deno.test("a tie goes to the earliest name, though the posting lists are ordered by length", () => {
  // the same trigram set ("qqq" repeats), so the same similarity; the longer name comes first in the KB and last
  // in every posting list
  const idx = tinyIndex(["abcqqqqqq", "abcqqq"]);
  const got = idx.nearestName("abcxyz");
  assertEquals(got?.entry.norm, "abcqqqqqq");
  assertEquals(got?.sim, bruteSim("abcxyz", "abcqqq"));
});

function bruteSim(a: string, b: string): number {
  return trigramSimilarity(trigrams(a), trigrams(b));
}

Deno.test("nearestName equals the brute-force scan on every word of the golden corpus", async () => {
  const words = new Set<string>();
  for await (const f of Deno.readDir(`${KB_DIR}/../tests/golden/cases`)) {
    const text = await Deno.readTextFile(`${KB_DIR}/../tests/golden/cases/${f.name}`);
    for (const part of text.split(/[,;:()\[\]\n%.]+/)) {
      const n = normName(part);
      if (n.length >= 5 && n.length <= 60) words.add(n);
    }
  }
  for (const q of words) {
    const got = index.nearestName(q);
    assertEquals(got ? { norm: got.entry.norm, sim: got.sim } : null, bruteForce(q), q);
  }
});

Deno.test("nearestName equals the brute-force scan for queries at the window edges of real names", () => {
  // for a name of length N, a query of length L with |N - L| exactly the slack, and one past it
  let edges = 0;
  for (const n of index.names.filter((_, k) => k % 7 === 0)) {
    for (let L = 5; L <= 60; L++) {
      const slack = Math.max(4, L * 0.4);
      const d = Math.abs(n.norm.length - L);
      if (d !== slack && d !== Math.floor(slack) + 1) continue;
      const q = L <= n.norm.length ? n.norm.slice(0, L) : n.norm + "x".repeat(L - n.norm.length);
      if (normName(q) !== q || q.length !== L) continue;
      edges++;
      const got = index.nearestName(q);
      assertEquals(got ? { norm: got.entry.norm, sim: got.sim } : null, bruteForce(q), `${n.norm} / ${q}`);
    }
  }
  assert(edges > 200, `${edges} edge queries`);
});

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
