import { SignalError } from "../lib/errors";
import { DailySignalPipeline } from "./daily-signal-pipeline";
import { refreshStaticBriefing } from "./pages-refresh";
import type { CandidateEditorialDecision, GeneratedBriefingDraft } from "@zxlab/signal-schema";

export type DailyPipelineStage = "collecting" | "normalizing" | "filtering" | "generating" | "validating" | "publishing" | "refreshing";
export type PagesRefreshStatus = "triggered" | "not-configured";

export interface DailyPipelineCheckpoint {
  candidateIds?: string[];
  editorialDecisions?: CandidateEditorialDecision[];
  qualityDegraded?: boolean;
  synthesisCandidateIds?: string[];
  validatedDraft?: {
    draft: GeneratedBriefingDraft;
    generationMode: "model" | "deterministic-fallback";
    qualityStatus: "passed" | "degraded";
  };
}

export interface DailyPipelineExecutionInput {
  scheduledTime: number;
  collectionRunId: string;
  briefingRunId: string;
  briefingId: string;
  checkpoint: DailyPipelineCheckpoint;
  onStage(stage: DailyPipelineStage): Promise<void>;
  onCollectionReady(collectionRunId: string): Promise<void>;
  onCheckpoint(checkpoint: Partial<DailyPipelineCheckpoint>): Promise<void>;
}

export type DailyPipelineExecution = (input: DailyPipelineExecutionInput) => Promise<{
  collectionRunId: string;
  briefingId: string;
  briefingRunId: string;
}>;

export interface DailyPipelineRun {
  id: string;
  briefingDate: string;
  scheduledFor: string;
  status: "pending" | "running" | "succeeded" | "failed";
  currentStage?: DailyPipelineStage;
  attemptCount: number;
  collectionRunId?: string;
  briefingRunId?: string;
  briefingId?: string;
  pagesRefreshStatus?: PagesRefreshStatus;
  errorCode?: string;
  startedAt?: string;
  completedAt?: string;
  nextRetryAt?: string;
  checkpoint: DailyPipelineCheckpoint;
}

export interface DailyPipelineStageEvent {
  attempt: number;
  stage: DailyPipelineStage;
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  completedAt?: string;
  errorCode?: string;
}

interface RunRow {
  id: string;
  briefing_date: string;
  scheduled_for: string;
  status: DailyPipelineRun["status"];
  current_stage: DailyPipelineStage | null;
  attempt_count: number;
  collection_run_id: string | null;
  briefing_run_id: string | null;
  briefing_id: string | null;
  pages_refresh_status: PagesRefreshStatus | null;
  error_code: string | null;
  started_at: string | null;
  completed_at: string | null;
  next_retry_at: string | null;
  candidate_ids_json: string | null;
  editorial_decisions_json: string | null;
  synthesis_candidate_ids_json: string | null;
  validated_draft_json: string | null;
}

function parseJson<T>(value: string | null): T | undefined {
  if (!value) return undefined;
  try { return JSON.parse(value) as T; } catch { return undefined; }
}

function parseEditorialCheckpoint(value: string | null): Pick<DailyPipelineCheckpoint, "editorialDecisions" | "qualityDegraded"> {
  const parsed = parseJson<CandidateEditorialDecision[] | {
    decisions?: CandidateEditorialDecision[];
    qualityDegraded?: boolean;
  }>(value);
  if (Array.isArray(parsed)) return { editorialDecisions: parsed };
  return parsed ? { editorialDecisions: parsed.decisions, qualityDegraded: parsed.qualityDegraded } : {};
}

function shanghaiDate(timestamp: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp));
}

function hydrate(row: RunRow): DailyPipelineRun {
  const editorialCheckpoint = parseEditorialCheckpoint(row.editorial_decisions_json);
  return {
    id: row.id,
    briefingDate: row.briefing_date,
    scheduledFor: row.scheduled_for,
    status: row.status,
    currentStage: row.current_stage ?? undefined,
    attemptCount: row.attempt_count,
    collectionRunId: row.collection_run_id ?? undefined,
    briefingRunId: row.briefing_run_id ?? undefined,
    briefingId: row.briefing_id ?? undefined,
    pagesRefreshStatus: row.pages_refresh_status ?? undefined,
    errorCode: row.error_code ?? undefined,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    nextRetryAt: row.next_retry_at ?? undefined,
    checkpoint: {
      candidateIds: parseJson<string[]>(row.candidate_ids_json),
      editorialDecisions: editorialCheckpoint.editorialDecisions,
      qualityDegraded: editorialCheckpoint.qualityDegraded,
      synthesisCandidateIds: parseJson<string[]>(row.synthesis_candidate_ids_json),
      validatedDraft: parseJson<NonNullable<DailyPipelineCheckpoint["validatedDraft"]>>(row.validated_draft_json),
    },
  };
}

