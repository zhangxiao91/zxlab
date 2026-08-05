import assert from "node:assert/strict";
import test from "node:test";
import { calculateRiskImpact } from "./index.ts";

test("calculates deterministic portfolio impact and concentration", () => {
  const result = calculateRiskImpact([
    { instrumentId: "SSE:600000", quantity: 100, averageCost: 10, lastPrice: 12 },
    { instrumentId: "SZSE:000001", quantity: 50, averageCost: 20, lastPrice: 18 }
  ]);
  assert.equal(result.marketValue, 2100);
  assert.equal(result.unrealizedPnl, 100);
  assert.deepEqual(result.concentration.map((item) => item.instrumentId), ["SSE:600000", "SZSE:000001"]);
});
