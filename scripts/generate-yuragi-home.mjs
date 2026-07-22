import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileOutlines } from "@yuragi-labs/compiler";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const font = resolve(root, "node_modules/geist/dist/fonts/geist-sans/Geist-Variable.ttf");
const output = resolve(root, "src/generated/yuragi-home-outlines.json");
const titles = [
  "BUILDING",
  "OBSERVING",
  "EXPERIMENTING",
  "REMEMBERING",
  "welcome to zxlab!",
];

const bundle = await compileOutlines({
  font,
  axes: { wght: 500 },
  titles,
});

// Keep generated output deterministic and avoid encoding a local machine path.
bundle.font.source = "geist@1.7.2/Geist-Variable.ttf";
await writeFile(output, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
