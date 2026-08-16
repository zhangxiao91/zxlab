import assert from "node:assert/strict";
import test from "node:test";
import { D1RunArchiveRepository, type RunArchiveExport } from "./run-archive.ts";

interface StoredRun {
  id: string;
  profile_id: string;
  workflow: string;
  trigger: string;
  status: string;
  idempotency_key: string;
  command_hash: string;
  revision_of_run_id: string | null;
  portfolio_snapshot_id: string | null;
  attempt: number;
  recovery_generation: number;
  evidence_fingerprint: string | null;
  failure_json: string | null;
  command_json: string | null;
  result_json: string | null;
  evidence_json: string | null;
  created_at: string;
  updated_at: string;
  payload_purged_at: string | null;
  feedback_value: string | null;
  feedback_updated_at: string | null;
}

function storedRun(id: string, profileId: string, createdAt: string): StoredRun {
  return {
    id,
    profile_id: profileId,
    workflow: "close_review",
    trigger: "manual",
    status: "success",
    idempotency_key: `key-${id}`,
    command_hash: `sha256:command-${id}`,
    revision_of_run_id: null,
    portfolio_snapshot_id: null,
    attempt: 1,
    recovery_generation: 0,
    evidence_fingerprint: `sha256:evidence-${id}`,
    failure_json: null,
    command_json: JSON.stringify({ runId: id }),
    result_json: JSON.stringify({ headline: id }),
    evidence_json: JSON.stringify({ fingerprint: `sha256:evidence-${id}` }),
    created_at: createdAt,
    updated_at: createdAt,
    payload_purged_at: null,
    feedback_value: null,
    feedback_updated_at: null,
  };
}

function fakeArchiveDb(initialRows: StoredRun[]): D1Database {
  const rows = initialRows.map((row) => ({ ...row }));
  const tombstones = new Map<string, { run_id: string; evidence_fingerprint: string | null; purged_at: string; reason: "retention" | "user_deleted" }>();
  const execute = async (sql: string, values: unknown[]) => {
    if (sql.includes("FROM agent_runs WHERE profile_id = ?") && sql.includes("ORDER BY created_at DESC")) {
      const profileId = String(values[0]);
      const limit = Number(values.at(-1));
      const cursorCreatedAt = values.length === 5 ? String(values[1]) : null;
      const cursorId = values.length === 5 ? String(values[3]) : null;
      const results = rows
        .filter((row) => row.profile_id === profileId)
        .filter((row) => !cursorCreatedAt || row.created_at < cursorCreatedAt || (row.created_at === cursorCreatedAt && row.id < String(cursorId)))
        .sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id))
        .slice(0, limit)
        .map((row) => sql.startsWith("SELECT *") || sql.includes("agent_runs.*") ? { ...row, input_json: row.command_json } : { ...row, input_json: row.command_json, command_json: null, evidence_json: null });
      return { results };
    }
    if (sql.includes("FROM agent_runs WHERE id = ? AND profile_id = ?") && !sql.startsWith("SELECT id, evidence_fingerprint")) {
      const [runId, profileId] = values as [string, string];
      const row = rows.find((candidate) => candidate.id === runId && candidate.profile_id === profileId);
      return { results: row ? [{ ...row, input_json: row.command_json, command_json: null, evidence_json: null }] : [] };
    }
    if (sql.startsWith("SELECT id, evidence_fingerprint FROM agent_runs WHERE id = ?")) {
      const [runId, profileId] = values as [string, string];
      const row = rows.find((candidate) => candidate.id === runId && candidate.profile_id === profileId && candidate.payload_purged_at === null);
      return { results: row ? [{ id: row.id, evidence_fingerprint: row.evidence_fingerprint }] : [] };
    }
    if (sql.startsWith("SELECT id, profile_id, evidence_fingerprint FROM agent_runs WHERE profile_id")) {
      const [profileId, cutoff, limit] = values as [string, string, number];
      const results = rows
        .filter((row) => row.profile_id === profileId)
        .filter((row) => ["success", "partial", "failed"].includes(row.status))
        .filter((row) => row.created_at < cutoff && row.payload_purged_at === null)
        .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id))
        .slice(0, limit)
        .map((row) => ({ id: row.id, profile_id: row.profile_id, evidence_fingerprint: row.evidence_fingerprint }));
      return { results };
    }
    if (sql.startsWith("SELECT id, profile_id, evidence_fingerprint FROM agent_runs WHERE status")) {
      const [cutoff, limit] = values as [string, number];
      const results = rows
        .filter((row) => ["success", "partial", "failed"].includes(row.status))
        .filter((row) => row.created_at < cutoff && row.payload_purged_at === null)
        .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id))
        .slice(0, limit)
        .map((row) => ({ id: row.id, profile_id: row.profile_id, evidence_fingerprint: row.evidence_fingerprint }));
      return { results };
    }
    if (sql.startsWith("SELECT run_id, evidence_fingerprint")) {
      const [profileId, runId] = values as [string, string];
      const row = tombstones.get(`${profileId}:${runId}`);
      return { results: row ? [row] : [] };
    }
    if (sql.startsWith("INSERT INTO run_archive_tombstones")) {
      const [, profileId, runId, evidenceFingerprint, purgedAt] = values as [string, string, string, string | null, string];
      const reason = sql.includes("'retention'") ? "retention" : "user_deleted";
      const key = `${profileId}:${runId}`;
      if (tombstones.has(key)) return { meta: { changes: 0 } };
      tombstones.set(key, { run_id: runId, evidence_fingerprint: evidenceFingerprint, purged_at: purgedAt, reason });
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith("UPDATE agent_runs SET command_json = NULL")) {
      const hasUpdatedAt = sql.includes("updated_at = ?");
      const purgedAt = String(values[0]);
      const runId = String(values[hasUpdatedAt ? 2 : 1]);
      const profileId = String(values[hasUpdatedAt ? 3 : 2]);
      const row = rows.find((candidate) => candidate.id === runId && candidate.profile_id === profileId && candidate.payload_purged_at === null);
      if (!row) return { meta: { changes: 0 } };
      row.command_json = null;
      row.result_json = null;
      row.evidence_json = null;
      row.payload_purged_at = purgedAt;
      if (hasUpdatedAt) row.updated_at = String(values[1]);
      return { meta: { changes: 1 } };
    }
    return { results: [], meta: { changes: 0 } };
  };
  return {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            sql,
            values,
            async all() { return execute(sql, values); },
            async first() { return (await execute(sql, values)).results?.[0] ?? null; },
            async run() { return execute(sql, values); },
          };
        },
      };
    },
    async batch(statements: Array<{ sql: string; values: unknown[] }>) {
      return Promise.all(statements.map((statement) => execute(statement.sql, statement.values)));
    },
  } as unknown as D1Database;
}