export class DailyPipelineRunRepository {
  constructor(private readonly db: D1Database) {}

  async acquire(scheduledTime: number, now: Date): Promise<DailyPipelineRun> {
    const date = shanghaiDate(scheduledTime);
    const id = `daily:${date}`;
    const timestamp = now.toISOString();
    await this.db.prepare(`INSERT OR IGNORE INTO daily_pipeline_runs
      (id, briefing_date, scheduled_for, status, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', ?, ?)`).bind(id, date, new Date(scheduledTime).toISOString(), timestamp, timestamp).run();
    return this.getById(id);
  }

  async getByDate(date: string): Promise<DailyPipelineRun | undefined> {
    const row = await this.db.prepare("SELECT * FROM daily_pipeline_runs WHERE briefing_date = ?")
      .bind(date).first<RunRow>();
    return row ? hydrate(row) : undefined;
  }

  async getById(id: string): Promise<DailyPipelineRun> {
    const row = await this.db.prepare("SELECT * FROM daily_pipeline_runs WHERE id = ?").bind(id).first<RunRow>();
    if (!row) throw new SignalError("BRIEFING_NOT_FOUND", "Daily pipeline run was not found", 404);
    return hydrate(row);
  }

  async stages(runId: string): Promise<DailyPipelineStageEvent[]> {
    const result = await this.db.prepare(`SELECT attempt, stage, status, started_at, completed_at, error_code
      FROM daily_pipeline_stage_events WHERE pipeline_run_id=? ORDER BY attempt, started_at`)
      .bind(runId).all<{ attempt: number; stage: DailyPipelineStage; status: DailyPipelineStageEvent["status"];
        started_at: string; completed_at: string | null; error_code: string | null }>();
    return result.results.map((event) => ({ attempt: event.attempt, stage: event.stage, status: event.status,
      startedAt: event.started_at, completedAt: event.completed_at ?? undefined, errorCode: event.error_code ?? undefined }));
  }

  async claimAttempt(runId: string, now: Date, force: boolean): Promise<{ run: DailyPipelineRun; leaseToken: string } | undefined> {
    const timestamp = now.toISOString();
    const leaseToken = crypto.randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
    const dueClause = force ? "1=1" : "(next_retry_at IS NULL OR next_retry_at<=?)";
    await this.db.prepare(`UPDATE daily_pipeline_runs SET status='running', attempt_count=attempt_count+1,
      current_stage=NULL, error_code=NULL, completed_at=NULL, next_retry_at=NULL, started_at=COALESCE(started_at, ?), updated_at=?,
      lease_token=?, lease_expires_at=? WHERE id=? AND (status<>'running' OR lease_expires_at IS NULL OR lease_expires_at<=?)
      AND ${dueClause}`)
      .bind(...(force
        ? [timestamp, timestamp, leaseToken, leaseExpiresAt, runId, timestamp]
        : [timestamp, timestamp, leaseToken, leaseExpiresAt, runId, timestamp, timestamp])).run();
    const run = await this.getById(runId);
    return run.status === "running" && run.attemptCount > 0
      && await this.leaseOwned(runId, leaseToken) ? { run, leaseToken } : undefined;
  }

  private async leaseOwned(runId: string, leaseToken: string): Promise<boolean> {
    const row = await this.db.prepare("SELECT 1 owned FROM daily_pipeline_runs WHERE id=? AND lease_token=?")
      .bind(runId, leaseToken).first<{ owned: number }>();
    return row?.owned === 1;
  }

  private assertLease(changes: number | undefined): void {
    if (Number(changes ?? 0) !== 1) throw new SignalError("DATABASE_WRITE_FAILED", "Daily pipeline lease was lost", 409);
  }

