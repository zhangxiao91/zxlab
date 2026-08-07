import assert from "node:assert/strict";
import test from "node:test";
import { decideScheduledWorkflow, scheduledWorkflowAt } from "./schedule.ts";

test("only opens the 08:45 morning and 15:20 close schedule windows in Shanghai", () => {
  assert.equal(scheduledWorkflowAt(new Date("2026-08-03T00:45:00.000Z")), "morning_brief");
  assert.equal(scheduledWorkflowAt(new Date("2026-08-03T07:20:00.000Z")), "close_review");
  assert.equal(scheduledWorkflowAt(new Date("2026-08-03T07:15:00.000Z")), null);
});

test("calendar decisions distinguish market closure from unavailable calendar", async () => {
  const holiday = await decideScheduledWorkflow("morning_brief", new Date("2026-10-05T00:45:00.000Z"), { getMarketDay: async () => ({ status: "holiday", source: "official", reliable: true, warnings: [] }) });
  const unknown = await decideScheduledWorkflow("close_review", new Date("2027-01-04T07:20:00.000Z"), { getMarketDay: async () => ({ status: "unknown", source: "fallback", reliable: false, warnings: ["coverage missing"] }) });
  assert.equal(holiday.decision, "skipped");
  assert.equal(unknown.decision, "blocked");
});
