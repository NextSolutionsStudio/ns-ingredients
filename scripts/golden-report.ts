// Readable golden-corpus report: metrics, ratchet hints and every open problem per case.
//   deno task test:golden            report (exit 1 below the floors)
//   deno task test:golden --case=ID  also print the analysis of one case
import { parseArgs } from "@std/cli/parse-args";
import { fromFileUrl } from "@std/path";
import { KbIndex } from "../src/core/kb-index.ts";
import { readKb } from "../src/kb/read.ts";
import {
  gateFailures,
  readGolden,
  scoreGolden,
  type Thresholds,
  THRESHOLDS_FILE,
} from "../tests/golden/score.ts";

const args = parseArgs(Deno.args, { string: ["case", "kb"] });
const { bundle, errors } = await readKb(args.kb ?? fromFileUrl(new URL("../kb", import.meta.url)));
if (!bundle) {
  console.error(`knowledge base has ${errors.length} error(s); run deno task kb:validate`);
  Deno.exit(1);
}
const cases = await readGolden();
const report = scoreGolden(new KbIndex(bundle), cases);
const th: Thresholds = JSON.parse(await Deno.readTextFile(THRESHOLDS_FILE));

console.log(`golden corpus: ${cases.length} labels, KB ${bundle.version}\n`);
console.log("metric".padEnd(22), "value".padStart(7), "count".padStart(9), "floor".padStart(7));
for (const [k, v] of Object.entries(report.metrics) as [keyof Thresholds, number][]) {
  const n = report.counts[k];
  const shown = k === "false_flags" ? String(v) : v.toFixed(3);
  const hint = k !== "false_flags" && v > th[k] + 0.005
    ? `  ← floor can rise to ${Math.floor(v * 100) / 100}`
    : "";
  console.log(
    k.padEnd(22),
    shown.padStart(7),
    `${n.ok}/${n.total}`.padStart(9),
    String(th[k]).padStart(7),
    hint,
  );
}

const open = report.cases.filter((c) => c.problems.length);
console.log(`\n${open.length} of ${cases.length} labels have open problems`);
for (const c of open) console.log(`\n${c.id}\n  ${c.problems.join("\n  ")}`);

if (args.case) {
  const one = report.cases.find((c) => c.id === args.case);
  console.log(one ? JSON.stringify(one.result, null, 2) : `no case ${args.case}`);
}

const failures = gateFailures(report.metrics, th);
if (failures.length) {
  console.error(`\nBELOW FLOOR:\n  ${failures.join("\n  ")}`);
  Deno.exit(1);
}
