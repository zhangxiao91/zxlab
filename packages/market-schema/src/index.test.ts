import assert from "node:assert/strict";
import test from "node:test";
import { marketSnapshotFixture } from "./fixtures.ts";
import { parseMarketSnapshot, validateMarketSnapshot } from "./index.ts";

for (const quality of ["live", "cached", "stale", "conflicted", "unavailable"] as const) {
  test(`validates the ${quality} MarketSnapshot fixture`, () => {
    const snapshot = marketSnapshotFixture(quality);
    assert.equal(validateMarketSnapshot(snapshot).ok, true);
    assert.equal(parseMarketSnapshot(snapshot).data.quotes[0]?.quality, quality);
  });
}

test("rejects incomplete capability and time metadata", () => {
  const snapshot = marketSnapshotFixture();
  const invalid = { ...snapshot, receivedAt: "not-a-date", capabilities: [{ id: "quotes" }] };
  const result = validateMarketSnapshot(invalid);
  assert.equal(result.ok, false);
  assert.match(result.issues.join(" "), /receivedAt/);
  assert.match(result.issues.join(" "), /capabilities\[0\]\.status/);
});

test("requires explicit corroboration that matches the requested quote mode", () => {
  const fallback = marketSnapshotFixture();
  fallback.request.quoteMode = "fallback";
  fallback.data.quotes[0].corroboration = { mode: "fallback", status: "not_requested", thresholdBps: 50, maxDeviationBps: null, observations: [] };
  assert.equal(validateMarketSnapshot(fallback).ok, true);

  const missing = marketSnapshotFixture();
  const { corroboration: _corroboration, ...quoteWithoutCorroboration } = missing.data.quotes[0];
  missing.data.quotes = [quoteWithoutCorroboration as typeof missing.data.quotes[0]];
  assert.match(validateMarketSnapshot(missing).issues.join(" "), /corroboration is required/);

  const mismatched = marketSnapshotFixture();
  mismatched.request.quoteMode = "fallback";
  assert.match(validateMarketSnapshot(mismatched).issues.join(" "), /must match request.quoteMode/);
});
