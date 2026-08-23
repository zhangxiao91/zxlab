import assert from "node:assert/strict";
import test from "node:test";
import { calculateResearchFactBundleFingerprint, type ResearchFactBundle } from "@zxlab/research-fact-schema";
import { isToolTrace } from "@zxlab/market-agent-schema";
import {
  D1FinancialToolInvocationRepository,
  type FinancialToolInvocationRecord,
} from "./financial-tool-repository.ts";

interface StoredInvocation {
  invocation_id: string;
  run_id: string;
  profile_id: string;
  policy_version: string;
  tool_id: string;
  tool_version: string;
  ordinal: number;
  decision: string;
  selection_source: string;
  status: string;
  attempt: number;
  outcome: string | null;
  safe_error_code: string | null;
  research_fingerprint: string | null;
  result_json: string | null;
  result_purged_at: string | null;
  selected_at: string;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  updated_at: string;
}

interface StoredTrace {
  sequence: number;
  id: string;
  invocation_id: string;
  run_id: string;
  profile_id: string;
  type: string;
  tool_id: string;
  tool_version: string;
  selection_source: string;
  attempt: number;
  occurred_at: string;
  duration_ms: number | null;
  outcome: string | null;
  research_fingerprint: string | null;
  code: string | null;
}

function fakeToolDb() {
  const runs = new Set(["profile-owner:run-1"]);
  const invocations = new Map<string, StoredInvocation>();
  const traces: StoredTrace[] = [];

  async function execute(sql: string, values: unknown[]) {
    if (sql.startsWith("INSERT INTO financial_tool_invocations")) {
      const [invocationId, runId, profileId, policyVersion, toolId, toolVersion, ordinal, decision, selectionSource, status, attempt, selectedAt, completedAt, durationMs, updatedAt] = values;
      if (!runs.has(`${profileId}:${runId}`) || invocations.has(String(invocationId))) return { meta: { changes: 0 }, results: [] };
      invocations.set(String(invocationId), {
        invocation_id: String(invocationId), run_id: String(runId), profile_id: String(profileId), policy_version: String(policyVersion),
        tool_id: String(toolId), tool_version: String(toolVersion), ordinal: Number(ordinal), decision: String(decision),
        selection_source: String(selectionSource), status: String(status), attempt: Number(attempt), outcome: null,
        safe_error_code: null, research_fingerprint: null, result_json: null, result_purged_at: null,
        selected_at: String(selectedAt), started_at: null,
        completed_at: completedAt === null ? null : String(completedAt), duration_ms: durationMs === null ? null : Number(durationMs), updated_at: String(updatedAt),
      });
      return { meta: { changes: 1 }, results: [] };
    }
    if (sql.startsWith("SELECT invocation_id") && sql.includes("FROM financial_tool_invocations")) {
      const [runId, profileId] = values;
      const row = [...invocations.values()].find((candidate) => candidate.run_id === runId && candidate.profile_id === profileId);
      return { results: row ? [{ ...row }] : [] };
    }
    if (sql === "SELECT id FROM agent_runs WHERE id = ? AND profile_id = ?") {
      const [runId, profileId] = values;
      return { results: runs.has(`${profileId}:${runId}`) ? [{ id: runId }] : [] };
    }
    if (sql.startsWith("SELECT sequence, id, invocation_id") && sql.includes("FROM financial_tool_trace_events")) {
      const [runId, profileId, afterSequence] = values;
      const limit = sql.includes("LIMIT 101") ? 101 : 100;
      return {
        results: traces
          .filter((row) => row.run_id === runId && row.profile_id === profileId)
          .filter((row) => afterSequence === undefined || row.sequence > Number(afterSequence))
          .sort((left, right) => left.sequence - right.sequence)
          .slice(0, limit)
          .map((row) => ({ ...row })),
      };
    }
    if (sql.startsWith("UPDATE financial_tool_invocations SET status = 'pending'")) {
      const [startedAt, updatedAt, invocationId, runId, profileId, attempt] = values;
      const row = invocations.get(String(invocationId));
      if (!row || row.run_id !== runId || row.profile_id !== profileId || row.status !== "planned" || row.attempt !== attempt) return { meta: { changes: 0 }, results: [] };
      row.status = "pending";
      row.started_at = String(startedAt);
      row.completed_at = null;
      row.duration_ms = null;
      row.safe_error_code = null;
      row.updated_at = String(updatedAt);
      return { meta: { changes: 1 }, results: [] };
    }
    if (sql.startsWith("UPDATE financial_tool_invocations SET status = 'completed'")) {
      const [outcome, fingerprint, resultJson, completedAt, durationMs, updatedAt, invocationId, runId, profileId, attempt] = values;
      const row = invocations.get(String(invocationId));
      if (!row || row.run_id !== runId || row.profile_id !== profileId || row.status !== "pending" || row.attempt !== attempt) return { meta: { changes: 0 }, results: [] };
      row.status = "completed";
      row.outcome = String(outcome);
      row.safe_error_code = null;
      row.research_fingerprint = String(fingerprint);
      row.result_json = String(resultJson);
      row.result_purged_at = null;
      row.completed_at = String(completedAt);
      row.duration_ms = Number(durationMs);
      row.updated_at = String(updatedAt);
      return { meta: { changes: 1 }, results: [] };
    }
    if (sql.startsWith("UPDATE financial_tool_invocations SET status = 'failed'")) {
      const [code, completedAt, durationMs, updatedAt, invocationId, runId, profileId, attempt] = values;
      const row = invocations.get(String(invocationId));
      if (!row || row.run_id !== runId || row.profile_id !== profileId || row.status !== "pending" || row.attempt !== attempt) return { meta: { changes: 0 }, results: [] };
      row.status = "failed";
      row.outcome = null;
      row.safe_error_code = String(code);
      row.research_fingerprint = null;
      row.result_json = null;
      row.result_purged_at = null;
      row.completed_at = String(completedAt);
      row.duration_ms = Number(durationMs);
      row.updated_at = String(updatedAt);
      return { meta: { changes: 1 }, results: [] };
    }
    if (sql.startsWith("UPDATE financial_tool_invocations SET status = 'planned'")) {
      const [attempt, updatedAt, invocationId, runId, profileId, previousStatus, previousAttempt] = values;
      const row = invocations.get(String(invocationId));
      if (!row || row.run_id !== runId || row.profile_id !== profileId || row.status !== previousStatus || row.attempt !== previousAttempt) return { meta: { changes: 0 }, results: [] };
      row.status = "planned";
      row.attempt = Number(attempt);
      row.outcome = null;
      row.safe_error_code = null;
      row.research_fingerprint = null;
      row.result_json = null;
      row.result_purged_at = null;
      row.started_at = null;
      row.completed_at = null;
      row.duration_ms = null;
      row.updated_at = String(updatedAt);
      return { meta: { changes: 1 }, results: [] };
    }
    if (sql.startsWith("UPDATE financial_tool_invocations SET result_json = NULL")) {
      const [purgedAt, updatedAt, runId, profileId] = values;
      const row = [...invocations.values()].find((candidate) => candidate.run_id === runId && candidate.profile_id === profileId && candidate.status === "completed" && candidate.result_json !== null);
      if (!row) return { meta: { changes: 0 }, results: [] };
      row.result_json = null;
      row.result_purged_at = String(purgedAt);
      row.updated_at = String(updatedAt);
      return { meta: { changes: 1 }, results: [] };
    }
    if (sql.startsWith("INSERT INTO financial_tool_trace_events")) {
      const id = String(values[0]);
      let type: StoredTrace["type"];
      let occurredAt: string;
      let invocationId: string;
      let runId: string;
      let profileId: string;
      if (sql.includes("SELECT ?, invocation_id, run_id, profile_id, ?")) {
        type = String(values[1]); occurredAt = String(values[2]); invocationId = String(values[4]); runId = String(values[5]); profileId = String(values[6]);
      } else {
        type = sql.includes("'started'") ? "started" : sql.includes("'completed'") ? "completed" : "failed";
        occurredAt = String(values[1]); invocationId = String(values[2]); runId = String(values[3]); profileId = String(values[4]);
      }
      const invocation = invocations.get(invocationId);
      if (!invocation || invocation.run_id !== runId || invocation.profile_id !== profileId) return { meta: { changes: 0 }, results: [] };
      if (traces.some((row) => row.invocation_id === invocationId && row.type === type && row.attempt === invocation.attempt)) return { meta: { changes: 0 }, results: [] };
      traces.push({
        sequence: traces.length + 1, id, invocation_id: invocationId, run_id: runId, profile_id: profileId,
        type, tool_id: invocation.tool_id, tool_version: invocation.tool_version, selection_source: invocation.selection_source,
        attempt: invocation.attempt, occurred_at: occurredAt,
        duration_ms: type === "selected" || type === "skipped" ? Number(values[3]) : type === "started" ? null : invocation.duration_ms,
        outcome: type === "completed" ? invocation.outcome : null,
        research_fingerprint: type === "completed" ? invocation.research_fingerprint : null,
        code: type === "skipped" ? "FINANCIAL_TOOL_NOT_SELECTED" : type === "failed" ? invocation.safe_error_code : null,
      });
      return { meta: { changes: 1 }, results: [] };
    }
    return { meta: { changes: 0 }, results: [] };
  }

  const db = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            sql,
            values,
            async first() { return (await execute(sql, values)).results[0] ?? null; },
            async all() { return execute(sql, values); },
            async run() { return execute(sql, values); },
          };
        },
      };
    },
    async batch(statements: Array<{ sql: string; values: unknown[] }>) {
      return Promise.all(statements.map((statement) => execute(statement.sql, statement.values)));
    },
  } as unknown as D1Database;

  return { db, invocations, traces };
}

