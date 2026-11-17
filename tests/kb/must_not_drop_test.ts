// An exclusion drops only what it excludes, never the allergen of the food it names (pc-opus on #10 and #16). Run on
// the real knowledge base, so a KB batch that adds claim names or variants is held to it too.
import { assert } from "@std/assert";
import { analyze } from "../../src/core/analyze.ts";
import { KbIndex } from "../../src/core/kb-index.ts";
import { readKb } from "../../src/kb/read.ts";
import { KB_DIR } from "../helpers.ts";

const { bundle } = await readKb(KB_DIR);
const index = new KbIndex(bundle!);
const RANK: Record<string, number> = { yes: 2, maybe: 1 };

const CONTROLS: [form: string, code: string, floor: "yes" | "maybe", why: string][] = [
  [
    "lactose-free milk",
    "allergen.milk",
    "yes",
    "lactose is not the milk allergen; milk protein is (Annex II 7)",
  ],
  [
    "mleko bez laktozy",
    "allergen.milk",
    "yes",
    "lactose is not the milk allergen; milk protein is (Annex II 7)",
  ],
  [
    "gluten-free wheat starch",
    "allergen.gluten",
    "maybe",
    "the wheat is still there; Annex II 1(a) is glucose syrups",
  ],
  [
    "skrobia pszenna bezglutenowa",
    "allergen.gluten",
    "maybe",
    "the wheat is still there; Annex II 1(a) is glucose syrups",
  ],
  ["egg-white-free egg yolk", "allergen.eggs", "yes", "the yolk is egg (Annex II 3)"],
  [
    "soy-free soybean oil",
    "allergen.soybeans",
    "maybe",
    "a contradictory label names soybean oil (Annex II 6)",
  ],
];

Deno.test("an exclusion never drops the allergen of the food it names", () => {
  for (const [form, code, floor, why] of CONTROLS) {
    for (const text of [form, `chocolate (${form})`, `czekolada (${form})`]) {
      const got = analyze(index, text, { lang: "pl" }).flags.find((f) => f.code === code)?.certainty;
      assert(
        (RANK[got ?? ""] ?? 0) >= RANK[floor],
        `${text}: ${code} ${got ?? "-"}, want at least ${floor} (${why})`,
      );
    }
  }
});
