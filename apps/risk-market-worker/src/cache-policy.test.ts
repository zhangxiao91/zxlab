import assert from "node:assert/strict";
import test from "node:test";
import { projectCachedLoadResult } from "./cache-policy.ts";

test("projects quote cache hits without contradicting item quality", () => {
  const cases = [
    [{ quality: "live", stale: false }, "operational", "cached", "operational", "fresh"],
    [{ quality: "live", stale: false }, "degraded", "cached", "degraded", "fresh"],
    [{ quality: "stale", stale: true }, "operational", "stale", "degraded", "stale"],
    [{ quality: "conflicted", stale: false }, "operational", "conflicted", "degraded", "fresh"],
    [{ quality: "unavailable", stale: true }, "operational", "unavailable", "unavailable", "unknown"],
  ] as const;

  const observed = cases.map(([item, originStatus]) => {
    const projected = projectCachedLoadResult({
      data: [item],
      meta: { capability: "quote", capabilityStatus: originStatus, freshness: "fresh" },
    });
    return [projected.data[0]?.quality, projected.meta.capabilityStatus, projected.meta.freshness];
  });

  assert.deepEqual(observed, cases.map(([, , quality, status, freshness]) => [quality, status, freshness]));
});
