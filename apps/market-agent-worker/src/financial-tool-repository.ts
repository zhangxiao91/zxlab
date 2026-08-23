import { parseResearchFactBundle, verifyResearchFactBundleFingerprint, type ResearchFactBundle } from "@zxlab/research-fact-schema";
import { isToolTraceEvent, type FinancialToolOutcome, type FinancialToolSelectionSource, type ToolTrace, type ToolTraceEvent } from "@zxlab/market-agent-schema";

export type FinancialToolDecision = "invoke" | "skip";
export type FinancialToolInvocationStatus = "planned" | "skipped" | "pending" | "completed" | "failed";

export interface FinancialToolInvocationRecord {
  invocationId: string;
  runId: string;
  profileId: string;
  policyVersion: string;
  toolId: string;
  toolVersion: string;
  ordinal: number;
  decision: FinancialToolDecision;
  selectionSource: FinancialToolSelectionSource;
  status: FinancialToolInvocationStatus;
  attempt: number;
  outcome?: FinancialToolOutcome;
  safeErrorCode?: string;
  researchFingerprint?: ResearchFactBundle["fingerprint"];
  research?: ResearchFactBundle;
  resultPurgedAt?: string;
  selectedAt: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  updatedAt: string;
}

export interface BeginFinancialToolInvocation {
  invocationId: string;
  runId: string;
  profileId: string;
  policyVersion: string;
  toolId: string;
  toolVersion: string;
  ordinal: number;
  decision: FinancialToolDecision;
  selectionSource: FinancialToolSelectionSource;
  attempt: number;
  occurredAt: string;
  durationMs: number;
}

export interface StartFinancialToolInvocation {
  invocationId: string;
  runId: string;
  profileId: string;
  attempt: number;
  occurredAt: string;
}

export interface CompleteFinancialToolInvocation extends StartFinancialToolInvocation {
  outcome: FinancialToolOutcome;
  research: ResearchFactBundle;
}

export interface FailFinancialToolInvocation extends StartFinancialToolInvocation {
  code: string;
}

export interface FinancialToolInvocationRepository {
  get(runId: string, profileId: string): Promise<FinancialToolInvocationRecord | null>;
  beginPlanned(input: BeginFinancialToolInvocation): Promise<{ record: FinancialToolInvocationRecord; created: boolean }>;
  markStarted(input: StartFinancialToolInvocation): Promise<FinancialToolInvocationRecord>;
  complete(input: CompleteFinancialToolInvocation): Promise<{ record: FinancialToolInvocationRecord; reused: boolean }>;
  fail(input: FailFinancialToolInvocation): Promise<FinancialToolInvocationRecord>;
  getToolTrace(runId: string, profileId: string): Promise<ToolTrace | null>;
  listToolTraceAfter(runId: string, profileId: string, afterSequence: number): Promise<ToolTraceEvent[]>;
  purgeResult(runId: string, profileId: string, purgedAt: string): Promise<boolean>;
}

export class D1FinancialToolInvocationRepository implements FinancialToolInvocationRepository {
  private readonly db: D1Database;
  constructor(db: D1Database) { this.db = db; }

  async get(runId: string, profileId: string): Promise<FinancialToolInvocationRecord | null> {
    const row = await this.db.prepare(`${INVOCATION_SELECT} WHERE run_id = ? AND profile_id = ?`).bind(runId, profileId).first<Record<string, unknown>>();
    return row ? await rowToInvocation(row) : null;
  }

  async getToolTrace(runId: string, profileId: string): Promise<ToolTrace | null> {
    const owner = await this.db.prepare("SELECT id FROM agent_runs WHERE id = ? AND profile_id = ?").bind(runId, profileId).first<{ id: string }>();
    if (!owner) return null;
    const result = await this.db.prepare(`${TRACE_SELECT} WHERE run_id = ? AND profile_id = ? ORDER BY sequence ASC LIMIT 101`).bind(runId, profileId).all<Record<string, unknown>>();
    if (result.results.length > 100) throw new Error("FINANCIAL_TOOL_TRACE_LIMIT_EXCEEDED");
    return { runId, events: result.results.map(rowToTraceEvent) };
  }

