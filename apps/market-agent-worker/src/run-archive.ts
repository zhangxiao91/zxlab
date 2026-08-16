import { compatibleAgentResult, type AgentFeedback, type AgentFeedbackValue, type AgentResult } from "@zxlab/market-agent-schema";

export interface RunArchiveRecord {
  id: string;
  workflow: string;
  trigger: string;
  status: string;
  idempotencyKey: string;
  commandHash: string;
  revisionOfRunId: string | null;
  portfolioSnapshotId: string | null;
  attempt: number;
  recoveryGeneration: number;
  evidenceFingerprint: string | null;
  failure: unknown | null;
  command: unknown | null;
  input: RunArchiveInput | null;
  result: unknown | null;
  evidence: unknown | null;
  createdAt: string;
  updatedAt: string;
  payloadPurgedAt: string | null;
  feedback: AgentFeedback | null;
}

export interface RunArchiveInput {
  workflow: string;
  askScope?: string;
  instrumentId?: string;
  question?: string;
  priorRunId?: string;
  resolvedInstrumentIds?: string[];
  marketDate?: string;
}

export interface RunArchivePage {
  runs: RunArchiveRecord[];
  nextCursor: string | null;
}

export interface RunArchiveListOptions {
  limit?: number;
  cursor?: string | null;
}

export interface RunArchiveExport {
  schemaVersion: "market-agent-run-export.v2";
  exportedAt: string;
  runs: RunArchiveRecord[];
}

export interface RunArchiveTombstone {
  runId: string;
  evidenceFingerprint: string | null;
  purgedAt: string;
  reason: "retention" | "user_deleted";
}

export interface RetentionSweepResult {
  purged: number;
  tombstones: RunArchiveTombstone[];
}

export class D1RunArchiveRepository {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async list(profileId: string, options: RunArchiveListOptions = {}): Promise<RunArchivePage> {
    return this.listPage(profileId, options, false);
  }

  async get(profileId: string, runId: string): Promise<RunArchiveRecord | null> {
    const row = await this.db.prepare(`${summaryColumns()} FROM agent_runs WHERE id = ? AND profile_id = ?`).bind(runId, profileId).first<Record<string, unknown>>();
    return row ? rowToArchiveRecord(row) : null;
  }

