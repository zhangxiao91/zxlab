import { compatibleAgentResult, isCancellableRunStatus, isRunTraceEvent, isTerminalRunStatus, validateSealedEvidence, type AgentFeedback, type AgentFeedbackValue, type AgentResult, type AgentRun, type MarketAgentCommand, type RunClaimResult, type RunCreation, type RunStatus, type RunTiming, type RunTrace, type RunTraceEvent, type RunTraceEventType, type RunTraceOperation, type SealedEvidenceBundle } from "@zxlab/market-agent-schema";
import { checkpointSnapshotPayload, parseCheckpointSnapshotPayload, verifyRunCheckpoint, type RunCheckpoint } from "./run-checkpoint.ts";

export class D1RunRepository {
  private readonly db: D1Database;
  constructor(db: D1Database) { this.db = db; }
  async createQueued(command: MarketAgentCommand, request: RunCreation): Promise<{ run: AgentRun; created: boolean }> {
    const existing = await this.db.prepare("SELECT * FROM agent_runs WHERE profile_id = ? AND idempotency_key = ?").bind(command.profileId, command.idempotencyKey).first<Record<string, unknown>>();
    if (existing) { if (existing.command_hash !== request.commandHash) throw new Error("IDEMPOTENCY_KEY_REUSED"); return { run: rowToRun(existing), created: false }; }
    const now = new Date().toISOString(); const id = crypto.randomUUID(); const transitionId = crypto.randomUUID();
    await this.db.batch([
      this.db.prepare("INSERT INTO agent_runs (id, profile_id, workflow, trigger, status, idempotency_key, command_hash, revision_of_run_id, portfolio_snapshot_id, command_json, created_at, updated_at, last_transition_id, stage_started_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, command.profileId, command.workflow, command.trigger, command.idempotencyKey, request.commandHash, request.revisionOfRunId ?? null, request.portfolioSnapshotId ?? null, JSON.stringify(command), now, now, transitionId, now),
      this.db.prepare("INSERT INTO run_dispatch_outbox (id, run_id, generation, kind, status, created_at) VALUES (?, ?, 0, 'initial', 'pending', ?)").bind(crypto.randomUUID(), id, now),
      traceInsert(this.db, { runId: id, profileId: command.profileId, type: "run_created", stage: "queued", attempt: 0, recoveryGeneration: 0, occurredAt: now, operation: "run.create" }),
    ]);
    const run = await this.get(id); if (!run) throw new Error("RUN_CREATE_FAILED"); return { run, created: true };
  }
  async get(id: string): Promise<AgentRun | null> { const row = await this.db.prepare("SELECT * FROM agent_runs WHERE id = ?").bind(id).first<Record<string, unknown>>(); return row ? rowToRun(row) : null; }
  async getScoped(id: string, profileId: string): Promise<AgentRun | null> { const row = await this.db.prepare("SELECT * FROM agent_runs WHERE id = ? AND profile_id = ?").bind(id, profileId).first<Record<string, unknown>>(); return row ? rowToRun(row) : null; }
  async getTrace(runId: string, profileId: string, serverNow = new Date().toISOString()): Promise<RunTrace | null> {
    const run = await this.getScoped(runId, profileId);
    if (!run) return null;
    const result = await this.db.prepare("SELECT sequence, id, run_id, type, stage, attempt, recovery_generation, occurred_at, duration_ms, source, operation, code FROM run_trace_events WHERE run_id = ? AND profile_id = ? ORDER BY sequence ASC LIMIT 257").bind(runId, profileId).all<Record<string, unknown>>();
    if (result.results.length > 256) throw new Error("RUN_TRACE_LIMIT_EXCEEDED");
    return { runId, timing: runTiming(run, serverNow), events: parseTraceRows(result.results) };
  }
  async listTraceAfter(runId: string, profileId: string, afterSequence: number): Promise<RunTraceEvent[]> {
    const boundedSequence = Number.isSafeInteger(afterSequence) && afterSequence >= 0 ? afterSequence : 0;
    const result = await this.db.prepare("SELECT sequence, id, run_id, type, stage, attempt, recovery_generation, occurred_at, duration_ms, source, operation, code FROM run_trace_events WHERE run_id = ? AND profile_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT 64").bind(runId, profileId, boundedSequence).all<Record<string, unknown>>();
    return parseTraceRows(result.results);
  }
  async cancel(runId: string, profileId: string, now = new Date().toISOString()): Promise<RunCancellationOutcome> {
    const current = await this.getScoped(runId, profileId);
    if (!current) return { kind: "not_found" };
    if (current.status === "cancelled") return { kind: "already_cancelled", run: current };
    if (!isCancellableRunStatus(current.status)) return { kind: "conflict", status: current.status };
    const durationMs = runElapsedMs(current.createdAt, now);
    const transitionId = crypto.randomUUID();
    const responses = await this.db.batch([
      traceStageCompleteForCancel(this.db, { runId, profileId, status: current.status, occurredAt: now }),
      this.db.prepare("UPDATE agent_runs SET status = 'cancelled', failure_json = NULL, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, completed_at = ?, duration_ms = ?, updated_at = ?, last_transition_id = ? WHERE id = ? AND profile_id = ? AND status = ?").bind(now, durationMs, now, transitionId, runId, profileId, current.status),
      this.db.prepare("UPDATE run_dispatch_outbox SET status = 'cancelled', last_error = NULL WHERE run_id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM agent_runs WHERE id = ? AND profile_id = ? AND last_transition_id = ?)").bind(runId, runId, profileId, transitionId),
      traceInsertForTransition(this.db, { runId, transitionId, type: "cancel_requested", stage: current.status, occurredAt: now, operation: "run.cancel" }),
      traceInsertForTransition(this.db, { runId, transitionId, type: "run_cancelled", stage: "cancelled", occurredAt: now, duration: true, operation: "run.cancel" }),
    ]);
    if (!responses[1]?.meta.changes) {
      const raced = await this.getScoped(runId, profileId);
      if (!raced) return { kind: "not_found" };
      return raced.status === "cancelled" ? { kind: "already_cancelled", run: raced } : { kind: "conflict", status: raced.status };
    }
    const run = await this.getScoped(runId, profileId);
    return run ? { kind: "cancelled", run } : { kind: "not_found" };
  }
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
    const transitionId = crypto.randomUUID();
    const statements = [
      traceStageCompleteForLease(this.db, { runId, leaseToken, statuses: ["collecting"], occurredAt: now, requireNoSnapshot: true }),
      this.db.prepare("UPDATE agent_runs SET status = 'evidence_sealed', evidence_fingerprint = ?, evidence_json = ?, updated_at = ?, last_transition_id = ?, stage_started_at = ? WHERE id = ? AND profile_id = ? AND lease_token = ? AND status = 'collecting' AND NOT EXISTS (SELECT 1 FROM run_market_snapshots WHERE run_id = ?)").bind(checkpoint.evidence.fingerprint, JSON.stringify(checkpoint.evidence), now, transitionId, now, runId, profileId, leaseToken, runId),
      this.db.prepare("INSERT INTO run_market_snapshots (run_id, snapshot_json, fingerprint, created_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM agent_runs WHERE id = ? AND profile_id = ? AND lease_token = ? AND status = 'evidence_sealed' AND last_transition_id = ?) ON CONFLICT(run_id) DO NOTHING").bind(runId, JSON.stringify(checkpointSnapshotPayload(checkpoint)), checkpoint.integrityFingerprint, now, runId, profileId, leaseToken, transitionId),
      ...checkpoint.evidence.items.flatMap((item) => {
        const event = item.kind === "market_event" && record(item.value);
        if (!event || typeof event.dedupeKey !== "string") return [];
        return [this.db.prepare("INSERT INTO run_market_events (id, run_id, event_json, dedupe_key, created_at) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM agent_runs WHERE id = ? AND profile_id = ? AND lease_token = ? AND status = 'evidence_sealed' AND last_transition_id = ?)").bind(item.id, runId, JSON.stringify(item.value), event.dedupeKey, now, runId, profileId, leaseToken, transitionId)];
      }),
      traceInsertForTransition(this.db, { runId, transitionId, type: "stage_started", stage: "evidence_sealed", occurredAt: now, operation: "evidence.seal" }),
    ];
    const responses = await this.db.batch(statements);
    return Boolean(responses[1]?.meta.changes);
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
      this.db.prepare("DELETE FROM financial_tool_trace_events WHERE run_id = ? AND profile_id = ? AND EXISTS (SELECT 1 FROM agent_runs WHERE id = ? AND profile_id = ?)").bind(runId, profileId, runId, profileId),
      this.db.prepare("DELETE FROM financial_tool_invocations WHERE run_id = ? AND profile_id = ? AND EXISTS (SELECT 1 FROM agent_runs WHERE id = ? AND profile_id = ?)").bind(runId, profileId, runId, profileId),
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
    const token = crypto.randomUUID(); const transitionId = crypto.randomUUID();
    const responses = await this.db.batch([
      traceStageCompleteForClaim(this.db, { runId, occurredAt: now, leaseCutoff: now }),
      this.db.prepare("UPDATE agent_runs SET status = 'collecting', attempt = attempt + 1, lease_owner = ?, lease_token = ?, lease_expires_at = ?, started_at = COALESCE(started_at, ?), completed_at = NULL, duration_ms = NULL, updated_at = ?, last_transition_id = ?, stage_started_at = ? WHERE id = ? AND status IN ('queued','retry_wait','collecting') AND (lease_expires_at IS NULL OR lease_expires_at <= ?)").bind(workerId, token, leaseExpiresAt, now, now, transitionId, now, runId, now),
      traceInsertForTransition(this.db, { runId, transitionId, type: "stage_started", stage: "collecting", occurredAt: now, operation: "run.claim" }),
    ]);
    if (!responses[1]?.meta.changes) { const run = await this.get(runId); if (!run) return { kind: "missing" }; if (isTerminalRunStatus(run.status)) return { kind: "terminal" }; return { kind: "leased", retryAfter: now }; }
    const run = await this.get(runId); if (!run) return { kind: "missing" };
    return { kind: "claimed", lease: { run, leaseToken: token, attempt: run.attempt, leaseExpiresAt } };
  }
  async advance(runId: string, leaseToken: string, status: "evidence_sealed" | "generating" | "validating"): Promise<boolean> {
    const allowed = status === "evidence_sealed" ? ["collecting"] : status === "generating" ? ["evidence_sealed"] : ["generating"];
    const placeholders = allowed.map(() => "?").join(",");
    const now = new Date().toISOString(); const transitionId = crypto.randomUUID();
    const operation = status === "evidence_sealed" ? "evidence.seal" : status === "generating" ? "narration.generate" : "result.validate";
    const responses = await this.db.batch([
      traceStageCompleteForLease(this.db, { runId, leaseToken, statuses: allowed as RunStatus[], occurredAt: now }),
      this.db.prepare(`UPDATE agent_runs SET status = ?, updated_at = ?, last_transition_id = ?, stage_started_at = ? WHERE id = ? AND lease_token = ? AND status IN (${placeholders})`).bind(status, now, transitionId, now, runId, leaseToken, ...allowed),
      traceInsertForTransition(this.db, { runId, transitionId, type: "stage_started", stage: status, occurredAt: now, operation }),
    ]);
    return Boolean(responses[1]?.meta.changes);
  }
  async complete(runId: string, leaseToken: string, evidence: SealedEvidenceBundle, result: AgentResult): Promise<boolean> {
    const now = new Date().toISOString(); const transitionId = crypto.randomUUID();
    const responses = await this.db.batch([
      traceStageCompleteForLease(this.db, { runId, leaseToken, statuses: ["collecting", "evidence_sealed", "generating", "validating"], occurredAt: now }),
      this.db.prepare("UPDATE agent_runs SET status = ?, evidence_fingerprint = ?, evidence_json = ?, result_json = ?, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, completed_at = ?, duration_ms = MAX(0, CAST((julianday(?) - julianday(created_at)) * 86400000 AS INTEGER)), updated_at = ?, last_transition_id = ? WHERE id = ? AND lease_token = ? AND status IN ('collecting','evidence_sealed','generating','validating')").bind(result.status, evidence.fingerprint, JSON.stringify(evidence), JSON.stringify(result), now, now, now, transitionId, runId, leaseToken),
      traceInsertForTransition(this.db, { runId, transitionId, type: "run_completed", stage: result.status, occurredAt: now, duration: true, operation: "run.complete" }),
    ]);
    return Boolean(responses[1]?.meta.changes);
  }
  async fail(runId: string, leaseToken: string, code: string): Promise<boolean> { const now = new Date().toISOString(); const safeCode = boundedErrorCode(code) ?? "RUN_FAILED"; const transitionId = crypto.randomUUID(); const responses = await this.db.batch([traceStageCompleteForLease(this.db, { runId, leaseToken, statuses: ["collecting", "evidence_sealed", "generating", "validating"], occurredAt: now, code: safeCode }), this.db.prepare("UPDATE agent_runs SET status = 'failed', failure_json = ?, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, completed_at = ?, duration_ms = MAX(0, CAST((julianday(?) - julianday(created_at)) * 86400000 AS INTEGER)), updated_at = ?, last_transition_id = ? WHERE id = ? AND lease_token = ? AND status IN ('collecting','evidence_sealed','generating','validating')").bind(JSON.stringify({ code: safeCode, retryable: false }), now, now, now, transitionId, runId, leaseToken), traceInsertForTransition(this.db, { runId, transitionId, type: "run_failed", stage: "failed", occurredAt: now, duration: true, operation: "run.fail", code: safeCode })]); return Boolean(responses[1]?.meta.changes); }
  async defer(runId: string, leaseToken: string, code: string): Promise<boolean> { const now = new Date().toISOString(); const safeCode = boundedErrorCode(code) ?? "RUN_RETRYABLE"; const transitionId = crypto.randomUUID(); const responses = await this.db.batch([traceStageCompleteForLease(this.db, { runId, leaseToken, statuses: ["collecting", "evidence_sealed", "generating", "validating"], occurredAt: now, code: safeCode }), this.db.prepare("UPDATE agent_runs SET status = 'retry_wait', failure_json = ?, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ?, last_transition_id = ?, stage_started_at = ? WHERE id = ? AND lease_token = ? AND status IN ('collecting','evidence_sealed','generating','validating')").bind(JSON.stringify({ code: safeCode, retryable: true }), now, transitionId, now, runId, leaseToken), traceInsertForTransition(this.db, { runId, transitionId, type: "retry_scheduled", stage: "retry_wait", occurredAt: now, operation: "run.retry", code: safeCode })]); return Boolean(responses[1]?.meta.changes); }
  async pendingDispatches(limit = 50): Promise<Array<{ id: string; runId: string; generation: number; kind: "initial" | "recovery" }>> { const result = await this.db.prepare("SELECT id, run_id, generation, kind FROM run_dispatch_outbox WHERE status = 'pending' ORDER BY created_at LIMIT ?").bind(limit).all<{ id: string; run_id: string; generation: number; kind: "initial" | "recovery" }>(); return result.results.map((row) => ({ id: row.id, runId: row.run_id, generation: Number(row.generation), kind: row.kind })); }
  async markDispatchSent(id: string): Promise<void> { await this.db.prepare("UPDATE run_dispatch_outbox SET status = 'sent', sent_at = ?, last_error = NULL WHERE id = ? AND status = 'pending'").bind(new Date().toISOString(), id).run(); }
  async markDispatchError(id: string, code: string): Promise<void> { await this.db.prepare("UPDATE run_dispatch_outbox SET last_error = ? WHERE id = ? AND status = 'pending'").bind(code, id).run(); }
  async recordDeadLetter(input: { messageId: string; runId: string | null; generation: number; status: string; errorCode: string }): Promise<void> { const now = new Date().toISOString(); await this.db.prepare("INSERT INTO dead_letter_records (id, run_id, message_id, status, error_code, generation, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(message_id) DO UPDATE SET status = excluded.status, error_code = excluded.error_code, updated_at = excluded.updated_at").bind(crypto.randomUUID(), input.runId, input.messageId, input.status, input.errorCode, input.generation, now, now).run(); }
  async sweepExpired(now: string, maxRecoveryGeneration = 2): Promise<{ recovered: number; failed: number }> {
    const result = await this.db.prepare("SELECT id, recovery_generation FROM agent_runs WHERE status IN ('collecting','evidence_sealed','generating','validating','retry_wait') AND (lease_expires_at IS NULL OR lease_expires_at <= ?) LIMIT 100").bind(now).all<{ id: string; recovery_generation: number }>();
    let recovered = 0; let failed = 0;
    for (const row of result.results) {
      const generation = Number(row.recovery_generation) + 1;
      if (generation > maxRecoveryGeneration) { const transitionId = crypto.randomUUID(); const responses = await this.db.batch([traceStageCompleteForSweep(this.db, { runId: row.id, recoveryGeneration: row.recovery_generation, occurredAt: now }), this.db.prepare("UPDATE agent_runs SET status = 'failed', failure_json = ?, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, completed_at = ?, duration_ms = MAX(0, CAST((julianday(?) - julianday(created_at)) * 86400000 AS INTEGER)), updated_at = ?, last_transition_id = ? WHERE id = ? AND recovery_generation = ? AND status NOT IN ('success','partial','failed','cancelled')").bind(JSON.stringify({ code: "RECOVERY_BUDGET_EXHAUSTED", retryable: false }), now, now, now, transitionId, row.id, row.recovery_generation), traceInsertForTransition(this.db, { runId: row.id, transitionId, type: "run_failed", stage: "failed", occurredAt: now, duration: true, operation: "run.fail", code: "RECOVERY_BUDGET_EXHAUSTED" })]); failed += Number(responses[1]?.meta.changes ?? 0); continue; }
      const outboxId = crypto.randomUUID();
      const transitionId = crypto.randomUUID();
      const responses = await this.db.batch([
        traceStageCompleteForSweep(this.db, { runId: row.id, recoveryGeneration: row.recovery_generation, occurredAt: now }),
        this.db.prepare("UPDATE agent_runs SET status = 'retry_wait', recovery_generation = ?, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ?, last_transition_id = ?, stage_started_at = ? WHERE id = ? AND recovery_generation = ? AND status NOT IN ('success','partial','failed','cancelled')").bind(generation, now, transitionId, now, row.id, row.recovery_generation),
        this.db.prepare("INSERT INTO run_dispatch_outbox (id, run_id, generation, kind, status, created_at) SELECT ?, ?, ?, 'recovery', 'pending', ? WHERE EXISTS (SELECT 1 FROM agent_runs WHERE id = ? AND last_transition_id = ?) ON CONFLICT(run_id, generation) DO NOTHING").bind(outboxId, row.id, generation, now, row.id, transitionId),
        traceInsertForTransition(this.db, { runId: row.id, transitionId, type: "retry_scheduled", stage: "retry_wait", occurredAt: now, operation: "run.retry", code: "LEASE_EXPIRED" }),
      ]);
      recovered += Number(responses[1]?.meta.changes ?? 0);
    }
    return { recovered, failed };
  }

}