  async transition(run: DailyPipelineRun, stage: DailyPipelineStage, now: Date, leaseToken: string): Promise<void> {
    const timestamp = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
    const statements: D1PreparedStatement[] = [];
    if (run.currentStage) statements.push(this.db.prepare(`UPDATE daily_pipeline_stage_events SET status='succeeded', completed_at=?
      WHERE pipeline_run_id=? AND attempt=? AND stage=? AND status='running'
      AND EXISTS (SELECT 1 FROM daily_pipeline_runs WHERE id=? AND lease_token=?)`)
      .bind(timestamp, run.id, run.attemptCount, run.currentStage, run.id, leaseToken));
    const runUpdateIndex = statements.length;
    statements.push(
      this.db.prepare(`UPDATE daily_pipeline_runs SET current_stage=?, updated_at=?, lease_expires_at=? WHERE id=? AND lease_token=?`)
        .bind(stage, timestamp, leaseExpiresAt, run.id, leaseToken),
      this.db.prepare(`INSERT INTO daily_pipeline_stage_events
        (id, pipeline_run_id, attempt, stage, status, started_at)
        SELECT ?, ?, ?, ?, 'running', ? WHERE EXISTS
        (SELECT 1 FROM daily_pipeline_runs WHERE id=? AND lease_token=?)`)
        .bind(crypto.randomUUID(), run.id, run.attemptCount, stage, timestamp, run.id, leaseToken),
    );
    const results = await this.db.batch(statements);
    this.assertLease(results[runUpdateIndex]?.meta.changes);
  }

  async setCollectionRun(runId: string, collectionRunId: string, now: Date, leaseToken: string): Promise<void> {
    const result = await this.db.prepare("UPDATE daily_pipeline_runs SET collection_run_id=?, updated_at=? WHERE id=? AND lease_token=?")
      .bind(collectionRunId, now.toISOString(), runId, leaseToken).run();
    this.assertLease(result.meta.changes);
  }

  async saveCheckpoint(runId: string, checkpoint: Partial<DailyPipelineCheckpoint>, now: Date, leaseToken: string): Promise<void> {
    const result = await this.db.prepare(`UPDATE daily_pipeline_runs SET
      candidate_ids_json=COALESCE(?, candidate_ids_json),
      editorial_decisions_json=COALESCE(?, editorial_decisions_json),
      synthesis_candidate_ids_json=COALESCE(?, synthesis_candidate_ids_json),
      validated_draft_json=COALESCE(?, validated_draft_json), updated_at=?
      WHERE id=? AND lease_token=?`)
      .bind(
        checkpoint.candidateIds ? JSON.stringify(checkpoint.candidateIds) : null,
        checkpoint.editorialDecisions ? JSON.stringify({
          decisions: checkpoint.editorialDecisions,
          qualityDegraded: checkpoint.qualityDegraded,
        }) : null,
        checkpoint.synthesisCandidateIds ? JSON.stringify(checkpoint.synthesisCandidateIds) : null,
        checkpoint.validatedDraft ? JSON.stringify(checkpoint.validatedDraft) : null,
        now.toISOString(), runId, leaseToken,
      ).run();
    this.assertLease(result.meta.changes);
  }

  async setPublished(runId: string, result: { collectionRunId: string; briefingId: string; briefingRunId: string }, now: Date, leaseToken: string): Promise<void> {
    const updated = await this.db.prepare(`UPDATE daily_pipeline_runs SET collection_run_id=?, briefing_id=?, briefing_run_id=?, updated_at=?
      WHERE id=? AND lease_token=?`)
      .bind(result.collectionRunId, result.briefingId, result.briefingRunId, now.toISOString(), runId, leaseToken).run();
    this.assertLease(updated.meta.changes);
  }

  async succeed(run: DailyPipelineRun, pagesRefreshStatus: PagesRefreshStatus, now: Date, leaseToken: string): Promise<DailyPipelineRun> {
    const timestamp = now.toISOString();
    const results = await this.db.batch([
      this.db.prepare(`UPDATE daily_pipeline_stage_events SET status='succeeded', completed_at=?
        WHERE pipeline_run_id=? AND attempt=? AND stage=? AND status='running'`)
        .bind(timestamp, run.id, run.attemptCount, run.currentStage ?? "refreshing"),
      this.db.prepare(`UPDATE daily_pipeline_runs SET status='succeeded', pages_refresh_status=?, error_code=NULL,
        completed_at=?, next_retry_at=NULL, lease_token=NULL, lease_expires_at=NULL, updated_at=? WHERE id=? AND lease_token=?`)
        .bind(pagesRefreshStatus, timestamp, timestamp, run.id, leaseToken),
    ]);
    this.assertLease(results[1]?.meta.changes);
    return this.getById(run.id);
  }