test("financial tool selection is idempotent and profile-scoped", async () => {
  const { db } = fakeToolDb();
  const repository = new D1FinancialToolInvocationRepository(db);
  const input = {
    invocationId: "fti_001",
    runId: "run-1",
    profileId: "profile-owner",
    policyVersion: "financial-tools.v1",
    toolId: "company_financial_update",
    toolVersion: "1",
    ordinal: 1,
    decision: "invoke" as const,
    selectionSource: "model" as const,
    attempt: 1,
    occurredAt: "2026-08-23T01:00:00.000Z",
    durationMs: 20,
  };

  const first = await repository.beginPlanned(input);
  const duplicate = await repository.beginPlanned(input);
  const owner = await repository.get("run-1", "profile-owner");
  const other = await repository.get("run-1", "profile-other");

  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.deepEqual(owner, first.record satisfies FinancialToolInvocationRecord);
  assert.equal(other, null);
});

async function unavailableResearch(generatedAt: string): Promise<ResearchFactBundle> {
  const bundle: ResearchFactBundle = {
    schemaVersion: "research-facts.v2",
    planVersion: "company-update.v1",
    purpose: "company_update",
    observationCutoff: "2026-08-22T07:00:00.000Z",
    knowledgeCutoff: "2026-08-22T07:00:00.000Z",
    generatedAt,
    instrumentIds: ["SSE:600000"],
    facts: [],
    capabilities: [{
      id: "fundamentals",
      required: true,
      status: "unavailable",
      factIds: [],
      asOf: null,
      retrievedAt: generatedAt,
      warnings: ["FINANCIAL_TOOL_UNAVAILABLE"],
      limitations: [{ code: "ARTIFACT_STORE_UNAVAILABLE", retryable: true }],
      error: { code: "ARTIFACT_STORE_UNAVAILABLE", retryable: true },
    }],
    fingerprint: "sha256:placeholder",
  };
  bundle.fingerprint = await calculateResearchFactBundleFingerprint(bundle);
  return bundle;
}