  async listToolTraceAfter(runId: string, profileId: string, afterSequence: number): Promise<ToolTraceEvent[]> {
    const sequence = Number.isSafeInteger(afterSequence) && afterSequence >= 0 ? afterSequence : 0;
    const result = await this.db.prepare(`${TRACE_SELECT} WHERE run_id = ? AND profile_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT 100`).bind(runId, profileId, sequence).all<Record<string, unknown>>();
    return result.results.map(rowToTraceEvent);
  }

  async purgeResult(runId: string, profileId: string, purgedAt: string): Promise<boolean> {
    const response = await this.db.prepare("UPDATE financial_tool_invocations SET result_json = NULL, result_purged_at = ?, updated_at = ? WHERE run_id = ? AND profile_id = ? AND status = 'completed' AND result_json IS NOT NULL")
      .bind(purgedAt, purgedAt, runId, profileId).run();
    return Boolean(response.meta.changes);
  }

  async beginPlanned(input: BeginFinancialToolInvocation): Promise<{ record: FinancialToolInvocationRecord; created: boolean }> {
    assertValidSelection(input);
    let existing = await this.get(input.runId, input.profileId);
    if (existing) {
      assertSameSelection(existing, input);
      if (existing.status === "completed" || existing.status === "skipped") return { record: existing, created: false };
      if (existing.status === "planned" && existing.attempt === input.attempt) return { record: existing, created: false };
      if ((existing.status !== "failed" && existing.status !== "pending") || input.attempt <= existing.attempt) throw new Error("FINANCIAL_TOOL_INVOCATION_CONFLICT");
      if (existing.status === "pending") {
        await this.fail({
          invocationId: existing.invocationId,
          runId: existing.runId,
          profileId: existing.profileId,
          attempt: existing.attempt,
          code: "FINANCIAL_TOOL_ATTEMPT_RECOVERED",
          occurredAt: input.occurredAt,
        });
        existing = await this.get(input.runId, input.profileId);
        if (!existing) throw new Error("FINANCIAL_TOOL_INVOCATION_NOT_FOUND");
      }
      const response = await this.db.prepare("UPDATE financial_tool_invocations SET status = 'planned', attempt = ?, outcome = NULL, safe_error_code = NULL, research_fingerprint = NULL, result_json = NULL, result_purged_at = NULL, started_at = NULL, completed_at = NULL, duration_ms = NULL, updated_at = ? WHERE invocation_id = ? AND run_id = ? AND profile_id = ? AND status = ? AND attempt = ?")
        .bind(input.attempt, input.occurredAt, input.invocationId, input.runId, input.profileId, existing.status, existing.attempt).run();
      if (!response.meta.changes) throw new Error("FINANCIAL_TOOL_INVOCATION_CONFLICT");
      return { record: await this.requireMatching(input), created: false };
    }
    const status: FinancialToolInvocationStatus = input.decision === "skip" ? "skipped" : "planned";
    const traceType = input.decision === "skip" ? "skipped" : "selected";
    const responses = await this.db.batch([
      this.db.prepare("INSERT INTO financial_tool_invocations (invocation_id, run_id, profile_id, policy_version, tool_id, tool_version, ordinal, decision, selection_source, status, attempt, selected_at, started_at, completed_at, duration_ms, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ? WHERE EXISTS (SELECT 1 FROM agent_runs WHERE id = ? AND profile_id = ?) ON CONFLICT DO NOTHING")
        .bind(input.invocationId, input.runId, input.profileId, input.policyVersion, input.toolId, input.toolVersion, input.ordinal, input.decision, input.selectionSource, status, input.attempt, input.occurredAt, input.decision === "skip" ? input.occurredAt : null, input.decision === "skip" ? input.durationMs : null, input.occurredAt, input.runId, input.profileId),
      this.db.prepare("INSERT INTO financial_tool_trace_events (id, invocation_id, run_id, profile_id, type, tool_id, tool_version, selection_source, attempt, occurred_at, duration_ms, code) SELECT ?, invocation_id, run_id, profile_id, ?, tool_id, tool_version, selection_source, attempt, ?, ?, CASE WHEN decision = 'skip' THEN 'FINANCIAL_TOOL_NOT_SELECTED' ELSE NULL END FROM financial_tool_invocations WHERE invocation_id = ? AND run_id = ? AND profile_id = ? AND selected_at = ? ON CONFLICT DO NOTHING")
        .bind(crypto.randomUUID(), traceType, input.occurredAt, input.durationMs, input.invocationId, input.runId, input.profileId, input.occurredAt),
    ]);
    const record = await this.get(input.runId, input.profileId);
    if (!record) throw new Error("FINANCIAL_TOOL_INVOCATION_NOT_FOUND");
    assertSameSelection(record, input);
    return { record, created: Boolean(responses[0]?.meta.changes) };
  }