  async fail(run: DailyPipelineRun, code: string, now: Date, leaseToken: string): Promise<DailyPipelineRun> {
    const timestamp = now.toISOString();
    const retryAt = new Date(now.getTime() + 10 * 60_000).toISOString();
    const results = await this.db.batch([
      this.db.prepare(`UPDATE daily_pipeline_stage_events SET status='failed', completed_at=?, error_code=?
        WHERE pipeline_run_id=? AND attempt=? AND stage=? AND status='running'`)
        .bind(timestamp, code, run.id, run.attemptCount, run.currentStage ?? "collecting"),
      this.db.prepare(`UPDATE daily_pipeline_runs SET status='failed', error_code=?, completed_at=?, next_retry_at=?,
        lease_token=NULL, lease_expires_at=NULL, updated_at=? WHERE id=? AND lease_token=?`)
        .bind(code, timestamp, retryAt, timestamp, run.id, leaseToken),
    ]);
    this.assertLease(results[1]?.meta.changes);
    return this.getById(run.id);
  }
}

function failureCode(cause: unknown, stage?: DailyPipelineStage): string {
  if (stage === "refreshing") return "PAGES_REFRESH_FAILED";
  return cause instanceof SignalError ? cause.code : "PIPELINE_FAILED";
}

export class DailyPipelineRunner {
  private readonly repository: DailyPipelineRunRepository;
  private readonly execute: DailyPipelineExecution;
  private readonly refreshPages: () => Promise<PagesRefreshStatus>;
  private readonly now: () => Date;

  constructor(db: D1Database, dependencies: {
    execute?: DailyPipelineExecution;
    refreshPages?: () => Promise<PagesRefreshStatus>;
    now?: () => Date;
  } = {}, env?: Env) {
    this.repository = new DailyPipelineRunRepository(db);
    this.execute = dependencies.execute ?? (async (input) => {
      if (!env) throw new SignalError("DATABASE_WRITE_FAILED", "Daily pipeline environment is unavailable", 500);
      return new DailySignalPipeline(env).run(input.scheduledTime, {}, {
        collectionRunId: input.collectionRunId,
        briefingRunId: input.briefingRunId,
        briefingId: input.briefingId,
        onStage: input.onStage,
        onCollectionReady: input.onCollectionReady,
        checkpoint: input.checkpoint,
        onCheckpoint: input.onCheckpoint,
      });
    });
    this.refreshPages = dependencies.refreshPages ?? (() => {
      if (!env) throw new SignalError("DATABASE_WRITE_FAILED", "Pages refresh environment is unavailable", 500);
      return refreshStaticBriefing(env);
    });
    this.now = dependencies.now ?? (() => new Date());
  }

  async run(scheduledTime: number, options: { force?: boolean } = {}): Promise<DailyPipelineRun> {
    let run = await this.repository.acquire(scheduledTime, this.now());
    if (run.status === "succeeded") return run;
    if (!options.force && run.attemptCount >= 3) return run;
    const claim = await this.repository.claimAttempt(run.id, this.now(), Boolean(options.force));
    if (!claim) return this.repository.getById(run.id);
    run = claim.run;
    const { leaseToken } = claim;
    try {
      if (!run.briefingId || !run.briefingRunId || !run.collectionRunId) {
        const result = await this.execute({
          scheduledTime,
          collectionRunId: run.collectionRunId ?? `${run.id}:collection`,
          briefingRunId: `${run.id}:briefing-run`,
          briefingId: `${run.id}:briefing`,
          checkpoint: run.checkpoint,
          onStage: async (stage) => {
            run = await this.repository.getById(run.id);
            await this.repository.transition(run, stage, this.now(), leaseToken);
            run = await this.repository.getById(run.id);
          },
          onCollectionReady: async (collectionRunId) => {
            await this.repository.setCollectionRun(run.id, collectionRunId, this.now(), leaseToken);
            run = await this.repository.getById(run.id);
          },
          onCheckpoint: async (checkpoint) => {
            await this.repository.saveCheckpoint(run.id, checkpoint, this.now(), leaseToken);
            run = await this.repository.getById(run.id);
          },
        });
        await this.repository.setPublished(run.id, result, this.now(), leaseToken);
        run = await this.repository.getById(run.id);
      }
      await this.repository.transition(run, "refreshing", this.now(), leaseToken);
      run = await this.repository.getById(run.id);
      const pagesRefreshStatus = await this.refreshPages();
      return this.repository.succeed(run, pagesRefreshStatus, this.now(), leaseToken);
    } catch (cause) {
      run = await this.repository.getById(run.id);
      return this.repository.fail(run, failureCode(cause, run.currentStage), this.now(), leaseToken);
    }
  }

  getByDate(date: string): Promise<DailyPipelineRun | undefined> {
    return this.repository.getByDate(date);
  }


  async diagnosticsByDate(date: string): Promise<{ run: DailyPipelineRun; stages: DailyPipelineStageEvent[] } | undefined> {
    const run = await this.repository.getByDate(date);
    return run ? { run, stages: await this.repository.stages(run.id) } : undefined;
  }
}