test("the first completed financial tool result is immutable", async () => {
  const { db } = fakeToolDb();
  const repository = new D1FinancialToolInvocationRepository(db);
  await repository.beginPlanned({
    invocationId: "fti_001", runId: "run-1", profileId: "profile-owner",
    policyVersion: "financial-tools.v1", toolId: "company_financial_update", toolVersion: "1", ordinal: 1,
    decision: "invoke", selectionSource: "model", attempt: 1,
    occurredAt: "2026-08-23T01:00:00.000Z", durationMs: 20,
  });
  await repository.markStarted({
    invocationId: "fti_001", runId: "run-1", profileId: "profile-owner", attempt: 1,
    occurredAt: "2026-08-23T01:00:01.000Z",
  });
  const firstBundle = await unavailableResearch("2026-08-22T07:00:00.000Z");
  const changedBundle = await unavailableResearch("2026-08-22T07:01:00.000Z");

  const first = await repository.complete({
    invocationId: "fti_001", runId: "run-1", profileId: "profile-owner", attempt: 1,
    outcome: "unavailable", research: firstBundle, occurredAt: "2026-08-23T01:00:04.000Z",
  });
  const duplicate = await repository.complete({
    invocationId: "fti_001", runId: "run-1", profileId: "profile-owner", attempt: 1,
    outcome: "unavailable", research: changedBundle, occurredAt: "2026-08-23T01:00:05.000Z",
  });

  assert.equal(first.reused, false);
  assert.equal(duplicate.reused, true);
  assert.equal(duplicate.record.researchFingerprint, firstBundle.fingerprint);
  assert.deepEqual(duplicate.record.research, firstBundle);
  assert.equal(duplicate.record.durationMs, 3_000);
});

