// Validates kb/ and writes dist/kb-bundle.json, the knowledge base the Cloudflare Worker imports.
// Part of `deno task build:worker`; refuses to write a bundle from an invalid KB.
import { readKb } from "../src/kb/read.ts";

const { bundle, errors } = await readKb("kb");
if (!bundle) {
  console.error(`Knowledge base is invalid:\n${errors.join("\n")}`);
  Deno.exit(1);
}
await Deno.mkdir("dist", { recursive: true });
const json = JSON.stringify(bundle);
await Deno.writeTextFile("dist/kb-bundle.json", json);
console.log(
  `dist/kb-bundle.json: ${bundle.version}, ${bundle.ingredients.length} ingredients, ${
    Math.round(json.length / 1024)
  } KiB`,
);
