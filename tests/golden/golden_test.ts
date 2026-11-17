// The golden corpus gate: realistic labels scored against the real knowledge base.
import { assert, assertEquals } from "@std/assert";
import { analyze } from "../../src/core/analyze.ts";
import { KbIndex } from "../../src/core/kb-index.ts";
import { readKb } from "../../src/kb/read.ts";
import { KB_DIR } from "../helpers.ts";
import { gateFailures, readGolden, scoreGolden, type Thresholds, THRESHOLDS_FILE } from "./score.ts";

const { bundle, errors } = await readKb(KB_DIR);
const cases = await readGolden();

Deno.test("golden corpus is large enough to mean something", () => {
  assert(cases.length >= 30, `${cases.length} cases`);
  for (const lang of ["pl", "en", "de"]) assert(cases.some((c) => c.lang === lang), `no ${lang} case`);
  assert(cases.filter((c) => c.category === "protein_powder").length >= 6, "protein powders are the wedge");
});

Deno.test("a worst-case request stays inside its CPU budget", () => {
  // 12 kB of unknown words: each pays for fuzzy matching. The indexed matcher does this in ~15 ms; the
  // linear scan it replaced took ~450 ms, which let one key hold half a core at its rate limit.
  let text = "Składniki: ";
  for (let i = 0; text.length < 11_900; i++) text += `nieznany skladnik ${i.toString(36)}qx, `;
  const index = new KbIndex(bundle!);
  // and one 12 kB item of repeated claims: the exact-name guard must not grow with claims × spans (Sol 6.1, #13)
  for (const t of [text, "Ingredients: " + "non hydrogenated ".repeat(700)]) {
    const times = [0, 1, 2].map(() => {
      const t0 = performance.now();
      analyze(index, t);
      return performance.now() - t0;
    });
    const best = Math.min(...times);
    assert(best < 150, `worst case took ${best.toFixed(0)} ms: ${t.slice(0, 40)}…`);
  }
});

Deno.test("golden corpus meets the quality floors", async () => {
  assertEquals(errors, []);
  const report = scoreGolden(new KbIndex(bundle!), cases);
  const th: Thresholds = JSON.parse(await Deno.readTextFile(THRESHOLDS_FILE));
  const failures = gateFailures(report.metrics, th);
  const detail = report.cases.filter((c) => c.problems.length).map((c) =>
    `  ${c.id}\n    ${c.problems.join("\n    ")}`
  );
  assertEquals(
    failures,
    [],
    `\n${failures.join("\n")}\n\nrun deno task test:golden for the full report\n${detail.join("\n")}`,
  );
});
