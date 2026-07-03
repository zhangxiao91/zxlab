import test from "node:test";
import assert from "node:assert/strict";
import { normalizeUsage } from "./lib/normalize.mjs";

test("normalizes current App Server usage shapes", () => {
  const result = normalizeUsage({ rateLimitsByLimitId: { codex: {
    limitId: "codex", primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1780000000 },
    secondary: { usedPercent: 34, windowDurationMins: 10080, resetsAt: 1781000000 },
  } } }, { summary: { lifetimeTokens: 900, peakDailyTokens: 300 }, dailyUsageBuckets: [
    { startDate: "2026-07-03", tokens: 100 }, { startDate: "2026-07-01", tokens: 20 },
  ] }, new Date("2026-07-03T12:00:00Z"));
  assert.equal(result.limits[0].label, "5-hour window");
  assert.equal(result.tokenSummary.todayTokens, 100);
  assert.deepEqual(result.dailyUsage.map((item) => item.date), ["2026-07-01", "2026-07-03"]);
});

test("keeps unsupported optional values null and accepts empty history", () => {
  const result = normalizeUsage({ rateLimits: { limitId: "other", primary: {} } }, { summary: {}, dailyUsageBuckets: [] });
  assert.equal(result.limits[0].usedPercent, null);
  assert.equal(result.tokenSummary.lifetimeTokens, null);
  assert.deepEqual(result.dailyUsage, []);
});
