import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileOutlines } from "@yuragi-labs/compiler";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const font = resolve(root, "src/assets/fonts/Geist-Variable.ttf");
const output = resolve(root, "src/generated/yuragi-outlines.json");
const titles = [
  "BUILDING",
  "OBSERVING",
  "EXPERIMENTING",
  "REMEMBERING",
  "welcome to zxlab!",
  "LAB",
  "PROJECTS",
  "NOTES",
  "SIGNAL",
  "OilShield",
  "Long-memo",
  "ZXLab",
  "Building ZXLab by hand",
];

const bundle = await compileOutlines({
  font,
  axes: { wght: 500 },
  titles,
});

// Yuragi v0.1 fixes scatter distance at 100px. Scaling its deterministic
// outline vectors gives the brand transition a clearer 180px directional exit.
for (const outline of Object.values(bundle.outlines)) {
  for (const group of outline?.groups ?? []) {
    for (const glyph of group.glyphs) {
      for (const shard of glyph.shards) {
        shard.direction = [shard.direction[0] * 1.8, shard.direction[1] * 1.8];
      }
    }
  }
}

// Keep generated output deterministic and avoid encoding a local machine path.
bundle.font.source = "src/assets/fonts/Geist-Variable.ttf";
await writeFile(output, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