  private async listPage(profileId: string, options: RunArchiveListOptions, includePayload: boolean): Promise<RunArchivePage> {
    const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 50)));
    const cursor = options.cursor ? decodeCursor(options.cursor) : null;
    const columns = includePayload ? payloadColumns() : summaryColumns();
    const statement = cursor
      ? this.db.prepare(`${columns} FROM agent_runs WHERE profile_id = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?`).bind(profileId, cursor.createdAt, cursor.createdAt, cursor.id, limit + 1)
      : this.db.prepare(`${columns} FROM agent_runs WHERE profile_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`).bind(profileId, limit + 1);
    const page = await statement.all<Record<string, unknown>>();
    const visibleRows = page.results.slice(0, limit);
    const last = visibleRows.at(-1);
    return {
      runs: visibleRows.map(rowToArchiveRecord),
      nextCursor: page.results.length > limit && last
        ? encodeCursor({ createdAt: String(last.created_at), id: String(last.id) })
        : null,
    };
  }

  async exportAll(profileId: string, options: { pageSize?: number; exportedAt?: string } = {}): Promise<RunArchiveExport> {
    const runs: RunArchiveRecord[] = [];
    let cursor: string | null = null;
    do {
      const page = await this.listPage(profileId, { limit: options.pageSize ?? 100, cursor }, true);
      runs.push(...page.runs);
      cursor = page.nextCursor;
    } while (cursor);
    return {
      schemaVersion: "market-agent-run-export.v2",
      exportedAt: options.exportedAt ?? new Date().toISOString(),
      runs,
    };
  }

  createExportResponse(profileId: string, options: { pageSize?: number; exportedAt?: string } = {}): Response {
    const exportedAt = options.exportedAt ?? new Date().toISOString();
    const pageSize = Math.max(1, Math.min(100, Math.trunc(options.pageSize ?? 25)));
    const encoder = new TextEncoder();
    let cursor: string | null = null;
    let buffered: RunArchiveRecord[] = [];
    let headerSent = false;
    let firstRun = true;
    let finished = false;

    const stream = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          if (!headerSent) {
            headerSent = true;
            controller.enqueue(encoder.encode(`{"schemaVersion":"market-agent-run-export.v2","exportedAt":${JSON.stringify(exportedAt)},"runs":[`));
            return;
          }

          if (!buffered.length && !finished) {
            const page = await this.listPage(profileId, { limit: pageSize, cursor }, true);
            buffered = page.runs;
            cursor = page.nextCursor;
            if (!buffered.length && !cursor) finished = true;
          }

          const run = buffered.shift();
          if (run) {
            controller.enqueue(encoder.encode(`${firstRun ? "" : ","}${JSON.stringify(run)}`));
            firstRun = false;
            if (!buffered.length && !cursor) finished = true;
            return;
          }

          controller.enqueue(encoder.encode("]}"));
          controller.close();
        } catch (cause) {
          controller.error(cause);
        }
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "private, no-store",
        "content-disposition": `attachment; filename="market-agent-runs-${exportedAt.slice(0, 10)}.json"`,
      },
    });
  }

  async sweepRetention(profileId: string, options: { cutoff: string; purgedAt?: string; limit?: number }): Promise<RetentionSweepResult> {
    const purgedAt = options.purgedAt ?? new Date().toISOString();
    const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 100)));
    const candidates = await this.db.prepare("SELECT id, profile_id, evidence_fingerprint FROM agent_runs WHERE profile_id = ? AND status IN ('success', 'partial', 'failed') AND created_at < ? AND payload_purged_at IS NULL ORDER BY created_at ASC, id ASC LIMIT ?").bind(profileId, options.cutoff, limit).all<RetentionCandidate>();
    return this.purgeRetentionCandidates(candidates.results, purgedAt);
  }

  async sweepRetentionAll(options: { cutoff: string; purgedAt?: string; limit?: number }): Promise<RetentionSweepResult> {
    const purgedAt = options.purgedAt ?? new Date().toISOString();
    const limit = Math.max(1, Math.min(500, Math.trunc(options.limit ?? 100)));
    const candidates = await this.db.prepare("SELECT id, profile_id, evidence_fingerprint FROM agent_runs WHERE status IN ('success', 'partial', 'failed') AND created_at < ? AND payload_purged_at IS NULL ORDER BY created_at ASC, id ASC LIMIT ?").bind(options.cutoff, limit).all<RetentionCandidate>();
    return this.purgeRetentionCandidates(candidates.results, purgedAt);
  }

  private async purgeRetentionCandidates(candidates: RetentionCandidate[], purgedAt: string): Promise<RetentionSweepResult> {
    if (!candidates.length) return { purged: 0, tombstones: [] };
    const statements: D1PreparedStatement[] = [];
    for (const candidate of candidates) {
      statements.push(
        this.db.prepare("INSERT INTO run_archive_tombstones (id, profile_id, run_id, evidence_fingerprint, purged_at, reason) VALUES (?, ?, ?, ?, ?, 'retention') ON CONFLICT(profile_id, run_id) DO NOTHING").bind(crypto.randomUUID(), candidate.profile_id, candidate.id, candidate.evidence_fingerprint, purgedAt),
        this.db.prepare("DELETE FROM agent_feedback WHERE run_id = ? AND profile_id = ?").bind(candidate.id, candidate.profile_id),
        this.db.prepare("DELETE FROM run_market_events WHERE run_id = ? AND EXISTS (SELECT 1 FROM agent_runs WHERE id = ? AND profile_id = ?)").bind(candidate.id, candidate.id, candidate.profile_id),
        this.db.prepare("DELETE FROM market_events WHERE run_id = ? AND EXISTS (SELECT 1 FROM agent_runs WHERE id = ? AND profile_id = ?)").bind(candidate.id, candidate.id, candidate.profile_id),
        this.db.prepare("DELETE FROM run_market_snapshots WHERE run_id = ? AND EXISTS (SELECT 1 FROM agent_runs WHERE id = ? AND profile_id = ?)").bind(candidate.id, candidate.id, candidate.profile_id),
        this.db.prepare("UPDATE agent_runs SET command_json = NULL, result_json = NULL, evidence_json = NULL, payload_purged_at = ? WHERE id = ? AND profile_id = ? AND status IN ('success', 'partial', 'failed') AND payload_purged_at IS NULL").bind(purgedAt, candidate.id, candidate.profile_id),
      );
    }
    const responses = await this.db.batch(statements);
    const tombstones = candidates.flatMap((candidate, index) => Number(responses[index * 6 + 5]?.meta.changes ?? 0) > 0
      ? [{ runId: candidate.id, evidenceFingerprint: candidate.evidence_fingerprint, purgedAt, reason: "retention" as const }]
      : []);
    return { purged: tombstones.length, tombstones };
  }

  async purgeRunPayload(profileId: string, runId: string, options: { purgedAt?: string } = {}): Promise<RunArchiveTombstone | null> {
    const candidate = await this.db.prepare("SELECT id, evidence_fingerprint FROM agent_runs WHERE id = ? AND profile_id = ? AND status IN ('success', 'partial', 'failed') AND payload_purged_at IS NULL").bind(runId, profileId).first<{ id: string; evidence_fingerprint: string | null }>();
    if (!candidate) return this.getTombstone(profileId, runId);
    const purgedAt = options.purgedAt ?? new Date().toISOString();
    const responses = await this.db.batch([
      this.db.prepare("INSERT INTO run_archive_tombstones (id, profile_id, run_id, evidence_fingerprint, purged_at, reason) VALUES (?, ?, ?, ?, ?, 'user_deleted') ON CONFLICT(profile_id, run_id) DO NOTHING").bind(crypto.randomUUID(), profileId, candidate.id, candidate.evidence_fingerprint, purgedAt),
      this.db.prepare("DELETE FROM agent_feedback WHERE run_id = ? AND profile_id = ?").bind(candidate.id, profileId),
      this.db.prepare("DELETE FROM run_market_events WHERE run_id = ? AND EXISTS (SELECT 1 FROM agent_runs WHERE id = ? AND profile_id = ?)").bind(candidate.id, candidate.id, profileId),
      this.db.prepare("DELETE FROM market_events WHERE run_id = ? AND EXISTS (SELECT 1 FROM agent_runs WHERE id = ? AND profile_id = ?)").bind(candidate.id, candidate.id, profileId),
      this.db.prepare("DELETE FROM run_market_snapshots WHERE run_id = ? AND EXISTS (SELECT 1 FROM agent_runs WHERE id = ? AND profile_id = ?)").bind(candidate.id, candidate.id, profileId),
      this.db.prepare("UPDATE agent_runs SET command_json = NULL, result_json = NULL, evidence_json = NULL, payload_purged_at = ? WHERE id = ? AND profile_id = ? AND status IN ('success', 'partial', 'failed') AND payload_purged_at IS NULL").bind(purgedAt, candidate.id, profileId),
    ]);
    if (Number(responses[5]?.meta.changes ?? 0) === 0) return this.getTombstone(profileId, runId);
    return {
      runId: candidate.id,
      evidenceFingerprint: candidate.evidence_fingerprint,
      purgedAt,
      reason: "user_deleted",
    };
  }

  private async getTombstone(profileId: string, runId: string): Promise<RunArchiveTombstone | null> {
    const row = await this.db.prepare("SELECT run_id, evidence_fingerprint, purged_at, reason FROM run_archive_tombstones WHERE profile_id = ? AND run_id = ?").bind(profileId, runId).first<{ run_id: string; evidence_fingerprint: string | null; purged_at: string; reason: "retention" | "user_deleted" }>();
    return row ? { runId: row.run_id, evidenceFingerprint: row.evidence_fingerprint, purgedAt: row.purged_at, reason: row.reason } : null;
  }
}