test("a failed invocation resumes only on a newer Run attempt without replanning", async () => {
  const { db } = fakeToolDb();
  const repository = new D1FinancialToolInvocationRepository(db);
  const selection = {
    invocationId: "fti_001", runId: "run-1", profileId: "profile-owner",
    policyVersion: "financial-tools.v1", toolId: "company_financial_update", toolVersion: "1", ordinal: 1,
    decision: "invoke" as const, selectionSource: "policy_fallback" as const,
    attempt: 1, occurredAt: "2026-08-23T01:00:00.000Z", durationMs: 12_000,
  };
  await repository.beginPlanned(selection);
  await repository.markStarted({ ...selection, occurredAt: "2026-08-23T01:00:01.000Z" });
  const failed = await repository.fail({
    invocationId: selection.invocationId, runId: selection.runId, profileId: selection.profileId,
    attempt: 1, code: "FINANCIAL_TOOL_TIMEOUT", occurredAt: "2026-08-23T01:00:36.000Z",
  });

  await assert.rejects(repository.beginPlanned(selection), /FINANCIAL_TOOL_INVOCATION_CONFLICT/);
  const resumed = await repository.beginPlanned({
    ...selection,
    attempt: 2,
    occurredAt: "2026-08-23T01:01:00.000Z",
  });

  assert.equal(failed.status, "failed");
  assert.equal(failed.safeErrorCode, "FINANCIAL_TOOL_TIMEOUT");
  assert.equal(failed.durationMs, 35_000);
  assert.equal(resumed.created, false);
  assert.equal(resumed.record.status, "planned");
  assert.equal(resumed.record.attempt, 2);
  assert.equal(resumed.record.selectionSource, "policy_fallback");
  assert.equal(resumed.record.selectedAt, selection.occurredAt);
  assert.equal(resumed.record.safeErrorCode, undefined);
});

