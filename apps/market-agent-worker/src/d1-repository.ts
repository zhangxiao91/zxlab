import { compatibleAgentResult, validateSealedEvidence, type AgentFeedback, type AgentFeedbackValue, type AgentResult, type AgentRun, type MarketAgentCommand, type RunClaimResult, type RunCreation, type SealedEvidenceBundle } from "@zxlab/market-agent-schema";
import { checkpointSnapshotPayload, parseCheckpointSnapshotPayload, verifyRunCheckpoint, type RunCheckpoint } from "./run-checkpoint.ts";

export class D1RunRepository {
  private readonly db: D1Database;
  constructor(db: D1Database) { this.db = db; }
  async createQueued(command: MarketAgentCommand, request: RunCreation): Promise<{ run: AgentRun; created: boolean }> {
    const existing = await this.db.prepare("SELECT * FROM agent_runs WHERE profile_id = ? AND idempotency_key = ?").bind(command.profileId, command.idempotencyKey).first<Record<string, unknown>>();
    if (existing) { if (existing.command_hash !== request.commandHash) throw new Error("IDEMPOTENCY_KEY_REUSED"); return { run: rowToRun(existing), created: false }; }
    const now = new Date().toISOString(); const id = crypto.randomUUID();
    await this.db.batch([
      this.db.prepare("INSERT INTO agent_runs (id, profile_id, workflow, trigger, status, idempotency_key, command_hash, revision_of_run_id, portfolio_snapshot_id, command_json, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)").bind(id, command.profileId, command.workflow, command.trigger, command.idempotencyKey, request.commandHash, request.revisionOfRunId ?? null, request.portfolioSnapshotId ?? null, JSON.stringify(command), now, now),
      this.db.prepare("INSERT INTO run_dispatch_outbox (id, run_id, generation, kind, status, created_at) VALUES (?, ?, 0, 'initial', 'pending', ?)").bind(crypto.randomUUID(), id, now),
    ]);
    const run = await this.get(id); if (!run) throw new Error("RUN_CREATE_FAILED"); return { run, created: true };
  }
  async get(id: string): Promise<AgentRun | null> { const row = await this.db.prepare("SELECT * FROM agent_runs WHERE id = ?").bind(id).first<Record<string, unknown>>(); return row ? rowToRun(row) : null; }
  async getCommand(id: string): Promise<MarketAgentCommand | null> { const row = await this.db.prepare("SELECT command_json FROM agent_runs WHERE id = ?").bind(id).first<{ command_json: string | null }>(); return row?.command_json ? JSON.parse(row.command_json) as MarketAgentCommand : null; }
  async getEvidence(id: string, profileId: string): Promise<SealedEvidenceBundle | null> {
    const row = await this.db.prepare("SELECT evidence_json FROM agent_runs WHERE id = ? AND profile_id = ? AND status IN ('success', 'partial')").bind(id, profileId).first<{ evidence_json: string | null }>();
    if (!row?.evidence_json) return null;
    try {
      const evidence = JSON.parse(row.evidence_json) as unknown;
      return validateSealedEvidence(evidence).length ? null : evidence as SealedEvidenceBundle;
    } catch {
      return null;
    }
  }
  async checkpoint(runId: string, profileId: string, leaseToken: string, checkpoint: RunCheckpoint): Promise<boolean> {
    if (checkpoint.evidence.profileId !== profileId || validateSealedEvidence(checkpoint.evidence).length || !await verifyRunCheckpoint(checkpoint)) return false;
    const now = new Date().toISOString();
    const statements = [
      this.db.prepare("UPDATE agent_runs SET status = 'evidence_sealed', evidence_fingerprint = ?, evidence_json = ?, updated_at = ? WHERE id = ? AND profile_id = ? AND lease_token = ? AND status = 'collecting' AND NOT EXISTS (SELECT 1 FROM run_market_snapshots WHERE run_id = ?)").bind(checkpoint.evidence.fingerprint, JSON.stringify(checkpoint.evidence), now, runId, profileId, leaseToken, runId),
      this.db.prepare("INSERT INTO run_market_snapshots (run_id, snapshot_json, fingerprint, created_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM agent_runs WHERE id = ? AND profile_id = ? AND lease_token = ? AND status = 'evidence_sealed') ON CONFLICT(run_id) DO NOTHING").bind(runId, JSON.stringify(checkpointSnapshotPayload(checkpoint)), checkpoint.integrityFingerprint, now, runId, profileId, leaseToken),
      ...checkpoint.evidence.items.flatMap((item) => {
        const event = item.kind === "market_event" && record(item.value);
        if (!event || typeof event.dedupeKey !== "string") return [];
        return [this.db.prepare("INSERT INTO run_market_events (id, run_id, event_json, dedupe_key, created_at) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM agent_runs WHERE id = ? AND profile_id = ? AND lease_token = ? AND status = 'evidence_sealed')").bind(item.id, runId, JSON.stringify(item.value), event.dedupeKey, now, runId, profileId, leaseToken)];
      }),
    ];
    const responses = await this.db.batch(statements);
    return Boolean(responses[0]?.meta.changes);
  }
  async getCheckpoint(runId: string, profileId: string): Promise<RunCheckpoint | null> {
    const row = await this.db.prepare("SELECT rms.snapshot_json, rms.fingerprint, ar.evidence_json FROM agent_runs ar JOIN run_market_snapshots rms ON rms.run_id = ar.id WHERE ar.id = ? AND ar.profile_id = ? AND ar.evidence_json IS NOT NULL AND ar.status IN ('collecting','evidence_sealed','generating','validating','retry_wait','success','partial')").bind(runId, profileId).first<{ snapshot_json: string; fingerprint: string; evidence_json: string }>();
    if (!row) return null;
    const checkpoint = parseCheckpointRow(row, profileId);
    if (!checkpoint || !await verifyRunCheckpoint(checkpoint)) throw new Error("RUN_CHECKPOINT_INVALID");
    return checkpoint;
  }
  async getPreviousCheckpoint(runId: string, profileId: string): Promise<RunCheckpoint | null> {
    const row = await this.db.prepare("SELECT rms.snapshot_json, rms.fingerprint, previous.evidence_json FROM agent_runs current JOIN agent_runs previous ON previous.profile_id = current.profile_id AND previous.workflow = current.workflow AND (previous.created_at < current.created_at OR (previous.created_at = current.created_at AND previous.id < current.id)) JOIN run_market_snapshots rms ON rms.run_id = previous.id WHERE current.id = ? AND current.profile_id = ? AND previous.status IN ('success','partial') AND previous.evidence_json IS NOT NULL ORDER BY previous.created_at DESC, previous.id DESC LIMIT 1").bind(runId, profileId).first<{ snapshot_json: string; fingerprint: string; evidence_json: string }>();
    const checkpoint = parseCheckpointRow(row, profileId);
    return checkpoint && await verifyRunCheckpoint(checkpoint) ? checkpoint : null;
  }
  async list(profileId: string, limit = 50): Promise<AgentRun[]> { const result = await this.db.prepare("SELECT * FROM agent_runs WHERE profile_id = ? ORDER BY created_at DESC LIMIT ?").bind(profileId, limit).all<Record<string, unknown>>(); return result.results.map(rowToRun); }
  async delete(runId: string, profileId: string): Promise<boolean> {
    const deleted = await this.db.batch([
      this.db.prepare("DELETE FROM agent_feedback WHERE run_id = ? AND profile_id = ?").bind(runId, profileId),
      this.db.prepare("DELETE FROM market_events WHERE run_id = ? AND EXISTS (SELECT 1 FROM agent_runs WHERE id = ? AND profile_id = ?)").bind(runId, runId, profileId),
      this.db.prepare("DELETE FROM run_market_snapshots WHERE run_id = ? AND EXISTS (SELECT 1 FROM agent_runs WHERE id = ? AND profile_id = ?)").bind(runId, runId, profileId),
      this.db.prepare("DELETE FROM run_dispatch_outbox WHERE run_id = ? AND EXISTS (SELECT 1 FROM agent_runs WHERE id = ? AND profile_id = ?)").bind(runId, runId, profileId),
      this.db.prepare("DELETE FROM dead_letter_records WHERE run_id = ? AND EXISTS (SELECT 1 FROM agent_runs WHERE id = ? AND profile_id = ?)").bind(runId, runId, profileId),
      this.db.prepare("DELETE FROM agent_runs WHERE id = ? AND profile_id = ?").bind(runId, profileId),
    ]);
    return Boolean(deleted.at(-1)?.meta.changes);
  }
  async recordFeedback(runId: string, profileId: string, value: AgentFeedbackValue, updatedAt = new Date().toISOString()): Promise<AgentFeedback> {
    await this.db.prepare("INSERT INTO agent_feedback (id, run_id, profile_id, value, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(run_id, profile_id) DO UPDATE SET value = excluded.value, created_at = excluded.created_at").bind(crypto.randomUUID(), runId, profileId, value, updatedAt).run();
    return { value, updatedAt };
  }
  async findByIdempotencyKey(key: string): Promise<AgentRun | null> { const row = await this.db.prepare("SELECT * FROM agent_runs WHERE idempotency_key = ?").bind(key).first<Record<string, unknown>>(); return row ? rowToRun(row) : null; }
  async recordScheduleDecision(input: { workflow: "morning_brief" | "close_review"; marketDate: string; decision: "skipped" | "blocked"; calendarSource: string; reason: string }): Promise<void> { await this.db.prepare("INSERT INTO agent_schedule_decisions (workflow, market_date, decision, calendar_source, reason, decided_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(workflow, market_date) DO NOTHING").bind(input.workflow, input.marketDate, input.decision, input.calendarSource, input.reason, new Date().toISOString()).run(); }
  async runtimeHealth(): Promise<{ retryWait: number; pendingDispatches: number }> { const [runs, outbox] = await this.db.batch([this.db.prepare("SELECT COUNT(*) AS retry_wait FROM agent_runs WHERE status = 'retry_wait'"), this.db.prepare("SELECT COUNT(*) AS pending_dispatches FROM run_dispatch_outbox WHERE status = 'pending'")]); const runCounts = (runs.results?.[0] ?? {}) as Record<string, unknown>; const outboxCounts = (outbox.results?.[0] ?? {}) as Record<string, unknown>; return { retryWait: Number(runCounts.retry_wait ?? 0), pendingDispatches: Number(outboxCounts.pending_dispatches ?? 0) }; }
  async qualityMetrics(profileId: string, limit = 50): Promise<{ total: number; completed: number; model: number; modelRepaired: number; deterministicFallback: number; evidenceSufficient: number; providerFallback: number; portfolioAware: number }> {
    const result = await this.db.prepare("SELECT result_json FROM agent_runs WHERE profile_id = ? AND result_json IS NOT NULL ORDER BY created_at DESC LIMIT ?").bind(profileId, limit).all<{ result_json: string }>();
    const runs = result.results.flatMap((row) => { try { return [compatibleAgentResult(JSON.parse(row.result_json) as AgentResult)]; } catch { return []; } });
    return {
      total: runs.length,
      completed: runs.filter((run) => run.outcome?.execution === "completed").length,
      model: runs.filter((run) => run.outcome?.narration.source === "model").length,
      modelRepaired: runs.filter((run) => run.outcome?.narration.source === "model_repaired").length,
      deterministicFallback: runs.filter((run) => run.outcome?.narration.source === "deterministic_fallback").length,
      evidenceSufficient: runs.filter((run) => run.outcome?.evidence.coverage === "sufficient").length,
      providerFallback: runs.filter((run) => run.outcome?.evidence.delivery === "fallback").length,
      portfolioAware: runs.filter((run) => run.outcome?.mode === "portfolio-aware").length,
    };
  }
  async claim(runId: string, workerId: string, now: string, leaseExpiresAt: string): Promise<RunClaimResult> {
    const token = crypto.randomUUID(); const result = await this.db.prepare("UPDATE agent_runs SET status = 'collecting', attempt = attempt + 1, lease_owner = ?, lease_token = ?, lease_expires_at = ?, updated_at = ? WHERE id = ? AND status IN ('queued','retry_wait','collecting') AND (lease_expires_at IS NULL OR lease_expires_at <= ?)").bind(workerId, token, leaseExpiresAt, now, runId, now).run();
    if (!result.meta.changes) { const run = await this.get(runId); if (!run) return { kind: "missing" }; if (["success", "partial", "failed"].includes(run.status)) return { kind: "terminal" }; return { kind: "leased", retryAfter: now }; }
    const run = await this.get(runId); if (!run) return { kind: "missing" }; return { kind: "claimed", lease: { run, leaseToken: token, attempt: run.attempt, leaseExpiresAt } };
  }
  async advance(runId: string, leaseToken: string, status: "evidence_sealed" | "generating" | "validating"): Promise<boolean> {
    const allowed = status === "evidence_sealed" ? ["collecting"] : status === "generating" ? ["evidence_sealed"] : ["generating"];
    const placeholders = allowed.map(() => "?").join(",");
    const response = await this.db.prepare(`UPDATE agent_runs SET status = ?, updated_at = ? WHERE id = ? AND lease_token = ? AND status IN (${placeholders})`).bind(status, new Date().toISOString(), runId, leaseToken, ...allowed).run();
    return Boolean(response.meta.changes);
  }
  async complete(runId: string, leaseToken: string, evidence: SealedEvidenceBundle, result: AgentResult): Promise<boolean> {
    const now = new Date().toISOString(); const response = await this.db.prepare("UPDATE agent_runs SET status = ?, evidence_fingerprint = ?, evidence_json = ?, result_json = ?, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND lease_token = ? AND status IN ('collecting','evidence_sealed','generating','validating')").bind(result.status, evidence.fingerprint, JSON.stringify(evidence), JSON.stringify(result), now, runId, leaseToken).run(); return Boolean(response.meta.changes);
  }
  async fail(runId: string, leaseToken: string, code: string): Promise<boolean> { const now = new Date().toISOString(); const response = await this.db.prepare("UPDATE agent_runs SET status = 'failed', failure_json = ?, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND lease_token = ?").bind(JSON.stringify({ code, retryable: false }), now, runId, leaseToken).run(); return Boolean(response.meta.changes); }
  async defer(runId: string, leaseToken: string, code: string): Promise<boolean> { const now = new Date().toISOString(); const response = await this.db.prepare("UPDATE agent_runs SET status = 'retry_wait', failure_json = ?, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND lease_token = ?").bind(JSON.stringify({ code, retryable: true }), now, runId, leaseToken).run(); return Boolean(response.meta.changes); }
  async pendingDispatches(limit = 50): Promise<Array<{ id: string; runId: string; generation: number; kind: "initial" | "recovery" }>> { const result = await this.db.prepare("SELECT id, run_id, generation, kind FROM run_dispatch_outbox WHERE status = 'pending' ORDER BY created_at LIMIT ?").bind(limit).all<{ id: string; run_id: string; generation: number; kind: "initial" | "recovery" }>(); return result.results.map((row) => ({ id: row.id, runId: row.run_id, generation: Number(row.generation), kind: row.kind })); }
  async markDispatchSent(id: string): Promise<void> { await this.db.prepare("UPDATE run_dispatch_outbox SET status = 'sent', sent_at = ?, last_error = NULL WHERE id = ? AND status = 'pending'").bind(new Date().toISOString(), id).run(); }
  async markDispatchError(id: string, code: string): Promise<void> { await this.db.prepare("UPDATE run_dispatch_outbox SET last_error = ? WHERE id = ? AND status = 'pending'").bind(code, id).run(); }
  async recordDeadLetter(input: { messageId: string; runId: string | null; generation: number; status: string; errorCode: string }): Promise<void> { const now = new Date().toISOString(); await this.db.prepare("INSERT INTO dead_letter_records (id, run_id, message_id, status, error_code, generation, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(message_id) DO UPDATE SET status = excluded.status, error_code = excluded.error_code, updated_at = excluded.updated_at").bind(crypto.randomUUID(), input.runId, input.messageId, input.status, input.errorCode, input.generation, now, now).run(); }
  async sweepExpired(now: string, maxRecoveryGeneration = 2): Promise<{ recovered: number; failed: number }> {
    const result = await this.db.prepare("SELECT id, recovery_generation FROM agent_runs WHERE status IN ('collecting','evidence_sealed','generating','validating','retry_wait') AND (lease_expires_at IS NULL OR lease_expires_at <= ?) LIMIT 100").bind(now).all<{ id: string; recovery_generation: number }>();
    let recovered = 0; let failed = 0;
    for (const row of result.results) {
      const generation = Number(row.recovery_generation) + 1;
      if (generation > maxRecoveryGeneration) { const response = await this.db.prepare("UPDATE agent_runs SET status = 'failed', failure_json = ?, updated_at = ? WHERE id = ? AND status NOT IN ('success','partial','failed')").bind(JSON.stringify({ code: "RECOVERY_BUDGET_EXHAUSTED", retryable: false }), now, row.id).run(); failed += Number(response.meta.changes ?? 0); continue; }
      const outboxId = crypto.randomUUID();
      const responses = await this.db.batch([
        this.db.prepare("UPDATE agent_runs SET status = 'retry_wait', recovery_generation = ?, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND recovery_generation = ? AND status NOT IN ('success','partial','failed')").bind(generation, now, row.id, row.recovery_generation),
        this.db.prepare("INSERT INTO run_dispatch_outbox (id, run_id, generation, kind, status, created_at) VALUES (?, ?, ?, 'recovery', 'pending', ?) ON CONFLICT(run_id, generation) DO NOTHING").bind(outboxId, row.id, generation, now),
      ]);
      recovered += Number(responses[0].meta.changes ?? 0);
    }
    return { recovered, failed };
  }
}

