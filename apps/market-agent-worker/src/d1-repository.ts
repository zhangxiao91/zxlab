import type { AgentResult, AgentRun, MarketAgentCommand, RunClaimResult, RunCreation, SealedEvidenceBundle } from "@zxlab/market-agent-schema";

export class D1RunRepository {
  constructor(private readonly db: D1Database) {}
  async createQueued(command: MarketAgentCommand, request: RunCreation): Promise<{ run: AgentRun; created: boolean }> {
    const existing = await this.db.prepare("SELECT * FROM agent_runs WHERE profile_id = ? AND idempotency_key = ?").bind(command.profileId, command.idempotencyKey).first<Record<string, unknown>>();
    if (existing) { if (existing.command_hash !== request.commandHash) throw new Error("IDEMPOTENCY_KEY_REUSED"); return { run: rowToRun(existing), created: false }; }
    const now = new Date().toISOString(); const id = crypto.randomUUID();
    await this.db.batch([
      this.db.prepare("INSERT INTO agent_runs (id, profile_id, workflow, trigger, status, idempotency_key, command_hash, revision_of_run_id, command_json, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)").bind(id, command.profileId, command.workflow, command.trigger, command.idempotencyKey, request.commandHash, request.revisionOfRunId ?? null, JSON.stringify(command), now, now),
      this.db.prepare("INSERT INTO run_dispatch_outbox (id, run_id, generation, kind, status, created_at) VALUES (?, ?, 0, 'initial', 'pending', ?)").bind(crypto.randomUUID(), id, now),
    ]);
    const run = await this.get(id); if (!run) throw new Error("RUN_CREATE_FAILED"); return { run, created: true };
  }
  async get(id: string): Promise<AgentRun | null> { const row = await this.db.prepare("SELECT * FROM agent_runs WHERE id = ?").bind(id).first<Record<string, unknown>>(); return row ? rowToRun(row) : null; }
  async getCommand(id: string): Promise<MarketAgentCommand | null> { const row = await this.db.prepare("SELECT command_json FROM agent_runs WHERE id = ?").bind(id).first<{ command_json: string | null }>(); return row?.command_json ? JSON.parse(row.command_json) as MarketAgentCommand : null; }
  async list(profileId: string, limit = 50): Promise<AgentRun[]> { const result = await this.db.prepare("SELECT * FROM agent_runs WHERE profile_id = ? ORDER BY created_at DESC LIMIT ?").bind(profileId, limit).all<Record<string, unknown>>(); return result.results.map(rowToRun); }
  async recordFeedback(runId: string, profileId: string, value: string): Promise<void> { await this.db.prepare("INSERT INTO agent_feedback (id, run_id, profile_id, value, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(run_id, profile_id) DO UPDATE SET value = excluded.value, created_at = excluded.created_at").bind(crypto.randomUUID(), runId, profileId, value, new Date().toISOString()).run(); }
  async findByIdempotencyKey(key: string): Promise<AgentRun | null> { const row = await this.db.prepare("SELECT * FROM agent_runs WHERE idempotency_key = ?").bind(key).first<Record<string, unknown>>(); return row ? rowToRun(row) : null; }
  async claim(runId: string, workerId: string, now: string, leaseExpiresAt: string): Promise<RunClaimResult> {
    const token = crypto.randomUUID(); const result = await this.db.prepare("UPDATE agent_runs SET status = 'collecting', attempt = attempt + 1, lease_owner = ?, lease_token = ?, lease_expires_at = ?, updated_at = ? WHERE id = ? AND status IN ('queued','retry_wait','collecting') AND (lease_expires_at IS NULL OR lease_expires_at <= ?)").bind(workerId, token, leaseExpiresAt, now, runId, now).run();
    if (!result.meta.changes) { const run = await this.get(runId); if (!run) return { kind: "missing" }; if (["success", "partial", "failed"].includes(run.status)) return { kind: "terminal" }; return { kind: "leased", retryAfter: now }; }
    const run = await this.get(runId); if (!run) return { kind: "missing" }; return { kind: "claimed", lease: { run, leaseToken: token, attempt: run.attempt, leaseExpiresAt } };
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

function rowToRun(row: Record<string, unknown>): AgentRun { return { id: String(row.id), profileId: String(row.profile_id), workflow: row.workflow as AgentRun["workflow"], trigger: row.trigger as AgentRun["trigger"], status: row.status as AgentRun["status"], idempotencyKey: String(row.idempotency_key), commandHash: String(row.command_hash), revisionOfRunId: row.revision_of_run_id ? String(row.revision_of_run_id) : null, attempt: Number(row.attempt ?? 0), recoveryGeneration: Number(row.recovery_generation ?? 0), createdAt: String(row.created_at), updatedAt: String(row.updated_at), evidenceFingerprint: row.evidence_fingerprint ? String(row.evidence_fingerprint) : null, failure: row.failure_json ? JSON.parse(String(row.failure_json)) : null, ...(row.result_json ? { result: JSON.parse(String(row.result_json)) as AgentResult } : {}) }; }
