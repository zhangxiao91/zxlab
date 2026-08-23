import assert from "node:assert/strict";
import test from "node:test";
import { calculateResearchFactBundleFingerprint, parseResearchFactBundle, type ResearchFactBundle } from "@zxlab/research-fact-schema";
import { MemoryFinancialToolInvocationRepository } from "./financial-tool-repository.ts";
import { FinancialToolRuntime, FinancialToolRuntimeError } from "./financial-tool-runtime.ts";

const snapshotAsOf = "2026-08-23T01:00:00.000Z";

async function companyUpdateBundle(status: "operational" | "degraded" | "unavailable" = "operational"): Promise<ResearchFactBundle> {
  const fact = {
    id: "financial:SSE:600000:operating_revenue:2025-12-31:reported",
    kind: "financial_metric" as const,
    subjectId: "SSE:600000",
    metric: "operating_revenue" as const,
    period: { start: "2025-01-01T00:00:00.000Z", end: "2025-12-31T00:00:00.000Z", basis: "fiscal_year" as const },
    value: { decimal: "100000000", unit: "CNY" as const },
    provenance: { providers: ["fixture"], sourceArtifactIds: ["artifact:financial:1"], sourceAsOf: "2026-04-01T00:00:00.000Z", retrievedAt: snapshotAsOf },
    quality: { status: status === "degraded" ? "degraded" as const : "operational" as const, reliable: status !== "degraded", coverage: { actual: 1, required: 1 }, warnings: status === "degraded" ? ["OFFICIAL_FILING_UNCORROBORATED"] : [] },
  };
  const facts = status === "unavailable" ? [] : [fact];
  const unsigned: Omit<ResearchFactBundle, "fingerprint"> = {
    schemaVersion: "research-facts.v2",
    planVersion: "company-update.v1",
    purpose: "company_update",
    observationCutoff: snapshotAsOf,
    knowledgeCutoff: snapshotAsOf,
    generatedAt: snapshotAsOf,
    instrumentIds: ["SSE:600000"],
    facts,
    capabilities: [{
      id: "fundamentals",
      required: true,
      status,
      factIds: facts.map((item) => item.id),
      asOf: status === "unavailable" ? null : snapshotAsOf,
      retrievedAt: snapshotAsOf,
      warnings: status === "operational" ? [] : ["ARTIFACT_STORE_UNAVAILABLE"],
      limitations: status === "operational" ? [] : [{ code: "ARTIFACT_STORE_UNAVAILABLE", retryable: true }],
      ...(status === "unavailable" ? { error: { code: "ARTIFACT_STORE_UNAVAILABLE", retryable: true } } : {}),
    }],
  };
  return parseResearchFactBundle({ ...unsigned, fingerprint: await calculateResearchFactBundleFingerprint(unsigned) });
}

function input(attempt = 1) {
  return {
    runId: "run-financial-tool-1",
    profileId: "profile-1",
    attempt,
    scope: "news_and_announcements" as const,
    selectedInstrumentId: "SSE:600000",
    snapshotAsOf,
    question: "重点看财务变化",
  };
}

test("financial runtime executes one model-selected tool and reuses its immutable result", async () => {
  const repository = new MemoryFinancialToolInvocationRepository();
  const research = await companyUpdateBundle("operational");
  let plannerCalls = 0;
  let researchCalls = 0;
  const runtime = new FinancialToolRuntime({
    repository,
    planner: { async plan() { plannerCalls += 1; return { decision: "invoke", tool: "company_financial_update.v1", selection: { provider: "deepseek", model: "deepseek-chat", fallbackIndex: 0, gatewayRequestId: "gateway-1" } }; } },
    research: { async materialize(request) {
      researchCalls += 1;
      assert.deepEqual(request, {
        purpose: "company_update",
        instrumentIds: ["SSE:600000"],
        selectedInstrumentId: "SSE:600000",
        observationCutoff: snapshotAsOf,
      });
      return research;
    } },
    now: sequenceNow([
      "2026-08-23T01:00:00.000Z",
      "2026-08-23T01:00:00.010Z",
      "2026-08-23T01:00:01.510Z",
    ]),
  });

  const first = await runtime.execute(input(), {});
  const resumed = await runtime.execute(input(2), {});

  assert.equal(first.session.status, "completed");
  assert.equal(first.session.selectionSource, "model");
  assert.equal(first.research?.fingerprint, research.fingerprint);
  assert.deepEqual(resumed, first);
  assert.equal(plannerCalls, 1);
  assert.equal(researchCalls, 1);
});

