import {
  COMPANY_FINANCIAL_UPDATE_TOOL,
  COMPANY_FINANCIAL_UPDATE_TOOL_NAME,
  FINANCIAL_TOOL_POLICY_VERSION,
  isFinancialToolRuntimeInput,
  type FinancialToolOutcome,
  type FinancialToolRuntimeInput,
  type FinancialToolSessionReceipt,
} from "@zxlab/market-agent-schema";
import type { ResearchFactBundle } from "@zxlab/research-fact-schema";
import type { FinancialToolPlanner } from "./financial-tool-planner.ts";
import type { FinancialToolInvocationRecord, FinancialToolInvocationRepository } from "./financial-tool-repository.ts";
import { assertResearchFactScope, ResearchFactError, type ResearchFactReader } from "./research-fact-reader.ts";

const FINANCIAL_TOOL_TIMEOUT_MS = 35_000;

export interface ToolExecutionControls {
  deadlineAt?: number;
  signal?: AbortSignal;
  assertActive?: () => Promise<void>;
}

export interface FinancialToolSession {
  session: FinancialToolSessionReceipt;
  research?: ResearchFactBundle;
}

export class FinancialToolRuntimeError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, retryable: boolean, options?: ErrorOptions) {
    super(code, options);
    this.name = "FinancialToolRuntimeError";
    this.code = code;
    this.retryable = retryable;
  }
}

export class FinancialToolRuntime {
  private readonly repository: FinancialToolInvocationRepository;
  private readonly planner: FinancialToolPlanner;
  private readonly research: ResearchFactReader;
  private readonly now: () => string;

  constructor(input: {
    repository: FinancialToolInvocationRepository;
    planner: FinancialToolPlanner;
    research: ResearchFactReader;
    now?: () => string;
  }) {
    this.repository = input.repository;
    this.planner = input.planner;
    this.research = input.research;
    this.now = input.now ?? (() => new Date().toISOString());
  }

  async execute(input: FinancialToolRuntimeInput, controls: ToolExecutionControls): Promise<FinancialToolSession> {
    if (!isFinancialToolRuntimeInput(input)) throw new FinancialToolRuntimeError("FINANCIAL_TOOL_INPUT_INVALID", false);
    try { await assertActive(controls); }
    catch (cause) { throw financialToolFailure(cause); }
    const invocationId = await financialToolInvocationId(input.runId);
    let record = await this.repository.get(input.runId, input.profileId);
    if (record?.status === "completed" || record?.status === "skipped") return sessionFromRecord(record);

    let decision: "invoke" | "skip";
    let selectionSource: "model" | "policy_fallback";
    let selectionStartedAt: string;
    let selectedAt: string;
    if (record) {
      decision = record.decision;
      selectionSource = record.selectionSource;
      selectionStartedAt = record.selectedAt;
      selectedAt = this.now();
    } else {
      selectionStartedAt = this.now();
      try {
        const planned = await this.planner.plan({
          scope: input.scope,
          selectedInstrumentId: input.selectedInstrumentId,
          ...(input.question ? { question: input.question } : {}),
        });
        decision = planned.decision;
        selectionSource = "model";
      } catch {
        decision = "invoke";
        selectionSource = "policy_fallback";
      }
      selectedAt = this.now();
    }

    const begun = await this.repository.beginPlanned({
      invocationId,
      runId: input.runId,
      profileId: input.profileId,
      policyVersion: FINANCIAL_TOOL_POLICY_VERSION,
      toolId: COMPANY_FINANCIAL_UPDATE_TOOL.id,
      toolVersion: COMPANY_FINANCIAL_UPDATE_TOOL.version,
      ordinal: 1,
      decision,
      selectionSource,
      attempt: input.attempt,
      occurredAt: selectedAt,
      durationMs: elapsedMs(selectionStartedAt, selectedAt),
    });
    record = begun.record;
    if (record.status === "completed" || record.status === "skipped") return sessionFromRecord(record);

    await assertActive(controls);
    const startedAt = selectedAt;
    record = await this.repository.markStarted({ invocationId, runId: input.runId, profileId: input.profileId, attempt: input.attempt, occurredAt: startedAt });
    if (record.status === "completed") return sessionFromRecord(record);
    try {
      const research = await withControls(() => this.research.materialize({
        purpose: "company_update",
        instrumentIds: [input.selectedInstrumentId],
        selectedInstrumentId: input.selectedInstrumentId,
        observationCutoff: input.snapshotAsOf,
      }), controls);
      await assertResearchFactScope({
        research,
        purpose: "company_update",
        instrumentIds: [input.selectedInstrumentId],
        observationCutoff: input.snapshotAsOf,
        expectedLatestSessionDate: undefined,
        allowLegacyExpectedSession: false,
      });
      if (research.planVersion !== "company-update.v1") throw new FinancialToolRuntimeError("FINANCIAL_TOOL_RESULT_SCOPE_MISMATCH", false);
      const fundamentals = research.capabilities.length === 1 && research.capabilities[0]?.id === "fundamentals" ? research.capabilities[0] : undefined;
      if (!fundamentals) throw new FinancialToolRuntimeError("FINANCIAL_TOOL_RESULT_SCOPE_MISMATCH", false);
      await assertActive(controls);
      const completedAt = this.now();
      const completed = await this.repository.complete({
        invocationId,
        runId: input.runId,
        profileId: input.profileId,
        attempt: input.attempt,
        outcome: capabilityOutcome(fundamentals.status),
        research,
        occurredAt: completedAt,
      });
      return sessionFromRecord(completed.record);
    } catch (cause) {
      const failure = financialToolFailure(cause);
      try {
        await this.repository.fail({
          invocationId,
          runId: input.runId,
          profileId: input.profileId,
          attempt: input.attempt,
          code: failure.code,
          occurredAt: this.now(),
        });
      } catch {
        // Repository conflicts and lease fencing must not replace the original safe failure classification.
      }
      throw failure;
    }
  }
}