export type ApplyRunFeedbackOutcome =
  | { kind: "saved"; feedback: AgentFeedback }
  | { kind: "invalid" }
  | { kind: "not_found" };

export async function applyRunFeedback(
  repository: Pick<D1RunRepository, "get" | "recordFeedback">,
  runId: string,
  profileId: string,
  value: unknown,
): Promise<ApplyRunFeedbackOutcome> {
  const run = await repository.get(runId);
  if (run?.profileId !== profileId) return { kind: "not_found" };
  if (!isAgentFeedbackValue(value)) return { kind: "invalid" };
  return { kind: "saved", feedback: await repository.recordFeedback(runId, profileId, value) };
}

function parseCheckpointRow(row: { snapshot_json: string; fingerprint: string; evidence_json: string } | null | undefined, profileId: string): RunCheckpoint | null {
  if (!row?.snapshot_json || !row.evidence_json) return null;
  try {
    const payload = parseCheckpointSnapshotPayload(JSON.parse(row.snapshot_json) as unknown);
    const evidence = JSON.parse(row.evidence_json) as unknown;
    if (validateSealedEvidence(evidence).length) return null;
    const sealed = evidence as SealedEvidenceBundle;
    if (sealed.profileId !== profileId) return null;
    if (!/^sha256:[a-f0-9]{64}$/.test(row.fingerprint)) return null;
    return { ...payload, evidence: sealed, integrityFingerprint: row.fingerprint as `sha256:${string}` };
  } catch {
    return null;
  }
}

function rowToRun(row: Record<string, unknown>): AgentRun { return { id: String(row.id), profileId: String(row.profile_id), workflow: row.workflow as AgentRun["workflow"], trigger: row.trigger as AgentRun["trigger"], status: row.status as AgentRun["status"], idempotencyKey: String(row.idempotency_key), commandHash: String(row.command_hash), revisionOfRunId: row.revision_of_run_id ? String(row.revision_of_run_id) : null, portfolioSnapshotId: row.portfolio_snapshot_id ? String(row.portfolio_snapshot_id) : null, attempt: Number(row.attempt ?? 0), recoveryGeneration: Number(row.recovery_generation ?? 0), createdAt: String(row.created_at), updatedAt: String(row.updated_at), evidenceFingerprint: row.evidence_fingerprint ? String(row.evidence_fingerprint) : null, failure: row.failure_json ? JSON.parse(String(row.failure_json)) : null, ...(row.result_json ? { result: compatibleAgentResult(JSON.parse(String(row.result_json)) as AgentResult) } : {}) }; }
function record(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function isAgentFeedbackValue(value: unknown): value is AgentFeedbackValue { return value === "helpful" || value === "fact_error" || value === "missing_factor"; }
