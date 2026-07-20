import assert from "node:assert/strict";
import test from "node:test";
import { aggregateStatus } from "../src/status/domain/aggregate.ts";
import { filterStatusByVisibility } from "../src/status/domain/visibility.ts";
import { getStatusResponse } from "../src/status/domain/service.ts";
import type { StatusModule, StatusResponse } from "../src/status/domain/types.ts";

const at = "2026-07-20T00:00:00.000Z";
const module = (status: StatusModule["status"], critical = true): StatusModule => ({ id: status, name: status, description: status, category: "runtime", status, summary: status, updatedAt: at, visibility: "public", critical, metrics: [], details: { kind: "runtime", runtime: { version: "x", lastDeploymentAt: at, lastSuccessfulCronAt: at, services: [] } } });
test("aggregate prioritizes critical health", () => { assert.equal(aggregateStatus([module("operational"), module("offline", false)], at).status, "operational"); assert.equal(aggregateStatus([module("operational"), module("degraded")], at).status, "degraded"); });
test("visibility retains public summaries and removes sensitive fields", () => { const response: StatusResponse = { overview: aggregateStatus([module("operational")], at), modules: [{ ...module("operational"), details: { kind: "agent", agents: [{ id: "a", name: "private", status: "operational", online: true, platform: "x", version: "x", lastHeartbeatAt: at, capabilities: ["shell"] }] } }], activities: [], generatedAt: at }; const filtered = filterStatusByVisibility(response, "public"); assert.equal(filtered.modules[0]?.details.kind, "agent"); assert.equal(filtered.modules[0]?.details.kind === "agent" && filtered.modules[0].details.agents[0]?.name, "Remote agent"); });
test("a failed provider becomes an unknown module", async () => { const response = await getStatusResponse([{ getStatus: async () => { throw new Error("failed"); } }]); assert.equal(response.modules[0]?.status, "unknown"); assert.equal(response.activities[0]?.type, "incident"); });