  async markStarted(input: StartFinancialToolInvocation): Promise<FinancialToolInvocationRecord> {
    const current = await this.requireMatching(input);
    if (current.status === "completed") return current;
    if (current.decision !== "invoke" || current.status === "skipped") throw new Error("FINANCIAL_TOOL_INVOCATION_CONFLICT");
    if (current.status === "pending" && current.attempt === input.attempt) return current;
    if (current.status !== "planned" || current.attempt !== input.attempt) throw new Error("FINANCIAL_TOOL_INVOCATION_CONFLICT");
    const responses = await this.db.batch([
      this.db.prepare("UPDATE financial_tool_invocations SET status = 'pending', started_at = ?, completed_at = NULL, duration_ms = NULL, safe_error_code = NULL, updated_at = ? WHERE invocation_id = ? AND run_id = ? AND profile_id = ? AND status = 'planned' AND attempt = ?")
        .bind(input.occurredAt, input.occurredAt, input.invocationId, input.runId, input.profileId, input.attempt),
      this.db.prepare("INSERT INTO financial_tool_trace_events (id, invocation_id, run_id, profile_id, type, tool_id, tool_version, selection_source, attempt, occurred_at) SELECT ?, invocation_id, run_id, profile_id, 'started', tool_id, tool_version, selection_source, attempt, ? FROM financial_tool_invocations WHERE invocation_id = ? AND run_id = ? AND profile_id = ? AND status = 'pending' AND attempt = ? ON CONFLICT DO NOTHING")
        .bind(crypto.randomUUID(), input.occurredAt, input.invocationId, input.runId, input.profileId, input.attempt),
    ]);
    if (!responses[0]?.meta.changes) throw new Error("FINANCIAL_TOOL_INVOCATION_CONFLICT");
    return this.requireMatching(input);
  }

  async complete(input: CompleteFinancialToolInvocation): Promise<{ record: FinancialToolInvocationRecord; reused: boolean }> {
    const current = await this.requireMatching(input);
    if (current.status === "completed") return { record: current, reused: true };
    if (current.status !== "pending" || current.attempt !== input.attempt) throw new Error("FINANCIAL_TOOL_INVOCATION_CONFLICT");
    const research = parseResearchFactBundle(input.research);
    if (!await verifyResearchFactBundleFingerprint(research)) throw new Error("FINANCIAL_TOOL_RESULT_INTEGRITY_FAILURE");
    const durationMs = elapsedMs(current.startedAt, input.occurredAt);
    const responses = await this.db.batch([
      this.db.prepare("UPDATE financial_tool_invocations SET status = 'completed', outcome = ?, safe_error_code = NULL, research_fingerprint = ?, result_json = ?, result_purged_at = NULL, completed_at = ?, duration_ms = ?, updated_at = ? WHERE invocation_id = ? AND run_id = ? AND profile_id = ? AND status = 'pending' AND attempt = ?")
        .bind(input.outcome, research.fingerprint, JSON.stringify(research), input.occurredAt, durationMs, input.occurredAt, input.invocationId, input.runId, input.profileId, input.attempt),
      this.db.prepare("INSERT INTO financial_tool_trace_events (id, invocation_id, run_id, profile_id, type, tool_id, tool_version, selection_source, attempt, occurred_at, duration_ms, outcome, research_fingerprint) SELECT ?, invocation_id, run_id, profile_id, 'completed', tool_id, tool_version, selection_source, attempt, ?, duration_ms, outcome, research_fingerprint FROM financial_tool_invocations WHERE invocation_id = ? AND run_id = ? AND profile_id = ? AND status = 'completed' AND attempt = ? AND research_fingerprint = ? ON CONFLICT DO NOTHING")
        .bind(crypto.randomUUID(), input.occurredAt, input.invocationId, input.runId, input.profileId, input.attempt, research.fingerprint),
    ]);
    const record = await this.requireMatching(input);
    if (!responses[0]?.meta.changes) {
      if (record.status === "completed") return { record, reused: true };
      throw new Error("FINANCIAL_TOOL_INVOCATION_CONFLICT");
    }
    return { record, reused: false };
  }