test("a pending invocation is closed in ToolTrace before a newer attempt resumes", async () => {
  const { db } = fakeToolDb();
  const repository = new D1FinancialToolInvocationRepository(db);
  const selection = {
    invocationId: "fti_001", runId: "run-1", profileId: "profile-owner",
    policyVersion: "financial-tools.v1", toolId: "company_financial_update", toolVersion: "1", ordinal: 1,
    decision: "invoke" as const, selectionSource: "model" as const,
    attempt: 1, occurredAt: "2026-08-23T01:00:00.000Z", durationMs: 50,
  };
  await repository.beginPlanned(selection);
  await repository.markStarted({ ...selection, occurredAt: "2026-08-23T01:00:01.000Z" });

  const resumed = await repository.beginPlanned({
    ...selection,
    attempt: 2,
    occurredAt: "2026-08-23T01:00:11.000Z",
  });
  const trace = await repository.getToolTrace("run-1", "profile-owner");

  assert.equal(resumed.record.status, "planned");
  assert.equal(resumed.record.attempt, 2);
  assert.deepEqual(trace?.events.map((event) => event.type), ["selected", "started", "failed"]);
  const recovered = trace?.events[2];
  assert.equal(recovered?.type === "failed" && recovered.code, "FINANCIAL_TOOL_ATTEMPT_RECOVERED");
  assert.equal(recovered?.type === "failed" && recovered.durationMs, 10_000);
});

test("ToolTrace is append-only, profile-scoped, ordered, and contains only safe fields", async () => {
  const { db } = fakeToolDb();
  const repository = new D1FinancialToolInvocationRepository(db);
  const selection = {
    invocationId: "fti_001", runId: "run-1", profileId: "profile-owner",
    policyVersion: "financial-tools.v1", toolId: "company_financial_update", toolVersion: "1", ordinal: 1,
    decision: "invoke" as const, selectionSource: "model" as const,
    attempt: 1, occurredAt: "2026-08-23T01:00:00.000Z", durationMs: 80,
  };
  await repository.beginPlanned(selection);
  await repository.markStarted({ ...selection, occurredAt: "2026-08-23T01:00:01.000Z" });
  const research = await unavailableResearch("2026-08-22T07:00:00.000Z");
  await repository.complete({
    invocationId: selection.invocationId, runId: selection.runId, profileId: selection.profileId,
    attempt: 1, outcome: "unavailable", research, occurredAt: "2026-08-23T01:00:04.000Z",
  });

  const trace = await repository.getToolTrace("run-1", "profile-owner");
  const afterSelection = await repository.listToolTraceAfter("run-1", "profile-owner", 1);

  assert.ok(trace && isToolTrace(trace));
  assert.deepEqual(trace.events.map((event) => event.type), ["selected", "started", "completed"]);
  assert.deepEqual(trace.events.map((event) => event.sequence), [1, 2, 3]);
  assert.equal(trace.events[2]?.type === "completed" && trace.events[2].durationMs, 3_000);
  assert.equal(trace.events[2]?.type === "completed" && trace.events[2].researchFingerprint, research.fingerprint);
  assert.deepEqual(afterSelection.map((event) => event.type), ["started", "completed"]);
  assert.equal(await repository.getToolTrace("run-1", "profile-other"), null);
  assert.doesNotMatch(JSON.stringify(trace), /instrumentIds|capabilities|question|provider|result_json/);
});