interface RetentionCandidate {
  id: string;
  profile_id: string;
  evidence_fingerprint: string | null;
}

interface ArchiveCursor {
  createdAt: string;
  id: string;
}

function encodeCursor(cursor: ArchiveCursor): string {
  return btoa(JSON.stringify(cursor)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeCursor(value: string): ArchiveCursor {
  try {
    const standard = value.replaceAll("-", "+").replaceAll("_", "/");
    const decoded = JSON.parse(atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, "="))) as Partial<ArchiveCursor>;
    if (typeof decoded.createdAt !== "string" || typeof decoded.id !== "string" || !decoded.createdAt || !decoded.id) throw new Error("invalid");
    return { createdAt: decoded.createdAt, id: decoded.id };
  } catch {
    throw new Error("RUN_ARCHIVE_CURSOR_INVALID");
  }
}

function parseJson(value: unknown): unknown | null {
  if (typeof value !== "string" || !value) return null;
  return JSON.parse(value) as unknown;
}

function summaryColumns(): string {
  return `SELECT id, workflow, trigger, status, idempotency_key, command_hash, revision_of_run_id, portfolio_snapshot_id, attempt, recovery_generation, evidence_fingerprint, failure_json, command_json AS input_json, NULL AS command_json, result_json, NULL AS evidence_json, created_at, updated_at, payload_purged_at, ${feedbackColumns()}`;
}

function payloadColumns(): string {
  return `SELECT agent_runs.*, command_json AS input_json, ${feedbackColumns()}`;
}

