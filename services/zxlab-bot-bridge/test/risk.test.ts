import test from "node:test";
import assert from "node:assert/strict";
import { calculateRiskSnapshot, parseRiskReview } from "../src/risk.js";

test("stale quote makes the snapshot explicitly unreliable", () => {
  const snapshot = calculateRiskSnapshot({
    cash: 1_000,
    positions: [{
      instrumentId: "SSE:510300",
      quantity: 1_000,
      leverageMultiplier: 1,
      themes: ["大盘"],
    }],
    quotes: [{
      instrumentId: "SSE:510300",
      price: 4.7,
      previousClose: 4.8,
      marketTimestamp: "2026-07-24T15:00:00+08:00",
      receivedAt: "2026-07-25T00:00:00Z",
      source: "tencent-qt",
      quality: "stale",
      stale: true,
      warnings: ["报价已过期"],
    }],
  });
  assert.equal(snapshot.reliable, false);
  assert.equal(snapshot.positions[0]?.reliable, false);
  assert.ok(snapshot.events.some((event) => event.id === "risk:data-unreliable:SSE:510300"));
  assert.match(snapshot.warnings.join(" "), /行情不新鲜/);
});

test("calculates effective exposure, concentration and drawdown from supplied evidence", () => {
  const snapshot = calculateRiskSnapshot({
    cash: 1_000,
    positions: [{
      instrumentId: "SSE:510300",
      quantity: 1_000,
      leverageMultiplier: 2,
      themes: ["大盘"],
    }],
    quotes: [{
      instrumentId: "SSE:510300",
      price: 9,
      previousClose: 10,
      marketTimestamp: "2026-07-25T14:00:00+08:00",
      receivedAt: "2026-07-25T14:00:01+08:00",
      source: "tencent-qt",
      quality: "live",
      stale: false,
      warnings: [],
    }],
    history: [{ date: "2026-07-24", value: 12_000 }],
  });
  assert.equal(snapshot.reliable, true);
  assert.equal(snapshot.portfolio.netValue, 10_000);
  assert.equal(snapshot.portfolio.effectiveExposure, 1.8);
  assert.equal(snapshot.portfolio.currentDrawdown, -0.166667);
  assert.ok(snapshot.events.some((event) => event.id === "risk:effective-exposure"));
});

test("rejects Risk review citations that are not in the snapshot", () => {
  assert.throws(() => parseRiskReview({
    summary: "test",
    mainRisks: [{ title: "x", explanation: "y", severity: "high", evidenceIds: ["invented"] }],
    unknowns: [],
    limitations: [],
  }, new Set(["quote:SSE:510300:t1"])), /unknown evidence/);
});
