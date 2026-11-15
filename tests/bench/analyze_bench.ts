// deno task bench — analysis and search latency against the real knowledge base.
import { analyze } from "../../src/core/analyze.ts";
import { KbIndex } from "../../src/core/kb-index.ts";
import { readKb } from "../../src/kb/read.ts";
import { KB_DIR } from "../helpers.ts";
import { readGolden } from "../golden/score.ts";

const { bundle } = await readKb(KB_DIR);
const index = new KbIndex(bundle!);
const cases = await readGolden();
const longest = cases.reduce((a, b) => (b.text.length > a.text.length ? b : a));
// Worst case inside the 12,000-character request limit: every item unknown, so every item pays for the
// fuzzy scan over all names. (Repeating a real label would not do: only its first "Składniki:" block counts.)
let huge = "Składniki: ";
for (let i = 0; huge.length < 11_900; i++) huge += `nieznany skladnik ${i.toString(36)}qx, `;

Deno.bench("analyze: typical protein powder label", { group: "analyze", baseline: true }, () => {
  analyze(index, cases[0].text, { lang: cases[0].lang });
});
Deno.bench(`analyze: longest golden label (${longest.text.length} chars)`, { group: "analyze" }, () => {
  analyze(index, longest.text, { lang: longest.lang });
});
Deno.bench(`analyze: request-limit worst case (${huge.length} chars)`, { group: "analyze" }, () => {
  analyze(index, huge);
});
Deno.bench("analyze: all golden labels", { group: "corpus" }, () => {
  for (const c of cases) analyze(index, c.text, { lang: c.lang });
});
Deno.bench("search: 'kwas jab' prefix", { group: "search" }, () => {
  index.search("kwas jab");
});
Deno.bench("search: fuzzy typo 'sukralosa'", { group: "search" }, () => {
  index.search("sukralosa");
});