test("run archive cursor pagination is stable and profile-scoped", async () => {
  const db = fakeArchiveDb([
    storedRun("run-c", "profile-owner", "2026-08-03T00:00:00.000Z"),
    storedRun("run-b", "profile-owner", "2026-08-03T00:00:00.000Z"),
    storedRun("run-a", "profile-owner", "2026-08-01T00:00:00.000Z"),
    storedRun("run-private", "profile-other", "2026-08-04T00:00:00.000Z"),
  ]);
  const archive = new D1RunArchiveRepository(db);

  const first = await archive.list("profile-owner", { limit: 2 });
  assert.deepEqual(first.runs.map((run) => run.id), ["run-c", "run-b"]);
  assert.ok(first.nextCursor);

  const second = await archive.list("profile-owner", { limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.runs.map((run) => run.id), ["run-a"]);
  assert.equal(second.nextCursor, null);
});

test("run archive list and get expose the owning profile's persisted feedback", async () => {
  const saved = {
    ...storedRun("run-feedback", "profile-owner", "2026-08-14T00:00:00.000Z"),
    feedback_value: "helpful",
    feedback_updated_at: "2026-08-15T01:02:03.000Z",
  };
  const archive = new D1RunArchiveRepository(fakeArchiveDb([
    saved,
    {
      ...storedRun("run-private", "profile-other", "2026-08-14T00:00:00.000Z"),
      feedback_value: "fact_error",
      feedback_updated_at: "2026-08-15T02:03:04.000Z",
    },
  ]));

  const page = await archive.list("profile-owner");
  const run = await archive.get("profile-owner", "run-feedback");

  assert.deepEqual(page.runs[0]?.feedback, {
    value: "helpful",
    updatedAt: "2026-08-15T01:02:03.000Z",
  });
  assert.deepEqual(run?.feedback, page.runs[0]?.feedback);
  assert.equal(page.runs.some((item) => item.id === "run-private"), false);
});

test("run archive summaries restore only the safe input context", async () => {
  const ask = {
    ...storedRun("run-ask", "profile-owner", "2026-08-14T00:00:00.000Z"),
    workflow: "ask",
    command_json: JSON.stringify({
      workflow: "ask",
      profileId: "private-profile",
      trigger: "manual",
      idempotencyKey: "private-key",
      scope: "compare_previous_run",
      instrumentId: "SSE:600000",
      question: "比较变化",
      priorRunId: "run-prior",
      resolvedInstrumentIds: ["SSE:600000"],
    }),
  };
  const archive = new D1RunArchiveRepository(fakeArchiveDb([ask]));

  const run = (await archive.list("profile-owner")).runs[0];

  assert.deepEqual(run?.input, {
    workflow: "ask",
    askScope: "compare_previous_run",
    instrumentId: "SSE:600000",
    question: "比较变化",
    priorRunId: "run-prior",
    resolvedInstrumentIds: ["SSE:600000"],
  });
  assert.equal(run?.command, null);
  assert.doesNotMatch(JSON.stringify(run?.input), /private-profile|private-key/);
});

test("run archive list and get project valid legacy results and reject malformed payloads", async () => {
  const valid = {
    ...storedRun("run-valid", "profile-owner", "2026-08-15T00:00:00.000Z"),
    result_json: JSON.stringify({
      status: "success",
      headline: "历史结论",
      summary: "历史摘要",
      observations: [],
      portfolioImpacts: [],
      watchNext: [],
      limitations: [],
      evidenceFingerprint: "sha256:legacy",
      mode: "market-only",
    }),
  };
  const malformed = storedRun("run-malformed", "profile-owner", "2026-08-14T00:00:00.000Z");
  const archive = new D1RunArchiveRepository(fakeArchiveDb([valid, malformed]));

  const page = await archive.list("profile-owner");
  const restored = await archive.get("profile-owner", "run-valid");

  assert.equal(restored?.result && (restored.result as { report?: { version?: string } }).report?.version, "research-report.v2");
  assert.equal(page.runs.find((run) => run.id === "run-valid")?.result && (page.runs.find((run) => run.id === "run-valid")?.result as { outcome?: { narration?: { source?: string } } }).outcome?.narration?.source, "unknown");
  assert.equal(page.runs.find((run) => run.id === "run-malformed")?.result, null);
});

test("run archive export follows every page and returns the complete profile history", async () => {
  const db = fakeArchiveDb([
    storedRun("run-e", "profile-owner", "2026-08-05T00:00:00.000Z"),
    storedRun("run-d", "profile-owner", "2026-08-04T00:00:00.000Z"),
    storedRun("run-c", "profile-owner", "2026-08-03T00:00:00.000Z"),
    storedRun("run-b", "profile-owner", "2026-08-02T00:00:00.000Z"),
    storedRun("run-a", "profile-owner", "2026-08-01T00:00:00.000Z"),
    storedRun("run-private", "profile-other", "2026-08-06T00:00:00.000Z"),
  ]);

  const exported = await new D1RunArchiveRepository(db).exportAll("profile-owner", {
    pageSize: 2,
    exportedAt: "2026-08-14T00:00:00.000Z",
  });

  assert.deepEqual(
    {
      schemaVersion: exported.schemaVersion,
      exportedAt: exported.exportedAt,
      runIds: exported.runs.map((run) => run.id),
      firstResult: exported.runs[0]?.result,
      firstEvidence: exported.runs[0]?.evidence,
    },
    {
      schemaVersion: "market-agent-run-export.v2",
      exportedAt: "2026-08-14T00:00:00.000Z",
      runIds: ["run-e", "run-d", "run-c", "run-b", "run-a"],
      firstResult: { headline: "run-e" },
      firstEvidence: { fingerprint: "sha256:evidence-run-e" },
    },
  );
});

test("run archive streams the complete export without materializing it in the request handler", async () => {
  const db = fakeArchiveDb([
    storedRun("run-c", "profile-owner", "2026-08-03T00:00:00.000Z"),
    storedRun("run-b", "profile-owner", "2026-08-02T00:00:00.000Z"),
    storedRun("run-a", "profile-owner", "2026-08-01T00:00:00.000Z"),
    storedRun("run-private", "profile-other", "2026-08-04T00:00:00.000Z"),
  ]);

  const response = new D1RunArchiveRepository(db).createExportResponse("profile-owner", {
    pageSize: 1,
    exportedAt: "2026-08-14T00:00:00.000Z",
  });
  const exported = await response.json() as RunArchiveExport;

  assert.equal(response.headers.get("content-disposition"), "attachment; filename=\"market-agent-runs-2026-08-14.json\"");
  assert.equal(exported.schemaVersion, "market-agent-run-export.v2");
  assert.deepEqual(exported.runs.map((run) => run.id), ["run-c", "run-b", "run-a"]);
});

test("retention sweep tombstones terminal payloads while preserving run metadata and fingerprint", async () => {
  const old = storedRun("run-old", "profile-owner", "2026-07-01T00:00:00.000Z");
  const active = { ...storedRun("run-active", "profile-owner", "2026-06-01T00:00:00.000Z"), status: "collecting" };
  const db = fakeArchiveDb([
    old,
    active,
    storedRun("run-recent", "profile-owner", "2026-08-13T00:00:00.000Z"),
    storedRun("run-private", "profile-other", "2026-06-01T00:00:00.000Z"),
  ]);
  const archive = new D1RunArchiveRepository(db);

  const swept = await archive.sweepRetention("profile-owner", {
    cutoff: "2026-08-01T00:00:00.000Z",
    purgedAt: "2026-08-14T00:00:00.000Z",
  });
  const page = await archive.list("profile-owner", { limit: 10 });
  const retained = page.runs.find((run) => run.id === "run-old");

  assert.deepEqual(
    {
      swept,
      retained: retained && {
        id: retained.id,
        status: retained.status,
        evidenceFingerprint: retained.evidenceFingerprint,
        command: retained.command,
        result: retained.result,
        evidence: retained.evidence,
        payloadPurgedAt: retained.payloadPurgedAt,
        updatedAt: retained.updatedAt,
      },
      activeResult: page.runs.find((run) => run.id === "run-active")?.result,
    },
    {
      swept: {
        purged: 1,
        tombstones: [{ runId: "run-old", evidenceFingerprint: "sha256:evidence-run-old", purgedAt: "2026-08-14T00:00:00.000Z", reason: "retention" }],
      },
      retained: {
        id: "run-old",
        status: "success",
        evidenceFingerprint: "sha256:evidence-run-old",
        command: null,
        result: null,
        evidence: null,
        payloadPurgedAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
      activeResult: null,
    },
  );
});

test("global retention reaches every profile and clears a failed command-only payload", async () => {
  const commandOnly = { ...storedRun("run-command-only", "profile-501", "2026-06-01T00:00:00.000Z"), status: "failed", result_json: null, evidence_json: null };
  const db = fakeArchiveDb([
    storedRun("run-owner", "profile-owner", "2026-07-01T00:00:00.000Z"),
    commandOnly,
  ]);
  const archive = new D1RunArchiveRepository(db);

  const swept = await archive.sweepRetentionAll({
    cutoff: "2026-08-01T00:00:00.000Z",
    purgedAt: "2026-08-14T00:00:00.000Z",
  });
  const commandOnlyRun = await archive.get("profile-501", "run-command-only");

  assert.equal(swept.purged, 2);
  assert.equal(commandOnlyRun?.payloadPurgedAt, "2026-08-14T00:00:00.000Z");
  assert.equal(commandOnlyRun?.command, null);
});

test("explicit run payload deletion cannot cross profile ownership", async () => {
  const db = fakeArchiveDb([
    storedRun("run-owner", "profile-owner", "2026-08-01T00:00:00.000Z"),
    storedRun("run-private", "profile-other", "2026-08-01T00:00:00.000Z"),
  ]);
  const archive = new D1RunArchiveRepository(db);

  const denied = await archive.purgeRunPayload("profile-owner", "run-private", {
    purgedAt: "2026-08-14T00:00:00.000Z",
  });
  const deleted = await archive.purgeRunPayload("profile-owner", "run-owner", {
    purgedAt: "2026-08-14T00:00:00.000Z",
  });
  const owner = await archive.list("profile-owner");
  const other = await archive.list("profile-other");

  assert.deepEqual(
    {
      denied,
      deleted,
      ownerResult: owner.runs[0]?.result,
      ownerFingerprint: owner.runs[0]?.evidenceFingerprint,
      otherResult: other.runs[0]?.result,
    },
    {
      denied: null,
      deleted: {
        runId: "run-owner",
        evidenceFingerprint: "sha256:evidence-run-owner",
        purgedAt: "2026-08-14T00:00:00.000Z",
        reason: "user_deleted",
      },
      ownerResult: null,
      ownerFingerprint: "sha256:evidence-run-owner",
      otherResult: null,
    },
  );
});

test("explicit run deletion returns the existing tombstone on retry", async () => {
  const db = fakeArchiveDb([
    storedRun("run-owner", "profile-owner", "2026-08-01T00:00:00.000Z"),
  ]);
  const archive = new D1RunArchiveRepository(db);

  const first = await archive.purgeRunPayload("profile-owner", "run-owner", { purgedAt: "2026-08-14T00:00:00.000Z" });
  const retried = await archive.purgeRunPayload("profile-owner", "run-owner", { purgedAt: "2026-08-15T00:00:00.000Z" });

  assert.deepEqual(retried, first);
});