  async fail(input: FailFinancialToolInvocation): Promise<FinancialToolInvocationRecord> {
    const code = safeErrorCode(input.code);
    const current = await this.requireMatching(input);
    if (current.status === "completed") return current;
    if (current.status === "failed" && current.attempt === input.attempt && current.safeErrorCode === code) return current;
    if (current.status !== "pending" || current.attempt !== input.attempt) throw new Error("FINANCIAL_TOOL_INVOCATION_CONFLICT");
    const durationMs = elapsedMs(current.startedAt, input.occurredAt);
    const responses = await this.db.batch([
      this.db.prepare("UPDATE financial_tool_invocations SET status = 'failed', outcome = NULL, safe_error_code = ?, research_fingerprint = NULL, result_json = NULL, result_purged_at = NULL, completed_at = ?, duration_ms = ?, updated_at = ? WHERE invocation_id = ? AND run_id = ? AND profile_id = ? AND status = 'pending' AND attempt = ?")
        .bind(code, input.occurredAt, durationMs, input.occurredAt, input.invocationId, input.runId, input.profileId, input.attempt),
      this.db.prepare("INSERT INTO financial_tool_trace_events (id, invocation_id, run_id, profile_id, type, tool_id, tool_version, selection_source, attempt, occurred_at, duration_ms, code) SELECT ?, invocation_id, run_id, profile_id, 'failed', tool_id, tool_version, selection_source, attempt, ?, duration_ms, safe_error_code FROM financial_tool_invocations WHERE invocation_id = ? AND run_id = ? AND profile_id = ? AND status = 'failed' AND attempt = ? AND safe_error_code = ? ON CONFLICT DO NOTHING")
        .bind(crypto.randomUUID(), input.occurredAt, input.invocationId, input.runId, input.profileId, input.attempt, code),
    ]);
    if (!responses[0]?.meta.changes) throw new Error("FINANCIAL_TOOL_INVOCATION_CONFLICT");
    return this.requireMatching(input);
  }

  private async requireMatching(input: { invocationId: string; runId: string; profileId: string }): Promise<FinancialToolInvocationRecord> {
    const record = await this.get(input.runId, input.profileId);
    if (!record) throw new Error("FINANCIAL_TOOL_INVOCATION_NOT_FOUND");
    if (record.invocationId !== input.invocationId) throw new Error("FINANCIAL_TOOL_INVOCATION_CONFLICT");
    return record;
  }
}

export class MemoryFinancialToolInvocationRepository implements FinancialToolInvocationRepository {
  private readonly invocations = new Map<string, FinancialToolInvocationRecord>();
  private readonly traces = new Map<string, ToolTraceEvent[]>();

  async get(runId: string, profileId: string): Promise<FinancialToolInvocationRecord | null> {
    const record = this.invocations.get(runId);
    return record?.profileId === profileId ? structuredClone(record) : null;
  }