function feedbackColumns(): string {
  return "(SELECT value FROM agent_feedback WHERE run_id = agent_runs.id AND profile_id = agent_runs.profile_id) AS feedback_value, (SELECT created_at FROM agent_feedback WHERE run_id = agent_runs.id AND profile_id = agent_runs.profile_id) AS feedback_updated_at";
}

function rowToArchiveRecord(row: Record<string, unknown>): RunArchiveRecord {
  return {
    id: String(row.id),
    workflow: String(row.workflow),
    trigger: String(row.trigger),
    status: String(row.status),
    idempotencyKey: String(row.idempotency_key),
    commandHash: String(row.command_hash),
    revisionOfRunId: row.revision_of_run_id ? String(row.revision_of_run_id) : null,
    portfolioSnapshotId: row.portfolio_snapshot_id ? String(row.portfolio_snapshot_id) : null,
    attempt: Number(row.attempt ?? 0),
    recoveryGeneration: Number(row.recovery_generation ?? 0),
    evidenceFingerprint: row.evidence_fingerprint ? String(row.evidence_fingerprint) : null,
    failure: parseJson(row.failure_json),
    command: parseJson(row.command_json),
    input: runArchiveInput(parseJson(row.input_json)),
    result: row.command_json === null && row.evidence_json === null
      ? parseArchiveResult(row.result_json)
      : parseJson(row.result_json),
    evidence: parseJson(row.evidence_json),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    payloadPurgedAt: row.payload_purged_at ? String(row.payload_purged_at) : null,
    feedback: archiveFeedback(row.feedback_value, row.feedback_updated_at),
  };
}

function runArchiveInput(value: unknown): RunArchiveInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const command = value as Record<string, unknown>;
  if (typeof command.workflow !== "string" || !command.workflow) return null;
  const resolvedInstrumentIds = Array.isArray(command.resolvedInstrumentIds)
    ? command.resolvedInstrumentIds.filter((item): item is string => typeof item === "string" && /^(SSE|SZSE):\d{6}$/.test(item)).slice(0, 200)
    : [];
  return {
    workflow: command.workflow,
    ...(typeof command.scope === "string" ? { askScope: command.scope } : {}),
    ...(typeof command.instrumentId === "string" ? { instrumentId: command.instrumentId } : {}),
    ...(typeof command.question === "string" ? { question: command.question } : {}),
    ...(typeof command.priorRunId === "string" ? { priorRunId: command.priorRunId } : {}),
    ...(resolvedInstrumentIds.length ? { resolvedInstrumentIds } : {}),
    ...(typeof command.marketDate === "string" ? { marketDate: command.marketDate } : {}),
  };
}

function parseArchiveResult(value: unknown): AgentResult | null {
  let parsed: unknown;
  try {
    parsed = parseJson(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const result = parsed as Record<string, unknown>;
  if ((result.status !== "success" && result.status !== "partial")
    || typeof result.headline !== "string"
    || typeof result.summary !== "string"
    || typeof result.evidenceFingerprint !== "string"
    || !validArchiveObservations(result.observations)
    || !validArchiveObservations(result.portfolioImpacts)
    || !validArchiveWatchNext(result.watchNext)
    || !Array.isArray(result.limitations)
    || result.limitations.some((item) => typeof item !== "string")) return null;
  return compatibleAgentResult({
    ...result,
    mode: result.mode === "portfolio-aware" ? "portfolio-aware" : "market-only",
  } as unknown as AgentResult);
}

function validArchiveObservations(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const observation = item as Record<string, unknown>;
    return typeof observation.id === "string"
      && (observation.class === "fact" || observation.class === "inference" || observation.class === "unknown")
      && (observation.importance === "high" || observation.importance === "medium" || observation.importance === "low")
      && typeof observation.title === "string"
      && typeof observation.explanation === "string"
      && Array.isArray(observation.evidenceIds)
      && observation.evidenceIds.every((id) => typeof id === "string");
  });
}

function validArchiveWatchNext(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const watch = item as Record<string, unknown>;
    return typeof watch.condition === "string"
      && typeof watch.reason === "string"
      && Array.isArray(watch.evidenceIds)
      && watch.evidenceIds.every((id) => typeof id === "string");
  });
}

function archiveFeedback(value: unknown, updatedAt: unknown): AgentFeedback | null {
  if (!isAgentFeedbackValue(value) || typeof updatedAt !== "string" || !updatedAt) return null;
  return { value, updatedAt };
}

function isAgentFeedbackValue(value: unknown): value is AgentFeedbackValue {
  return value === "helpful" || value === "fact_error" || value === "missing_factor";
}