test("financial runtime seals a valid model skip without Research I/O", async () => {
  let researchCalls = 0;
  const runtime = new FinancialToolRuntime({
    repository: new MemoryFinancialToolInvocationRepository(),
    planner: { async plan() { return { decision: "skip", selection: { provider: "deepseek", model: "deepseek-chat", fallbackIndex: 0, gatewayRequestId: "gateway-2" } }; } },
    research: { async materialize() { researchCalls += 1; return companyUpdateBundle(); } },
    now: () => "2026-08-23T01:00:00.000Z",
  });

  const result = await runtime.execute(input(), {});

  assert.equal(result.session.status, "skipped");
  assert.equal(result.research, undefined);
  assert.equal(researchCalls, 0);
});

test("financial runtime falls back to the fixed read-only tool when planning fails", async () => {
  const research = await companyUpdateBundle("degraded");
  const runtime = new FinancialToolRuntime({
    repository: new MemoryFinancialToolInvocationRepository(),
    planner: { async plan() { throw new Error("gateway detail"); } },
    research: { async materialize() { return research; } },
    now: sequenceNow([
      "2026-08-23T01:00:00.000Z",
      "2026-08-23T01:00:00.010Z",
      "2026-08-23T01:00:01.000Z",
    ]),
  });

  const result = await runtime.execute(input(), {});

  assert.equal(result.session.status, "completed");
  assert.equal(result.session.selectionSource, "policy_fallback");
  if (result.session.status === "completed") assert.equal(result.session.execution.outcome, "partial");
});

test("financial runtime checks cancellation before Planner I/O", async () => {
  let plannerCalls = 0;
  let researchCalls = 0;
  const runtime = new FinancialToolRuntime({
    repository: new MemoryFinancialToolInvocationRepository(),
    planner: { async plan() { plannerCalls += 1; return { decision: "skip", selection: { provider: "fixture", model: "fixture", fallbackIndex: 0, gatewayRequestId: "gateway-cancelled" } }; } },
    research: { async materialize() { researchCalls += 1; return companyUpdateBundle(); } },
  });

  await assert.rejects(
    runtime.execute(input(), { assertActive: async () => { throw new Error("RUN_CANCELLED"); } }),
    (error: unknown) => error instanceof FinancialToolRuntimeError
      && error.code === "RUN_CANCELLED"
      && !error.retryable,
  );
  assert.equal(plannerCalls, 0);
  assert.equal(researchCalls, 0);
});

test("financial runtime classifies its bounded deadline as retryable", async () => {
  const runtime = new FinancialToolRuntime({
    repository: new MemoryFinancialToolInvocationRepository(),
    planner: { async plan() { return { decision: "invoke", tool: "company_financial_update.v1", selection: { provider: "fixture", model: "fixture", fallbackIndex: 0, gatewayRequestId: "gateway-timeout" } }; } },
    research: { async materialize() { return new Promise<ResearchFactBundle>(() => {}); } },
  });

  await assert.rejects(
    runtime.execute(input(), { deadlineAt: Date.now() + 5 }),
    (error: unknown) => error instanceof FinancialToolRuntimeError
      && error.code === "FINANCIAL_TOOL_TIMEOUT"
      && error.retryable,
  );
});

test("an expired tool deadline fences Research provider I/O", async () => {
  let researchCalls = 0;
  const runtime = new FinancialToolRuntime({
    repository: new MemoryFinancialToolInvocationRepository(),
    planner: { async plan() { return { decision: "invoke", tool: "company_financial_update.v1", selection: { provider: "fixture", model: "fixture", fallbackIndex: 0, gatewayRequestId: "gateway-expired" } }; } },
    research: { async materialize() { researchCalls += 1; return companyUpdateBundle(); } },
  });

  await assert.rejects(
    runtime.execute(input(), { deadlineAt: Date.now() - 1 }),
    (error: unknown) => error instanceof FinancialToolRuntimeError
      && error.code === "FINANCIAL_TOOL_TIMEOUT"
      && error.retryable,
  );
  assert.equal(researchCalls, 0);
});

function sequenceNow(values: string[]): () => string {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}