  async getToolTrace(runId: string, profileId: string): Promise<ToolTrace | null> {
    const record = this.invocations.get(runId);
    if (!record || record.profileId !== profileId) return null;
    return { runId, events: structuredClone(this.traces.get(runId) ?? []) };
  }

  async listToolTraceAfter(runId: string, profileId: string, afterSequence: number): Promise<ToolTraceEvent[]> {
    const trace = await this.getToolTrace(runId, profileId);
    if (!trace) return [];
    const sequence = Number.isSafeInteger(afterSequence) && afterSequence >= 0 ? afterSequence : 0;
    return trace.events.filter((event) => event.sequence > sequence);
  }

  async purgeResult(runId: string, profileId: string, purgedAt: string): Promise<boolean> {
    const record = this.invocations.get(runId);
    if (!record || record.profileId !== profileId || record.status !== "completed" || !record.research) return false;
    const { research: _research, ...safe } = record;
    this.invocations.set(runId, { ...safe, resultPurgedAt: purgedAt, updatedAt: purgedAt });
    return true;
  }

  async beginPlanned(input: BeginFinancialToolInvocation): Promise<{ record: FinancialToolInvocationRecord; created: boolean }> {
    assertValidSelection(input);
    let existing = this.invocations.get(input.runId);
    if (existing) {
      assertSameSelection(existing, input);
      if (existing.status === "pending" && input.attempt > existing.attempt) {
        await this.fail({
          invocationId: existing.invocationId,
          runId: existing.runId,
          profileId: existing.profileId,
          attempt: existing.attempt,
          code: "FINANCIAL_TOOL_ATTEMPT_RECOVERED",
          occurredAt: input.occurredAt,
        });
        existing = this.invocations.get(input.runId);
        if (!existing) throw new Error("FINANCIAL_TOOL_INVOCATION_NOT_FOUND");
      }
      if ((existing.status === "failed" || existing.status === "pending") && input.attempt > existing.attempt) {
        const resumed: FinancialToolInvocationRecord = {
          invocationId: existing.invocationId, runId: existing.runId, profileId: existing.profileId,
          policyVersion: existing.policyVersion, toolId: existing.toolId, toolVersion: existing.toolVersion,
          ordinal: existing.ordinal, decision: existing.decision, selectionSource: existing.selectionSource,
          status: "planned", attempt: input.attempt, selectedAt: existing.selectedAt, updatedAt: input.occurredAt,
        };
        this.invocations.set(input.runId, resumed);
        return { record: structuredClone(resumed), created: false };
      }
      if (existing.status === "failed" || (existing.status !== "completed" && existing.status !== "skipped" && existing.attempt !== input.attempt)) throw new Error("FINANCIAL_TOOL_INVOCATION_CONFLICT");
      return { record: structuredClone(existing), created: false };
    }
    const record: FinancialToolInvocationRecord = {
      invocationId: input.invocationId,
      runId: input.runId,
      profileId: input.profileId,
      policyVersion: input.policyVersion,
      toolId: input.toolId,
      toolVersion: input.toolVersion,
      ordinal: input.ordinal,
      decision: input.decision,
      selectionSource: input.selectionSource,
      status: input.decision === "skip" ? "skipped" : "planned",
      attempt: input.attempt,
      selectedAt: input.occurredAt,
      ...(input.decision === "skip" ? { completedAt: input.occurredAt, durationMs: input.durationMs } : {}),
      updatedAt: input.occurredAt,
    };
    this.invocations.set(input.runId, record);
    this.appendTrace(input.runId, input.decision === "skip"
      ? traceEvent(record, "skipped", input.occurredAt, { durationMs: input.durationMs, code: "FINANCIAL_TOOL_NOT_SELECTED" })
      : traceEvent(record, "selected", input.occurredAt, { durationMs: input.durationMs }));
    return { record: structuredClone(record), created: true };
  }

