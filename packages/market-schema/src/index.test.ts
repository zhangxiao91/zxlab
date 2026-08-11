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

test("keeps fresh cached transport provenance operational", () => {
  const snapshot = marketSnapshotFixture("cached");
  assert.equal(snapshot.capabilities[0]?.status, "operational");
  assert.equal(snapshot.quality.status, "operational");
  assert.equal(snapshot.quality.freshness, "fresh");
  assert.equal(snapshot.quality.reliable, true);
});

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

test("rejects contradictory quote freshness metadata", () => {
  const liveButStale = marketSnapshotFixture("live");
  liveButStale.data.quotes[0].stale = true;

  const result = validateMarketSnapshot(liveButStale);
  assert.equal(result.ok, false);
  assert.match(result.issues.join(" "), /live quality cannot be stale/);
});

test("rejects an open market with a closed session", () => {
  const snapshot = marketSnapshotFixture();
  snapshot.data.status[0].session = "closed";

  const result = validateMarketSnapshot(snapshot);
  assert.equal(result.ok, false);
  assert.match(result.issues.join(" "), /open true requires session open/);
});

test("rejects an operational snapshot missing a requested capability", () => {
  const snapshot = marketSnapshotFixture();
  snapshot.capabilities = [];

  const result = validateMarketSnapshot(snapshot);
  assert.equal(result.ok, false);
  assert.match(result.issues.join(" "), /missing required requested capability quotes/);
});

test("rejects optimistic aggregate quality when a required capability is unavailable", () => {
  const snapshot = marketSnapshotFixture("unavailable");
  snapshot.quality.status = "operational";
  snapshot.quality.reliable = true;
  snapshot.quality.freshness = "fresh";
  snapshot.quality.unavailableCapabilities = [];

  const result = validateMarketSnapshot(snapshot);
  const issues = result.issues.join(" ");
  assert.equal(result.ok, false);
  assert.match(issues, /quality.status cannot be operational/);
  assert.match(issues, /quality.reliable cannot be true/);
  assert.match(issues, /quality.freshness cannot be fresh/);
  assert.match(issues, /unavailableCapabilities must include quotes/);
});

test("rejects reliable fresh aggregate quality when a required capability is stale", () => {
  const snapshot = marketSnapshotFixture("stale");
  snapshot.quality.reliable = true;
  snapshot.quality.freshness = "fresh";

  const result = validateMarketSnapshot(snapshot);
  const issues = result.issues.join(" ");
  assert.equal(result.ok, false);
  assert.match(issues, /quality.reliable cannot be true with required stale capabilities: quotes/);
  assert.match(issues, /quality.freshness must be stale when required capabilities are stale: quotes/);
});

test("requires two independent providers before claiming corroboration", () => {
  const snapshot = marketSnapshotFixture();
  snapshot.data.quotes[0].corroboration.observations = [snapshot.data.quotes[0].corroboration.observations[0]];

  const result = validateMarketSnapshot(snapshot);
  assert.equal(result.ok, false);
  assert.match(result.issues.join(" "), /corroborated status requires observations from at least two providers/);
});

test("keeps fallback diagnostics separate from corroboration evidence", () => {
  const snapshot = marketSnapshotFixture();
  snapshot.request.quoteMode = "fallback";
  snapshot.data.quotes[0].corroboration.mode = "fallback";
  snapshot.data.quotes[0].corroboration.status = "not_requested";

  const result = validateMarketSnapshot(snapshot);
  const issues = result.issues.join(" ");
  assert.equal(result.ok, false);
  assert.match(issues, /not_requested status requires no observations/);
  assert.match(issues, /not_requested status requires maxDeviationBps null/);
});

test("rejects corroborated quotes whose deviation exceeds the conflict threshold", () => {
  const snapshot = marketSnapshotFixture();
  snapshot.data.quotes[0].corroboration.maxDeviationBps = 60;

  const result = validateMarketSnapshot(snapshot);
  assert.equal(result.ok, false);
  assert.match(result.issues.join(" "), /corroborated status requires maxDeviationBps at or below thresholdBps/);
});

test("requires an above-threshold deviation before claiming a quote conflict", () => {
  const snapshot = marketSnapshotFixture("conflicted");
  snapshot.data.quotes[0].corroboration.maxDeviationBps = 40;

  const result = validateMarketSnapshot(snapshot);
  assert.equal(result.ok, false);
  assert.match(result.issues.join(" "), /conflicted status requires maxDeviationBps above thresholdBps/);
});

test("keeps limited corroboration limited to fewer than two providers", () => {
  const snapshot = marketSnapshotFixture();
  snapshot.data.quotes[0].corroboration.status = "limited";

  const result = validateMarketSnapshot(snapshot);
  const issues = result.issues.join(" ");
  assert.equal(result.ok, false);
  assert.match(issues, /limited status requires observations from fewer than two providers/);
  assert.match(issues, /limited status requires maxDeviationBps null/);
});

test("requires the open flag to agree with open and unknown sessions", () => {
  const closedWhileOpen = marketSnapshotFixture();
  closedWhileOpen.data.status[0].open = false;
  assert.match(validateMarketSnapshot(closedWhileOpen).issues.join(" "), /session open requires open true/);

  const knownWhileUnknown = marketSnapshotFixture();
  knownWhileUnknown.data.status[0].session = "unknown";
  knownWhileUnknown.data.status[0].open = false;
  assert.match(validateMarketSnapshot(knownWhileUnknown).issues.join(" "), /session unknown requires open null/);
});