function sessionFromRecord(record: FinancialToolInvocationRecord): FinancialToolSession {
  if (record.status === "skipped") return {
    session: {
      policyVersion: FINANCIAL_TOOL_POLICY_VERSION,
      runId: record.runId,
      status: "skipped",
      selectionSource: "model",
      invocationId: record.invocationId,
      tool: COMPANY_FINANCIAL_UPDATE_TOOL,
      attempt: record.attempt,
      completedAt: record.completedAt ?? record.selectedAt,
    },
  };
  if (
    record.status !== "completed"
    || !record.research
    || !record.researchFingerprint
    || !record.outcome
    || !record.startedAt
    || !record.completedAt
    || record.durationMs === undefined
  ) throw new FinancialToolRuntimeError("FINANCIAL_TOOL_RESULT_INTEGRITY_FAILURE", false);
  return {
    session: {
      policyVersion: FINANCIAL_TOOL_POLICY_VERSION,
      runId: record.runId,
      status: "completed",
      selectionSource: record.selectionSource,
      execution: {
        invocationId: record.invocationId,
        tool: COMPANY_FINANCIAL_UPDATE_TOOL,
        attempt: record.attempt,
        outcome: record.outcome,
        researchFingerprint: record.researchFingerprint as `sha256:${string}`,
        startedAt: record.startedAt,
        completedAt: record.completedAt,
        durationMs: record.durationMs,
      },
    },
    research: record.research,
  };
}

function capabilityOutcome(status: "operational" | "degraded" | "unavailable"): FinancialToolOutcome {
  return status === "operational" ? "operational" : status === "degraded" ? "partial" : "unavailable";
}

export function financialToolRuntimeFailure(cause: unknown): { code: string; retryable: boolean } | null {
  if (cause instanceof FinancialToolRuntimeError) return { code: cause.code, retryable: cause.retryable };
  const code = cause instanceof Error ? classifyFinancialToolCode(cause.message) : null;
  return code ? { code, retryable: code === "FINANCIAL_TOOL_TIMEOUT" || code === "FINANCIAL_TOOL_EXECUTION_FAILED" } : null;
}