  async markStarted(input: StartFinancialToolInvocation): Promise<FinancialToolInvocationRecord> {
    const current = this.requireMatching(input);
    if (current.status === "completed") return structuredClone(current);
    if (current.status === "pending" && current.attempt === input.attempt) return structuredClone(current);
    if (current.decision !== "invoke" || current.status !== "planned" || current.attempt !== input.attempt) throw new Error("FINANCIAL_TOOL_INVOCATION_CONFLICT");
    const started = { ...current, status: "pending" as const, startedAt: input.occurredAt, updatedAt: input.occurredAt };
    this.invocations.set(input.runId, started);
    this.appendTrace(input.runId, traceEvent(started, "started", input.occurredAt, {}));
    return structuredClone(started);
  }

  async complete(input: CompleteFinancialToolInvocation): Promise<{ record: FinancialToolInvocationRecord; reused: boolean }> {
    const current = this.requireMatching(input);
    if (current.status === "completed") return { record: structuredClone(current), reused: true };
    if (current.status !== "pending" || current.attempt !== input.attempt) throw new Error("FINANCIAL_TOOL_INVOCATION_CONFLICT");
    const research = parseResearchFactBundle(input.research);
    if (!await verifyResearchFactBundleFingerprint(research)) throw new Error("FINANCIAL_TOOL_RESULT_INTEGRITY_FAILURE");
    const completed: FinancialToolInvocationRecord = {
      ...current,
      status: "completed",
      outcome: input.outcome,
      researchFingerprint: research.fingerprint,
      research: structuredClone(research),
      completedAt: input.occurredAt,
      durationMs: elapsedMs(current.startedAt, input.occurredAt),
      updatedAt: input.occurredAt,
    };
    this.invocations.set(input.runId, completed);
    this.appendTrace(input.runId, traceEvent(completed, "completed", input.occurredAt, {
      durationMs: completed.durationMs!, outcome: input.outcome, researchFingerprint: research.fingerprint,
    }));
    return { record: structuredClone(completed), reused: false };
  }

  async fail(input: FailFinancialToolInvocation): Promise<FinancialToolInvocationRecord> {
    const code = safeErrorCode(input.code);
    const current = this.requireMatching(input);
    if (current.status === "completed") return structuredClone(current);
    if (current.status === "failed" && current.attempt === input.attempt && current.safeErrorCode === code) return structuredClone(current);
    if (current.status !== "pending" || current.attempt !== input.attempt) throw new Error("FINANCIAL_TOOL_INVOCATION_CONFLICT");
    const failed: FinancialToolInvocationRecord = {
      ...current,
      status: "failed",
      safeErrorCode: code,
      completedAt: input.occurredAt,
      durationMs: elapsedMs(current.startedAt, input.occurredAt),
      updatedAt: input.occurredAt,
    };
    this.invocations.set(input.runId, failed);
    this.appendTrace(input.runId, traceEvent(failed, "failed", input.occurredAt, { durationMs: failed.durationMs!, code }));
    return structuredClone(failed);
  }

  private appendTrace(runId: string, event: Omit<ToolTraceEvent, "sequence">): void {
    const events = this.traces.get(runId) ?? [];
    events.push({ ...event, sequence: events.length + 1 } as ToolTraceEvent);
    this.traces.set(runId, events);
  }

  private requireMatching(input: { invocationId: string; runId: string; profileId: string }): FinancialToolInvocationRecord {
    const record = this.invocations.get(input.runId);
    if (!record || record.profileId !== input.profileId) throw new Error("FINANCIAL_TOOL_INVOCATION_NOT_FOUND");
    if (record.invocationId !== input.invocationId) throw new Error("FINANCIAL_TOOL_INVOCATION_CONFLICT");
    return record;
  }
}

const INVOCATION_SELECT = "SELECT invocation_id, run_id, profile_id, policy_version, tool_id, tool_version, ordinal, decision, selection_source, status, attempt, outcome, safe_error_code, research_fingerprint, result_json, result_purged_at, selected_at, started_at, completed_at, duration_ms, updated_at FROM financial_tool_invocations";
const TRACE_SELECT = "SELECT sequence, id, invocation_id, run_id, type, tool_id, tool_version, selection_source, attempt, occurred_at, duration_ms, outcome, research_fingerprint, code FROM financial_tool_trace_events";

