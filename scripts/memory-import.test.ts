import assert from "node:assert/strict";
import test from "node:test";
import { parseMemoryManifest, planMemoryImport, type RemoteMemory } from "./memory-import-core.ts";

const manifestSource = `
metadata:
  profile_name: sample
  version: "1.0"
  updated_at: "2026-07-30"
memories:
  - namespace: global
    kind: preference
    content: "先给结论，再解释原因。"
    importance: 0.9
    confidence: 0.95
`;

test("parses a reviewed manifest and derives stable source metadata", () => {
  const manifest = parseMemoryManifest(manifestSource);
  assert.equal(manifest.memories.length, 1);
  assert.deepEqual(manifest.memories[0], {
    namespace: "global",
    kind: "preference",
    content: "先给结论，再解释原因。",
    importance: 0.9,
    confidence: 0.95,
    sourceType: "user_import",
    sourceId: "sample:1.0:2026-07-30",
  });
});

test("rejects duplicate manifest entries after whitespace normalization", () => {
  assert.throws(() => parseMemoryManifest(`${manifestSource}
  - namespace: global
    kind: preference
    content: "先给结论，  再解释原因。"
    importance: 0.9
    confidence: 0.95
`), /duplicates/);
});

test("plans metadata repair instead of creating a duplicate", () => {
  const desired = parseMemoryManifest(manifestSource).memories;
  const remote: RemoteMemory[] = [{
    id: "existing",
    ...desired[0]!,
    importance: 0.7,
    confidence: 0.8,
    sourceType: "ops-console",
    sourceId: "",
    status: "active",
  }];
  const plan = planMemoryImport(desired, remote);
  assert.equal(plan[0]?.action, "update");
  assert.deepEqual(plan[0]?.changes, ["importance", "confidence", "sourceType", "sourceId"]);
});

test("skips exact matches and creates missing content", () => {
  const desired = parseMemoryManifest(manifestSource).memories;
  const exact: RemoteMemory = { id: "existing", ...desired[0]!, status: "active" };
  assert.equal(planMemoryImport(desired, [exact])[0]?.action, "skip");
  assert.equal(planMemoryImport(desired, [])[0]?.action, "create");
});