test("purging a Run removes the financial result body but retains safe audit metadata", async () => {
  const { db } = fakeToolDb();
  const repository = new D1FinancialToolInvocationRepository(db);
  const selection = {
    invocationId: "fti_001", runId: "run-1", profileId: "profile-owner",
    policyVersion: "financial-tools.v1", toolId: "company_financial_update", toolVersion: "1", ordinal: 1,
    decision: "invoke" as const, selectionSource: "model" as const,
    attempt: 1, occurredAt: "2026-08-23T01:00:00.000Z", durationMs: 80,
  };
  await repository.beginPlanned(selection);
  await repository.markStarted({ ...selection, occurredAt: "2026-08-23T01:00:01.000Z" });
  const research = await unavailableResearch("2026-08-22T07:00:00.000Z");
  await repository.complete({
    invocationId: selection.invocationId, runId: selection.runId, profileId: selection.profileId,
    attempt: 1, outcome: "unavailable", research, occurredAt: "2026-08-23T01:00:04.000Z",
  });

  assert.equal(await repository.purgeResult("run-1", "profile-other", "2026-08-24T00:00:00.000Z"), false);
  assert.equal(await repository.purgeResult("run-1", "profile-owner", "2026-08-24T00:00:00.000Z"), true);
  const purged = await repository.get("run-1", "profile-owner");
  const trace = await repository.getToolTrace("run-1", "profile-owner");

  assert.equal(purged?.status, "completed");
  assert.equal(purged?.researchFingerprint, research.fingerprint);
  assert.equal(purged?.research, undefined);
  assert.equal(purged?.resultPurgedAt, "2026-08-24T00:00:00.000Z");
  assert.equal(trace?.events.length, 3);
});

test("a model skip is terminal and policy fallback cannot skip the fixed tool", async () => {
  const repository = new D1FinancialToolInvocationRepository(fakeToolDb().db);
  const selection = {
    invocationId: "fti_skip", runId: "run-1", profileId: "profile-owner",
    policyVersion: "financial-tools.v1", toolId: "company_financial_update", toolVersion: "1", ordinal: 1,
    decision: "skip" as const, selectionSource: "model" as const,
    attempt: 1, occurredAt: "2026-08-23T01:00:00.000Z", durationMs: 50,
  };

  const skipped = await repository.beginPlanned(selection);
  const trace = await repository.getToolTrace("run-1", "profile-owner");

  assert.equal(skipped.record.status, "skipped");
  assert.equal(skipped.record.completedAt, selection.occurredAt);
  assert.equal(trace?.events[0]?.type, "skipped");
  assert.ok(trace && isToolTrace(trace));
  await assert.rejects(repository.markStarted({ ...selection, occurredAt: "2026-08-23T01:00:01.000Z" }), /FINANCIAL_TOOL_INVOCATION_CONFLICT/);
  await assert.rejects(
    new D1FinancialToolInvocationRepository(fakeToolDb().db).beginPlanned({ ...selection, selectionSource: "policy_fallback" }),
    /FINANCIAL_TOOL_SELECTION_INVALID/,
  );
});

test("persisted tool identity and result digests fail closed when corrupted", async () => {
  const { db, invocations } = fakeToolDb();
  const repository = new D1FinancialToolInvocationRepository(db);
  const selection = {
    invocationId: "fti_001", runId: "run-1", profileId: "profile-owner",
    policyVersion: "financial-tools.v1", toolId: "company_financial_update", toolVersion: "1", ordinal: 1,
    decision: "invoke" as const, selectionSource: "model" as const,
    attempt: 1, occurredAt: "2026-08-23T01:00:00.000Z", durationMs: 50,
  };
  await repository.beginPlanned(selection);
  const stored = invocations.get(selection.invocationId)!;
  stored.tool_id = "untrusted_tool";
  await assert.rejects(repository.get("run-1", "profile-owner"), /FINANCIAL_TOOL_INVOCATION_CORRUPT/);

  stored.tool_id = selection.toolId;
  await repository.markStarted({ ...selection, occurredAt: "2026-08-23T01:00:01.000Z" });
  const research = await unavailableResearch("2026-08-22T07:00:00.000Z");
  await repository.complete({
    invocationId: selection.invocationId, runId: selection.runId, profileId: selection.profileId,
    attempt: 1, outcome: "unavailable", research, occurredAt: "2026-08-23T01:00:04.000Z",
  });
  stored.research_fingerprint = `sha256:${"0".repeat(64)}`;
  await assert.rejects(repository.get("run-1", "profile-owner"), /FINANCIAL_TOOL_RESULT_INTEGRITY_FAILURE/);
});