async function rowToInvocation(row: Record<string, unknown>): Promise<FinancialToolInvocationRecord> {
  const resultJson = optionalString(row.result_json);
  const storedFingerprint = optionalString(row.research_fingerprint);
  const researchFingerprint = storedFingerprint ? requiredFingerprint(storedFingerprint) : undefined;
  const outcome = optionalString(row.outcome);
  const storedErrorCode = optionalString(row.safe_error_code);
  const policyVersion = requiredString(row.policy_version);
  const toolId = requiredString(row.tool_id);
  const toolVersion = requiredString(row.tool_version);
  const ordinal = requiredNonNegativeInteger(row.ordinal);
  const decision = requiredEnum(row.decision, ["invoke", "skip"] as const);
  const selectionSource = requiredEnum(row.selection_source, ["model", "policy_fallback"] as const);
  const status = requiredEnum(row.status, ["planned", "skipped", "pending", "completed", "failed"] as const);
  if (policyVersion !== "financial-tools.v1" || toolId !== "company_financial_update" || toolVersion !== "1" || ordinal !== 1
    || (decision === "skip" && (status !== "skipped" || selectionSource !== "model"))
    || (decision === "invoke" && status === "skipped")) throw new Error("FINANCIAL_TOOL_INVOCATION_CORRUPT");
  let research: ResearchFactBundle | undefined;
  if (resultJson) {
    try { research = parseResearchFactBundle(JSON.parse(resultJson) as unknown); }
    catch { throw new Error("FINANCIAL_TOOL_RESULT_INTEGRITY_FAILURE"); }
    if (research.fingerprint !== researchFingerprint || !await verifyResearchFactBundleFingerprint(research)) throw new Error("FINANCIAL_TOOL_RESULT_INTEGRITY_FAILURE");
  }
  return {
    invocationId: requiredString(row.invocation_id),
    runId: requiredString(row.run_id),
    profileId: requiredString(row.profile_id),
    policyVersion,
    toolId,
    toolVersion,
    ordinal,
    decision,
    selectionSource,
    status,
    attempt: requiredNonNegativeInteger(row.attempt),
    ...(outcome ? { outcome: requiredEnum(outcome, ["operational", "partial", "unavailable"] as const) } : {}),
    ...(storedErrorCode ? { safeErrorCode: safeErrorCode(storedErrorCode) } : {}),
    ...(researchFingerprint ? { researchFingerprint } : {}),
    ...(research ? { research } : {}),
    selectedAt: requiredString(row.selected_at),
    ...(optionalString(row.started_at) ? { startedAt: optionalString(row.started_at) } : {}),
    ...(optionalString(row.completed_at) ? { completedAt: optionalString(row.completed_at) } : {}),
    ...(typeof row.duration_ms === "number" ? { durationMs: requiredNonNegativeInteger(row.duration_ms) } : {}),
    ...(optionalString(row.result_purged_at) ? { resultPurgedAt: optionalString(row.result_purged_at) } : {}),
    updatedAt: requiredString(row.updated_at),
  };
}

function elapsedMs(startedAt: string | undefined, completedAt: string): number {
  const start = startedAt ? Date.parse(startedAt) : Number.NaN;
  const end = Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new Error("FINANCIAL_TOOL_INVOCATION_TIME_INVALID");
  return end - start;
}