export type ApplyRunFeedbackOutcome =
  | { kind: "saved"; feedback: AgentFeedback }
  | { kind: "invalid" }
  | { kind: "not_found" };

export type RunCancellationOutcome =
  | { kind: "cancelled"; run: AgentRun }
  | { kind: "already_cancelled"; run: AgentRun }
  | { kind: "conflict"; status: RunStatus }
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

function rowToRun(row: Record<string, unknown>): AgentRun {
  const run: AgentRun = { id: String(row.id), profileId: String(row.profile_id), workflow: row.workflow as AgentRun["workflow"], trigger: row.trigger as AgentRun["trigger"], status: row.status as AgentRun["status"], idempotencyKey: String(row.idempotency_key), commandHash: String(row.command_hash), revisionOfRunId: row.revision_of_run_id ? String(row.revision_of_run_id) : null, portfolioSnapshotId: row.portfolio_snapshot_id ? String(row.portfolio_snapshot_id) : null, attempt: Number(row.attempt ?? 0), recoveryGeneration: Number(row.recovery_generation ?? 0), createdAt: String(row.created_at), updatedAt: String(row.updated_at), evidenceFingerprint: row.evidence_fingerprint ? String(row.evidence_fingerprint) : null, failure: row.failure_json ? JSON.parse(String(row.failure_json)) : null, ...(row.result_json ? { result: compatibleAgentResult(JSON.parse(String(row.result_json)) as AgentResult) } : {}) };
  return {
    ...run,
    timing: persistedRunTiming(row),
  };
}
function runTiming(run: AgentRun, serverNow: string): RunTiming {
  const startedAt = run.timing?.startedAt ?? null;
  const completedAt = run.timing?.completedAt ?? null;
  return {
    queuedAt: run.createdAt,
    startedAt,
    updatedAt: run.updatedAt,
    completedAt,
    elapsedMs: runExecutionElapsedMs(startedAt, completedAt, serverNow),
    durationMs: run.timing?.durationMs ?? null,
    serverNow,
  };
}
function rowToTraceEvent(row: Record<string, unknown>): RunTraceEvent | null {
  const sequence = Number(row.sequence);
  const attempt = Number(row.attempt);
  const recoveryGeneration = Number(row.recovery_generation);
  const type = row.type;
  const operation = row.operation;
  const stage = row.stage;
  const occurredAt = boundedIso(row.occurred_at);
  const id = boundedTraceId(row.id);
  const runId = boundedTraceId(row.run_id);
  if (!Number.isSafeInteger(sequence) || sequence <= 0 || !Number.isSafeInteger(attempt) || attempt < 0 || attempt > 100 || !Number.isSafeInteger(recoveryGeneration) || recoveryGeneration < 0 || recoveryGeneration > 100 || !isRunTraceEventType(type) || !isRunTraceOperation(operation) || !occurredAt || !id || !runId || row.source !== "market-agent-worker") return null;
  const durationMs = boundedDuration(row.duration_ms);
  const code = boundedErrorCode(row.code);
  const event = {
    id,
    runId,
    sequence,
    type,
    stage,
    attempt,
    recoveryGeneration,
    occurredAt,
    ...(durationMs !== null ? { durationMs } : {}),
    provenance: { source: "market-agent-worker", operation },
    ...(code ? { code } : {}),
  };
  return isRunTraceEvent(event) ? event : null;
}
function parseTraceRows(rows: Record<string, unknown>[]): RunTraceEvent[] {
  return rows.map((row) => {
    const event = rowToTraceEvent(row);
    if (!event) throw new Error("RUN_TRACE_CORRUPT");
    return event;
  });
}
function traceInsert(db: D1Database, event: { runId: string; profileId: string; type: "run_created"; stage: "queued"; attempt: number; recoveryGeneration: number; occurredAt: string; operation: "run.create" }): D1PreparedStatement {
  return db.prepare("INSERT INTO run_trace_events (id, run_id, profile_id, type, stage, attempt, recovery_generation, occurred_at, duration_ms, source, operation, code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'market-agent-worker', ?, NULL) ON CONFLICT DO NOTHING").bind(crypto.randomUUID(), event.runId, event.profileId, event.type, event.stage, event.attempt, event.recoveryGeneration, event.occurredAt, event.operation);
}
function traceInsertForTransition(db: D1Database, event: { runId: string; transitionId: string; type: RunTraceEventType; stage: RunStatus; occurredAt: string; duration?: boolean; operation: RunTraceOperation; code?: string }): D1PreparedStatement {
  return db.prepare("INSERT INTO run_trace_events (id, run_id, profile_id, type, stage, attempt, recovery_generation, occurred_at, duration_ms, source, operation, code) SELECT ?, id, profile_id, ?, ?, attempt, recovery_generation, ?, CASE WHEN ? = 1 THEN duration_ms ELSE NULL END, 'market-agent-worker', ?, ? FROM agent_runs WHERE id = ? AND last_transition_id = ? ON CONFLICT DO NOTHING").bind(crypto.randomUUID(), event.type, event.stage, event.occurredAt, event.duration ? 1 : 0, event.operation, boundedErrorCode(event.code), event.runId, event.transitionId);
}
function traceStageCompleteForLease(db: D1Database, event: { runId: string; leaseToken: string; statuses: RunStatus[]; occurredAt: string; code?: string; requireNoSnapshot?: boolean }): D1PreparedStatement {
  const placeholders = event.statuses.map(() => "?").join(",");
  const snapshotGuard = event.requireNoSnapshot ? " AND NOT EXISTS (SELECT 1 FROM run_market_snapshots WHERE run_id = agent_runs.id)" : "";
  return db.prepare(`INSERT INTO run_trace_events (id, run_id, profile_id, type, stage, attempt, recovery_generation, occurred_at, duration_ms, source, operation, code) SELECT ?, id, profile_id, 'stage_completed', status, attempt, recovery_generation, ?, MAX(0, CAST((julianday(?) - julianday(stage_started_at)) * 86400000 AS INTEGER)), 'market-agent-worker', CASE status WHEN 'collecting' THEN 'run.collect' WHEN 'evidence_sealed' THEN 'evidence.seal' WHEN 'generating' THEN 'narration.generate' WHEN 'validating' THEN 'result.validate' ELSE 'run.retry' END, ? FROM agent_runs WHERE id = ? AND lease_token = ? AND stage_started_at IS NOT NULL AND status IN (${placeholders})${snapshotGuard} ON CONFLICT DO NOTHING`).bind(crypto.randomUUID(), event.occurredAt, event.occurredAt, boundedErrorCode(event.code), event.runId, event.leaseToken, ...event.statuses);
}
function traceStageCompleteForClaim(db: D1Database, event: { runId: string; occurredAt: string; leaseCutoff: string }): D1PreparedStatement {
  return db.prepare("INSERT INTO run_trace_events (id, run_id, profile_id, type, stage, attempt, recovery_generation, occurred_at, duration_ms, source, operation, code) SELECT ?, id, profile_id, 'stage_completed', status, attempt, recovery_generation, ?, MAX(0, CAST((julianday(?) - julianday(stage_started_at)) * 86400000 AS INTEGER)), 'market-agent-worker', CASE status WHEN 'retry_wait' THEN 'run.retry' WHEN 'collecting' THEN 'run.collect' ELSE 'run.claim' END, NULL FROM agent_runs WHERE id = ? AND stage_started_at IS NOT NULL AND status IN ('queued','retry_wait','collecting') AND (lease_expires_at IS NULL OR lease_expires_at <= ?) ON CONFLICT DO NOTHING").bind(crypto.randomUUID(), event.occurredAt, event.occurredAt, event.runId, event.leaseCutoff);
}
function traceStageCompleteForCancel(db: D1Database, event: { runId: string; profileId: string; status: RunStatus; occurredAt: string }): D1PreparedStatement {
  return db.prepare("INSERT INTO run_trace_events (id, run_id, profile_id, type, stage, attempt, recovery_generation, occurred_at, duration_ms, source, operation, code) SELECT ?, id, profile_id, 'stage_completed', status, attempt, recovery_generation, ?, MAX(0, CAST((julianday(?) - julianday(stage_started_at)) * 86400000 AS INTEGER)), 'market-agent-worker', 'run.cancel', NULL FROM agent_runs WHERE id = ? AND profile_id = ? AND stage_started_at IS NOT NULL AND status = ? ON CONFLICT DO NOTHING").bind(crypto.randomUUID(), event.occurredAt, event.occurredAt, event.runId, event.profileId, event.status);
}
function traceStageCompleteForSweep(db: D1Database, event: { runId: string; recoveryGeneration: number; occurredAt: string }): D1PreparedStatement {
  return db.prepare("INSERT INTO run_trace_events (id, run_id, profile_id, type, stage, attempt, recovery_generation, occurred_at, duration_ms, source, operation, code) SELECT ?, id, profile_id, 'stage_completed', status, attempt, recovery_generation, ?, MAX(0, CAST((julianday(?) - julianday(stage_started_at)) * 86400000 AS INTEGER)), 'market-agent-worker', 'run.retry', 'LEASE_EXPIRED' FROM agent_runs WHERE id = ? AND recovery_generation = ? AND stage_started_at IS NOT NULL AND status IN ('collecting','evidence_sealed','generating','validating','retry_wait') ON CONFLICT DO NOTHING").bind(crypto.randomUUID(), event.occurredAt, event.occurredAt, event.runId, event.recoveryGeneration);
}
function runExecutionElapsedMs(startedAt: string | null, completedAt: string | null, serverNow: string): number { return startedAt ? runElapsedMs(startedAt, completedAt ?? serverNow) : 0; }
function runElapsedMs(startedAt: string, endedAt: string): number { const elapsed = Date.parse(endedAt) - Date.parse(startedAt); return Number.isFinite(elapsed) ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(elapsed))) : 0; }
function boundedDuration(value: unknown): number | null { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null; }
function boundedIso(value: unknown): string | null { return typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null; }
function boundedTraceId(value: unknown): string | null { return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : null; }
function boundedErrorCode(value: unknown): string | null { return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : null; }
function isRunTraceEventType(value: unknown): value is RunTraceEventType { return typeof value === "string" && ["run_created", "stage_started", "stage_completed", "retry_scheduled", "cancel_requested", "run_cancelled", "run_completed", "run_failed"].includes(value); }
function isRunTraceOperation(value: unknown): value is RunTraceOperation { return typeof value === "string" && ["run.create", "run.claim", "run.collect", "evidence.seal", "narration.generate", "result.validate", "run.retry", "run.cancel", "run.complete", "run.fail"].includes(value); }
export function persistedRunTiming(row: Record<string, unknown>, serverNow = new Date().toISOString()): RunTiming {
  const queuedAt = boundedIso(row.created_at) ?? String(row.created_at);
  const updatedAt = boundedIso(row.updated_at) ?? String(row.updated_at);
  const startedAt = boundedIso(row.started_at);
  const completedAt = boundedIso(row.completed_at);
  return { queuedAt, startedAt, updatedAt, completedAt, elapsedMs: runExecutionElapsedMs(startedAt, completedAt, serverNow), durationMs: boundedDuration(row.duration_ms), serverNow };
}
function record(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function isAgentFeedbackValue(value: unknown): value is AgentFeedbackValue { return value === "helpful" || value === "fact_error" || value === "missing_factor"; }
