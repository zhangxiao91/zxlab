import assert from "node:assert/strict";
import { asStaleUsage, sanitizeCodexUsage, fetchCodexUsage } from "../functions/_lib/codex-usage.ts";
import { buildHeatmap, intensityThresholds, sortDailyUsage, usageIntensity } from "../src/status/usage-utils.ts";

const base = {
  status: "online",
  updatedAt: "2026-07-03T12:00:00.000Z",
  limits: [{ id: "codex:primary", label: "5-hour window", usedPercent: 20, windowMinutes: 300, resetsAt: null }],
  tokenSummary: { lifetimeTokens: 1000, todayTokens: null, peakDailyTokens: 900, currentStreakDays: null, longestStreakDays: null },
  dailyUsage: [{ date: "2026-07-03", tokens: 900 }, { date: "2026-07-01", tokens: 10 }],
};

const sanitized = sanitizeCodexUsage(base);
assert.deepEqual(sanitized.dailyUsage.map((point) => point.date), ["2026-07-01", "2026-07-03"]);
assert.equal(sanitizeCodexUsage({ ...base, limits: [], tokenSummary: {}, dailyUsage: [] }).tokenSummary.lifetimeTokens, null);
assert.deepEqual(sortDailyUsage(base.dailyUsage), [{ date: "2026-07-01", tokens: 10 }, { date: "2026-07-03", tokens: 900 }]);

const extreme = Array.from({ length: 30 }, (_, index) => ({ date: `2026-06-${String(index + 1).padStart(2, "0")}`, tokens: index === 29 ? 10_000_000 : index * 100 }));
const thresholds = intensityThresholds(extreme);
assert.equal(usageIntensity(10_000_000, thresholds), 4);
assert.ok(usageIntensity(500, thresholds) > 0);
const heatmap = buildHeatmap(base.dailyUsage);
assert.ok(heatmap.some((day) => day.tokens === null));
assert.ok(heatmap.some((day) => day.tokens === 10));

for (const status of [401, 403, 500]) {
  await assert.rejects(() => fetchCodexUsage(
    { CODEX_USAGE_API_URL: "https://collector.example", CODEX_USAGE_API_TOKEN: "test" },
    async () => new Response("{}", { status }),
  ));
}

await assert.rejects(() => fetchCodexUsage(
  { CODEX_USAGE_API_URL: "https://collector.example", CODEX_USAGE_API_TOKEN: "test", CODEX_USAGE_REQUEST_TIMEOUT: "0.001" },
  async (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  }),
));

const stale = asStaleUsage(sanitizeCodexUsage(base));
assert.equal(stale.status, "stale");
process.stdout.write("Status usage verification passed.\n");