function rowToTraceEvent(row: Record<string, unknown>): ToolTraceEvent {
  const type = requiredEnum(row.type, ["selected", "skipped", "started", "completed", "failed"] as const);
  const common = {
    id: requiredString(row.id),
    runId: requiredString(row.run_id),
    invocationId: requiredString(row.invocation_id),
    sequence: requiredPositiveInteger(row.sequence),
    tool: { id: requiredString(row.tool_id), version: requiredString(row.tool_version) },
    attempt: requiredNonNegativeInteger(row.attempt),
    occurredAt: requiredString(row.occurred_at),
    selectionSource: requiredEnum(row.selection_source, ["model", "policy_fallback"] as const),
    provenance: { source: "market-agent-worker" as const, operation: type === "selected" ? "tool.select" as const : type === "skipped" ? "tool.skip" as const : "tool.execute" as const },
  };
  const durationMs = row.duration_ms === null || row.duration_ms === undefined ? undefined : requiredNonNegativeInteger(row.duration_ms);
  const event: unknown = type === "selected"
    ? { ...common, type, durationMs }
    : type === "skipped"
      ? { ...common, type, durationMs, code: requiredString(row.code) }
      : type === "started"
        ? { ...common, type }
        : type === "completed"
          ? { ...common, type, durationMs, outcome: requiredEnum(row.outcome, ["operational", "partial", "unavailable"] as const), researchFingerprint: requiredString(row.research_fingerprint) }
          : { ...common, type, durationMs, code: safeErrorCode(requiredString(row.code)) };
  if (!isToolTraceEvent(event)) throw new Error("FINANCIAL_TOOL_TRACE_CORRUPT");
  return event;
}

function traceEvent(
  record: FinancialToolInvocationRecord,
  type: ToolTraceEvent["type"],
  occurredAt: string,
  extras: Record<string, unknown>,
): Omit<ToolTraceEvent, "sequence"> {
  const operation = type === "selected" ? "tool.select" : type === "skipped" ? "tool.skip" : "tool.execute";
  return {
    id: crypto.randomUUID(), runId: record.runId, invocationId: record.invocationId,
    tool: { id: "company_financial_update", version: "1" }, attempt: record.attempt,
    occurredAt, selectionSource: record.selectionSource, provenance: { source: "market-agent-worker", operation },
    type, ...extras,
  } as Omit<ToolTraceEvent, "sequence">;
}

function safeErrorCode(value: string): string {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(value)) throw new Error("FINANCIAL_TOOL_ERROR_CODE_INVALID");
  return value;
}

function assertSameSelection(record: FinancialToolInvocationRecord, input: BeginFinancialToolInvocation): void {
  if (record.invocationId !== input.invocationId
    || record.runId !== input.runId
    || record.profileId !== input.profileId
    || record.policyVersion !== input.policyVersion
    || record.toolId !== input.toolId
    || record.toolVersion !== input.toolVersion
    || record.ordinal !== input.ordinal
    || record.decision !== input.decision
    || record.selectionSource !== input.selectionSource) {
    throw new Error("FINANCIAL_TOOL_INVOCATION_CONFLICT");
  }
}

function assertValidSelection(input: BeginFinancialToolInvocation): void {
  if (![input.invocationId, input.runId, input.profileId].every((value) => /^[A-Za-z0-9._:-]{1,128}$/.test(value))
    || input.policyVersion !== "financial-tools.v1"
    || input.toolId !== "company_financial_update"
    || input.toolVersion !== "1"
    || input.ordinal !== 1
    || !Number.isSafeInteger(input.attempt) || input.attempt < 0 || input.attempt > 100
    || !Number.isSafeInteger(input.durationMs) || input.durationMs < 0
    || input.occurredAt.length > 40 || !Number.isFinite(Date.parse(input.occurredAt))
    || (input.decision === "skip" && input.selectionSource !== "model")) {
    throw new Error("FINANCIAL_TOOL_SELECTION_INVALID");
  }
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("FINANCIAL_TOOL_INVOCATION_CORRUPT");
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return requiredString(value);
}

function requiredNonNegativeInteger(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("FINANCIAL_TOOL_INVOCATION_CORRUPT");
  return parsed;
}

function requiredPositiveInteger(value: unknown): number {
  const parsed = requiredNonNegativeInteger(value);
  if (parsed === 0) throw new Error("FINANCIAL_TOOL_TRACE_CORRUPT");
  return parsed;
}

function requiredFingerprint(value: string): `sha256:${string}` {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error("FINANCIAL_TOOL_RESULT_INTEGRITY_FAILURE");
  return value as `sha256:${string}`;
}

function requiredEnum<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error("FINANCIAL_TOOL_INVOCATION_CORRUPT");
  return value as T;
}
