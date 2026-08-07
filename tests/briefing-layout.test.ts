import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const pageSource = new URL("../src/pages/briefing.astro", import.meta.url);
const styleSource = new URL("../src/styles/briefing.css", import.meta.url);

test("lead briefing heading remains in flow before the desktop reading columns become tight", async () => {
  const [page, styles] = await Promise.all([
    readFile(pageSource, "utf8"),
    readFile(styleSource, "utf8"),
  ]);

  assert.doesNotMatch(page, /pin:\s*leadHeader/);
  assert.match(
    styles,
    /@media \(max-width: 78rem\)\s*\{[\s\S]*?\.signal-item--lead\s*\{[\s\S]*?grid-template-columns:\s*1fr;/,
  );
});
