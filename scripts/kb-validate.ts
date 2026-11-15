// deno task kb:validate — schema + cross-reference check of kb/. Exit 1 on any error.
import { readKb } from "../src/kb/read.ts";

const root = new URL("../kb", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const { bundle, errors, warnings } = await readKb(root);
for (const w of warnings) console.warn(`warn  ${w}`);
for (const e of errors) console.error(`ERROR ${e}`);
if (bundle) {
  const variants = bundle.ingredients.reduce((n, i) => n + (i.variants?.length ?? 0), 0);
  const assertions = bundle.ingredients.reduce((n, i) => n + (i.assertions?.length ?? 0), 0);
  console.log(
    `${bundle.version}: ${bundle.counts.curated} curated + ${bundle.counts.generated} generated ingredients ` +
      `(${bundle.counts.superseded} generated superseded), ${variants} variants, ${assertions} assertions, ` +
      `${bundle.implications.length} implication codes, ${bundle.classes.length} classes, ${bundle.sources.length} sources; ` +
      `${warnings.length} warnings`,
  );
}
if (errors.length) Deno.exit(1);