function financialToolFailure(cause: unknown): FinancialToolRuntimeError {
  if (cause instanceof FinancialToolRuntimeError) return cause;
  if (cause instanceof ResearchFactError) return new FinancialToolRuntimeError(cause.code, cause.retryable, { cause });
  if (cause instanceof Error && cause.message === "FINANCIAL_TOOL_TIMEOUT") return new FinancialToolRuntimeError("FINANCIAL_TOOL_TIMEOUT", true, { cause });
  const classified = cause instanceof Error ? classifyFinancialToolCode(cause.message) : null;
  if (classified) return new FinancialToolRuntimeError(
    classified,
    classified === "FINANCIAL_TOOL_TIMEOUT" || classified === "FINANCIAL_TOOL_EXECUTION_FAILED",
    { cause },
  );
  return new FinancialToolRuntimeError("FINANCIAL_TOOL_EXECUTION_FAILED", true, { cause });
}

const NON_RETRYABLE_FINANCIAL_TOOL_CODES = new Set([
  "FINANCIAL_TOOL_INPUT_INVALID",
  "FINANCIAL_TOOL_SELECTION_INVALID",
  "FINANCIAL_TOOL_INVOCATION_CONFLICT",
  "FINANCIAL_TOOL_INVOCATION_CORRUPT",
  "FINANCIAL_TOOL_INVOCATION_NOT_FOUND",
  "FINANCIAL_TOOL_INVOCATION_TIME_INVALID",
  "FINANCIAL_TOOL_RESULT_SCOPE_MISMATCH",
  "FINANCIAL_TOOL_RESULT_INTEGRITY_FAILURE",
  "FINANCIAL_TOOL_TRACE_CORRUPT",
  "FINANCIAL_TOOL_TRACE_LIMIT_EXCEEDED",
  "FINANCIAL_TOOL_ERROR_CODE_INVALID",
  "RUN_CANCELLED",
  "RUN_LEASE_LOST",
]);

function classifyFinancialToolCode(value: string): string | null {
  if (value === "FINANCIAL_TOOL_TIMEOUT" || value === "FINANCIAL_TOOL_EXECUTION_FAILED") return value;
  return NON_RETRYABLE_FINANCIAL_TOOL_CODES.has(value) ? value : null;
}

async function withControls<T>(operation: () => Promise<T>, controls: ToolExecutionControls): Promise<T> {
  const deadlineAt = Math.min(controls.deadlineAt ?? Date.now() + FINANCIAL_TOOL_TIMEOUT_MS, Date.now() + FINANCIAL_TOOL_TIMEOUT_MS);
  if (controls.signal?.aborted || deadlineAt <= Date.now()) throw new FinancialToolRuntimeError("FINANCIAL_TOOL_TIMEOUT", true);
  const pending = operation();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("FINANCIAL_TOOL_TIMEOUT")), Math.max(1, deadlineAt - Date.now()));
  });
  const aborted = controls.signal ? new Promise<never>((_resolve, reject) => {
    controls.signal!.addEventListener("abort", () => reject(new Error("RUN_CANCELLED")), { once: true });
  }) : null;
  try { return await Promise.race(aborted ? [pending, timeout, aborted] : [pending, timeout]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

async function assertActive(controls: ToolExecutionControls): Promise<void> {
  if (controls.signal?.aborted) throw new FinancialToolRuntimeError("RUN_CANCELLED", false);
  await controls.assertActive?.();
}

async function financialToolInvocationId(runId: string): Promise<string> {
  const semantic = `${runId}:${FINANCIAL_TOOL_POLICY_VERSION}:${COMPANY_FINANCIAL_UPDATE_TOOL_NAME}:1`;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(semantic)));
  return `tool:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function elapsedMs(start: string, end: string): number {
  const duration = Date.parse(end) - Date.parse(start);
  return Number.isFinite(duration) ? Math.max(0, Math.round(duration)) : 0;
}
