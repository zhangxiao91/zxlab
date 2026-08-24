import {
  isMarketAgentAskCommand,
  isTerminalRunStatus,
  normalizePortfolioSnapshotUpload,
  subjectHash,
  validateAlertRuleDraftIntent,
  validateBrowserAskIntent,
  validateBrowserRunIntent,
  validateDossierConfirmIntent,
  validateDossierDismissIntent,
  validateDossierRebaseIntent,
  validateManualThesisProposalIntent,
  type AlertRuleDraftIntent,
  type BrowserAskIntent,
  type BrowserRunIntent,
  type DossierBaseReceipt,
  type DossierConfirmIntent,
  type DossierDismissIntent,
  type DossierRebaseIntent,
  type ManualThesisProposalIntent,
  type MarketAgentCommand,
  type SealedEvidenceBundle,
} from "@zxlab/market-agent-schema";
import { D1RunRepository } from "./d1-repository.ts";
import { CloseReviewService } from "./close-review.ts";
import { AskService, type AskPreviousRun } from "./ask-service.ts";
import { askEvidencePlan, resolveAskScope } from "./ask-plan.ts";
import { D1ProfileRepository, normalizeWatchlist } from "./profile-repository.ts";
import { D1PortfolioSnapshotRepository, type PortfolioPurgeScope } from "./portfolio-snapshot-repository.ts";
import { GatewayNarrator } from "./gateway-narrator.ts";
import { DeterministicNarrator } from "./narration.ts";
import { MarketSnapshotAdapter } from "./snapshot-reader.ts";
import { ResearchFactAdapter } from "./research-fact-reader.ts";
import { productionTradingCalendar } from "@zxlab/market-schema/calendar";
import { decideScheduledWorkflow, scheduledWorkflowAt } from "./schedule.ts";
import { requireMarketAgentScope, resolveMarketAgentActor } from "./auth.ts";
import { SignalMemoryAdapter } from "./confirmed-context.ts";
import { createRunEventStream } from "./run-stream.ts";
import { marketAgentRunLeaseMs, marketAgentRunStreamTimeoutMs } from "./runtime-budget.ts";
import { D1RunArchiveRepository } from "./run-archive.ts";
import { settleRunFailure } from "./run-failure-policy.ts";
import { handleRunFeedbackRequest } from "./run-feedback-route.ts";
import { canCreateRunRevision } from "./run-revision-policy.ts";
import { D1FinancialToolInvocationRepository } from "./financial-tool-repository.ts";
import { FinancialToolRuntime } from "./financial-tool-runtime.ts";
import { GatewayFinancialToolPlanner } from "./financial-tool-planner.ts";
import { D1ResearchDossierRepository, type DossierPurgeIntent, type ResearchDossierRepository } from "./research-dossier-repository.ts";
import { ResearchDossierRuntime, type ResearchDossierProjectorMode } from "./research-dossier-runtime.ts";
import { ResearchDossierProjector } from "./research-dossier-projector.ts";
import { GatewayThesisImpactClassifier } from "./thesis-impact-classifier.ts";
import type { ResearchFactBundle } from "@zxlab/research-fact-schema";

type RunMessage = { runId: string; generation: number; kind: "initial" | "recovery" };
const DOSSIER_REQUEST_MAX_BYTES = 16 * 1024;
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" } }); }

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/internal/runtime/health" && request.method === "GET") return await runtimeHealth(request, env);
    const path = privatePath(url.pathname);
    if (path === "/health" && request.method === "GET") return json({ ok: true, service: "market-agent", generation: "evidence-bound-gateway" });
    try {
      const actor = await resolveMarketAgentActor(request, env); requireMarketAgentScope(actor, request.method);
      if (!env.DB) return json({ error: "DATABASE_UNAVAILABLE" }, 503);
      const profiles = new D1ProfileRepository(env.DB); const profile = await profiles.resolve(await subjectHash(actor.ownerSubject, marketAgentProxySecret(env))); const runs = new D1RunRepository(env.DB); const archive = new D1RunArchiveRepository(env.DB); const snapshots = new D1PortfolioSnapshotRepository(env.DB); const financialTools = new D1FinancialToolInvocationRepository(env.DB); const dossiers = new D1ResearchDossierRepository(env.DB);
      const dossierResponse = await handleResearchDossierRoute(request, path, profile.profileId, {
        repository: dossiers,
        mode: configuredResearchDossierProjectorMode(env),
        runtime: (mode) => new ResearchDossierRuntime({ repository: dossiers, projector: researchDossierProjectorFor(env, mode), mode }),
        getCheckpoint: (runId, profileId) => runs.getCheckpoint(runId, profileId),
        getRunPayloadAvailability: async (profileId, runId) => {
          const run = await archive.get(profileId, runId);
          return Boolean(run && !run.payloadPurgedAt);
        },
      });
      if (dossierResponse) return dossierResponse;
      if (path === "/profile" && request.method === "GET") return json(profile);
      if (path === "/watchlist" && request.method === "GET") return json({ profile, watchlist: await profiles.getWatchlist(profile.profileId) });
      if (path === "/watchlist" && request.method === "POST") {
        const body = await request.json() as { revision?: unknown; items?: unknown };
        if (typeof body.revision !== "string" || !/^[a-zA-Z0-9._:-]{1,120}$/.test(body.revision)) return json({ error: "INVALID_WATCHLIST_REVISION" }, 400);
        const updated = await profiles.syncWatchlist(profile.profileId, body.revision, normalizeWatchlist(body.items));
        return json({ profile: updated, watchlist: await profiles.getWatchlist(profile.profileId) });
      }
      if (path === "/portfolio-snapshot" && request.method === "GET") return json(await snapshots.controlState(profile.profileId));
      if (path === "/portfolio-snapshot" && request.method === "POST") {
        let body: unknown; try { body = await request.json(); } catch { return json({ error: "INVALID_JSON" }, 400); }
        const normalized = normalizePortfolioSnapshotUpload(body);
        if (!normalized.snapshot) return json({ error: "INVALID_PORTFOLIO_SNAPSHOT", issues: normalized.issues }, 400);
        const snapshot = await snapshots.sync(profile.profileId, normalized.snapshot);
        return json({ ...(await snapshots.controlState(profile.profileId)), snapshot }, 201);
      }
      if (path === "/portfolio-snapshot/stop" && request.method === "POST") {
        let body: { snapshotId?: unknown }; try { body = await request.json() as { snapshotId?: unknown }; } catch { return json({ error: "INVALID_JSON" }, 400); }
        if (body.snapshotId !== undefined && (typeof body.snapshotId !== "string" || body.snapshotId.length > 120)) return json({ error: "INVALID_PORTFOLIO_SNAPSHOT_ID" }, 400);
        const stopped = await snapshots.stopUse(profile.profileId, body.snapshotId);
        if (!stopped.stopped) return json({ error: "PORTFOLIO_SNAPSHOT_NOT_CURRENT" }, 409);
        return json({ ok: true, ...stopped, ...(await snapshots.controlState(profile.profileId)) });
      }
      if (path === "/portfolio-snapshot/purge" && request.method === "POST") {
        let body: { scope?: unknown; confirmation?: unknown }; try { body = await request.json() as { scope?: unknown; confirmation?: unknown }; } catch { return json({ error: "INVALID_JSON" }, 400); }
        if ((body.scope !== "all" && body.scope !== "expired") || body.confirmation !== "purge-portfolio-history") return json({ error: "INVALID_PORTFOLIO_PURGE" }, 400);
        const purged = await snapshots.purgeHistory(profile.profileId, body.scope as PortfolioPurgeScope);
        return json({ ok: true, ...purged, ...(await snapshots.controlState(profile.profileId)) });
      }
      if (path === "/ask" && request.method === "POST") {
        let body: unknown; try { body = await request.json(); } catch { return json({ error: "INVALID_JSON" }, 400); }
        const issues = validateBrowserAskIntent(body); if (issues.length) return json({ error: "INVALID_ASK_INTENT", issues }, 400);
        const rawIntent = body as BrowserAskIntent;
        const intent: BrowserAskIntent = {
          scope: rawIntent.scope,
          idempotencyKey: rawIntent.idempotencyKey,
          ...(rawIntent.instrumentId?.trim() ? { instrumentId: rawIntent.instrumentId.trim().toUpperCase() } : {}),
          ...(rawIntent.question?.trim() ? { question: rawIntent.question.trim() } : {}),
          ...(rawIntent.priorRunId?.trim() ? { priorRunId: rawIntent.priorRunId.trim() } : {}),
        };
        const watchlist = await profiles.getWatchlist(profile.profileId);
        const portfolioSnapshot = await snapshots.getCurrent(profile.profileId);
        const prior = intent.priorRunId ? await runs.get(intent.priorRunId) : null;
        const previousEvidence = prior?.profileId === profile.profileId && terminalWithEvidence(prior)
          ? await runs.getEvidence(prior.id, profile.profileId)
          : null;
        if (intent.scope === "compare_previous_run" && (!prior || !previousEvidence || !prior.result || prior.evidenceFingerprint !== previousEvidence.fingerprint)) {
          return json({ error: "ASK_CLARIFICATION_REQUIRED", clarification: "请选择一条属于当前 profile、已完成且仍保留 Evidence 的历史运行。" }, 422);
        }
        const resolution = resolveAskScope(intent, watchlist, portfolioSnapshot, previousEvidence);
        if (resolution.clarification) return json({ error: "ASK_CLARIFICATION_REQUIRED", clarification: resolution.clarification }, 422);
        const command: MarketAgentCommand = {
          workflow: "ask",
          ...intent,
          profileId: profile.profileId,
          trigger: actor.kind === "agent" ? "bot" : "manual",
          resolvedInstrumentIds: resolution.instrumentIds,
        };
        const plan = askEvidencePlan(command.scope);
        const result = await runs.createQueued(command, {
          command,
          actorScope: profile.profileId,
          commandHash: await sha256(command),
          portfolioSnapshotId: plan.requiresPortfolioSnapshot ? portfolioSnapshot?.id ?? null : null,
        });
        await relayOutbox(env, runs);
        return json({ runId: result.run.id, status: result.run.status, created: result.created, scope: command.scope }, 202);
      }
      if (path === "/runs" && request.method === "POST") {
        let body: unknown; try { body = await request.json(); } catch { return json({ error: "INVALID_JSON" }, 400); }
        const issues = validateBrowserRunIntent(body); if (issues.length) return json({ error: "INVALID_INTENT", issues }, 400);
        const intent = body as BrowserRunIntent; const watchlist = await profiles.getWatchlist(profile.profileId);
        if (!watchlist && !intent.instrumentId) return json({ error: "WATCHLIST_BOOTSTRAP_REQUIRED" }, 409);
        const command: MarketAgentCommand = { ...intent, profileId: profile.profileId, trigger: "manual" };
        const commandHash = await sha256(command); const portfolioSnapshot = await snapshots.getCurrent(profile.profileId); const result = await runs.createQueued(command, { command, actorScope: profile.profileId, commandHash, portfolioSnapshotId: portfolioSnapshot?.id ?? null });
        await relayOutbox(env, runs);
        return json({ runId: result.run.id, status: result.run.status, created: result.created }, 202);
      }
      if (path === "/runs" && request.method === "GET") {
        const limit = boundedInteger(url.searchParams.get("limit"), 50, 100);
        const cursor = url.searchParams.get("cursor");
        if (cursor && cursor.length > 512) return json({ error: "RUN_ARCHIVE_CURSOR_INVALID" }, 400);
        return json(await archive.list(profile.profileId, { limit, cursor }));
      }
      if (path === "/quality" && request.method === "GET") return json({ window: 50, metrics: await runs.qualityMetrics(profile.profileId, 50) });
      if (path === "/today" && request.method === "GET") return json({ run: (await archive.list(profile.profileId, { limit: 1 })).runs[0] ?? null });
      if (path === "/export" && request.method === "GET") return archive.createExportResponse(profile.profileId);
      const streamMatch = path.match(/^\/runs\/([^/]+)\/stream$/);
      if (streamMatch && request.method === "GET") {
        const run = await runs.get(streamMatch[1]);
        return run?.profileId === profile.profileId
          ? createRunEventStream(request, {
              get: (runId) => runs.get(runId),
              listTraceAfter: (runId, profileId, afterSequence) => runs.listTraceAfter(runId, profileId, afterSequence),
              listToolTraceAfter: (runId, profileId, afterSequence) => financialTools.listToolTraceAfter(runId, profileId, afterSequence),
            }, run.id, profile.profileId, { initialRun: run, timeoutMs: marketAgentRunStreamTimeoutMs(configuredFinancialToolRuntimeMode(env), configuredResearchDossierProjectorMode(env)) })
          : json({ error: "NOT_FOUND" }, 404);
      }
      const evidenceMatch = path.match(/^\/runs\/([^/]+)\/evidence$/);
      if (evidenceMatch && request.method === "GET") {
        const evidence = await runs.getEvidence(evidenceMatch[1], profile.profileId);
        return evidence ? json({ runId: evidenceMatch[1], evidence }) : json({ error: "NOT_FOUND" }, 404);
      }
      const traceMatch = path.match(/^\/runs\/([^/]+)\/trace$/);
      if (traceMatch && request.method === "GET") {
        const trace = await runs.getTrace(traceMatch[1], profile.profileId);
        return trace ? json(trace) : json({ error: "NOT_FOUND" }, 404);
      }
      const toolTraceMatch = path.match(/^\/runs\/([^/]+)\/tool-trace$/);
      if (toolTraceMatch && request.method === "GET") {
        const trace = await financialTools.getToolTrace(toolTraceMatch[1], profile.profileId);
        return trace ? json(trace) : json({ error: "NOT_FOUND" }, 404);
      }
      const cancelMatch = path.match(/^\/runs\/([^/]+)\/cancel$/);
      if (cancelMatch && request.method === "POST") {
        const outcome = await runs.cancel(cancelMatch[1], profile.profileId);
        if (outcome.kind === "not_found") return json({ error: "NOT_FOUND" }, 404);
        if (outcome.kind === "conflict") return json({ error: "RUN_NOT_CANCELLABLE", status: outcome.status }, 409);
        return json({ run: outcome.run, cancelled: outcome.kind === "cancelled" });
      }
      const retry = path.match(/^\/runs\/([^/]+)\/(?:retry|rerun)$/);
      if (retry && request.method === "POST") return retryRun(request, env, runs, snapshots, profile.profileId, retry[1]);
      const match = path.match(/^\/runs\/([^/]+)$/); if (match && request.method === "GET") { const run = await archive.get(profile.profileId, match[1]); return run ? json(run) : json({ error: "NOT_FOUND" }, 404); }
      if (match && request.method === "DELETE") { const tombstone = await archive.purgeRunPayload(profile.profileId, match[1]); return tombstone ? json({ ok: true, tombstone }) : json({ error: "NOT_FOUND" }, 404); }
      const feedback = path.match(/^\/runs\/([^/]+)\/feedback$/);
      if (feedback && request.method === "POST") {
        return handleRunFeedbackRequest(request, runs, feedback[1], profile.profileId);
      }
      return json({ error: "NOT_FOUND" }, 404);
    } catch (cause) { const code = cause instanceof Error ? cause.message : "INTERNAL_ERROR"; if (code === "ACTOR_SCOPE_REQUIRED") return json({ error: code }, 403); if (code.startsWith("ACTOR_")) return json({ error: code }, 401); if (code === "INVALID_WATCHLIST" || code.startsWith("INVALID_PORTFOLIO") || code === "RUN_ARCHIVE_CURSOR_INVALID") return json({ error: code }, 400); if (code === "IDEMPOTENCY_KEY_REUSED" || code === "PORTFOLIO_SNAPSHOT_NOT_CURRENT") return json({ error: code }, 409); return json({ error: "INTERNAL_ERROR" }, 500); }
  },
  async queue(batch: MessageBatch<RunMessage>, env: Env): Promise<void> { if (batch.queue.endsWith("-dlq")) await processDeadLetters(batch, env); else await processQueue(batch, env); },
  async scheduled(controller: ScheduledController, env: Env): Promise<void> { if (!env.DB) return; const runs = new D1RunRepository(env.DB); const profiles = new D1ProfileRepository(env.DB); const now = new Date(controller.scheduledTime); await runs.sweepExpired(now.toISOString(), Number(env.MARKET_AGENT_MAX_RECOVERY_GENERATIONS ?? 2)); const retentionDays = boundedInteger(env.MARKET_AGENT_RUN_RETENTION_DAYS, 365, 3650); const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1_000).toISOString(); await new D1RunArchiveRepository(env.DB).sweepRetentionAll({ cutoff, purgedAt: now.toISOString() }); if (configuredResearchDossierProjectorMode(env) !== "disabled") await new D1ResearchDossierRepository(env.DB).sweepRetention(now.toISOString()); const workflow = scheduledWorkflowAt(now); if (workflow) { const decision = await decideScheduledWorkflow(workflow, now, productionTradingCalendar); if (decision.decision === "run") { const snapshots = new D1PortfolioSnapshotRepository(env.DB); for (const profileId of await profiles.listBootstrappedProfileIds()) { const command: MarketAgentCommand = { profileId, trigger: "scheduled", workflow, marketDate: decision.marketDate, idempotencyKey: `scheduled:${workflow}:${decision.marketDate}` }; const portfolioSnapshot = await snapshots.getCurrent(profileId); await runs.createQueued(command, { command, actorScope: profileId, commandHash: await sha256(command), portfolioSnapshotId: portfolioSnapshot?.id ?? null }); } } else await runs.recordScheduleDecision({ workflow, marketDate: decision.marketDate, decision: decision.decision, calendarSource: decision.calendar.source, reason: decision.reason }); } await relayOutbox(env, runs); },
} satisfies ExportedHandler<Env, RunMessage>;

export async function processRun(runId: string, env: Env): Promise<"ack" | "retry"> {
  if (!env.DB) return "retry"; const runs = new D1RunRepository(env.DB); const claim = await runs.claim(runId, "market-agent-consumer", new Date().toISOString(), new Date(Date.now() + marketAgentRunLeaseMs(configuredFinancialToolRuntimeMode(env), configuredResearchDossierProjectorMode(env))).toISOString());
  if (claim.kind === "terminal" || claim.kind === "missing") return "ack"; if (claim.kind === "leased") return "retry";
  const command = await runs.getCommand(runId); if (!command) { await runs.fail(runId, claim.lease.leaseToken, "COMMAND_MISSING"); return "ack"; }
  let checkpoint: Awaited<ReturnType<D1RunRepository["getCheckpoint"]>>;
  try { checkpoint = await runs.getCheckpoint(runId, command.profileId); }
  catch (cause) {
    if (cause instanceof Error && cause.message === "RUN_CHECKPOINT_INVALID") {
      await runs.fail(runId, claim.lease.leaseToken, "RUN_CHECKPOINT_INVALID");
      return "ack";
    }
    throw cause;
  }
  const profiles = new D1ProfileRepository(env.DB);
  const snapshots = new D1PortfolioSnapshotRepository(env.DB);
  const watchlist = checkpoint ? null : await profiles.getWatchlist(command.profileId); if (!checkpoint && command.trigger === "scheduled" && !watchlist) { await runs.fail(runId, claim.lease.leaseToken, "WATCHLIST_BOOTSTRAP_REQUIRED"); return "ack"; }
  if (isMarketAgentAskCommand(command)) {
    const plan = askEvidencePlan(command.scope);
    if (!validResolvedAskScope(command.resolvedInstrumentIds)) { await runs.fail(runId, claim.lease.leaseToken, "ASK_SCOPE_INVALID"); return "ack"; }
    const portfolioSnapshot = !checkpoint && plan.requiresPortfolioSnapshot && claim.lease.run.portfolioSnapshotId
      ? await snapshots.getUsableForProfile(command.profileId, claim.lease.run.portfolioSnapshotId)
      : null;
    if (!checkpoint && plan.requiresPortfolioSnapshot && !portfolioSnapshot) { await runs.fail(runId, claim.lease.leaseToken, "PORTFOLIO_SNAPSHOT_NOT_CURRENT"); return "ack"; }
    let previous: AskPreviousRun | undefined;
    const previousCheckpoint = checkpoint ? null : await runs.getPreviousCheckpoint(runId, command.profileId);
    if (!checkpoint && plan.requiresPreviousRun) {
      const prior = command.priorRunId ? await runs.get(command.priorRunId) : null;
      const evidence = prior?.profileId === command.profileId && terminalWithEvidence(prior)
        ? await runs.getEvidence(prior.id, command.profileId)
        : null;
      if (!prior || !evidence || !prior.result || prior.evidenceFingerprint !== evidence.fingerprint || !sameInstrumentScope(evidence.instrumentIds, command.resolvedInstrumentIds)) {
        await runs.fail(runId, claim.lease.leaseToken, "PREVIOUS_RUN_EVIDENCE_UNAVAILABLE");
        return "ack";
      }
      previous = { runId: prior.id, workflow: prior.workflow, createdAt: prior.createdAt, evidenceFingerprint: evidence.fingerprint, result: prior.result };
    }
    try {
      const reader = new MarketSnapshotAdapter({ service: env.MARKET_SNAPSHOT_SERVICE });
      const financialToolRuntimeMode = configuredFinancialToolRuntimeMode(env);
      const researchDossierProjectorMode = configuredResearchDossierProjectorMode(env);
      const output = await new AskService(reader, narratorFor(env), contextReaderFor(env), researchReaderFor(env), {
        companyUpdateEnabled: companyUpdateResearchEnabled(env),
        financialToolRuntimeMode,
        ...(financialToolRuntimeMode === "disabled" ? {} : { financialToolRuntime: financialToolRuntimeFor(env) }),
        researchDossierProjectorMode,
        ...(researchDossierProjectorMode === "disabled" ? {} : { researchDossierRuntime: researchDossierRuntimeFor(env, researchDossierProjectorMode) }),
      }).execute({ runId, command, attempt: claim.lease.attempt, watchlistRevision: watchlist?.revision ?? checkpoint?.evidence.watchlistRevision ?? "ask-without-watchlist", portfolioSnapshot, previous, previousSnapshot: previousCheckpoint?.snapshot, checkpoint: checkpoint ?? undefined, assertActive: () => assertRunActive(runs, runId, command.profileId, claim.lease.attempt), onCheckpoint: (value) => checkpointRun(runs, runId, command.profileId, claim.lease.leaseToken, value), onProgress: (status) => advanceRun(runs, runId, claim.lease.leaseToken, status) });
      await runs.complete(runId, claim.lease.leaseToken, output.evidence, output.result);
      return "ack";
    } catch (cause) {
      return settleRunFailure(runs, runId, claim.lease.leaseToken, cause, "ASK_RETRYABLE");
    }
  }
  const portfolioSnapshot = !checkpoint && claim.lease.run.portfolioSnapshotId ? await snapshots.getUsableForProfile(command.profileId, claim.lease.run.portfolioSnapshotId) : null;
  const instrumentIds = checkpoint?.evidence.instrumentIds ?? [...new Set([...(command.instrumentId ? [command.instrumentId] : (watchlist?.items.map((item) => item.instrumentId) ?? [])), ...(portfolioSnapshot?.positions.map((item) => item.instrumentId) ?? [])])]; if (!instrumentIds.length) { await runs.fail(runId, claim.lease.leaseToken, "INSTRUMENT_SCOPE_EMPTY"); return "ack"; }
  try {
    const reader = new MarketSnapshotAdapter({ service: env.MARKET_SNAPSHOT_SERVICE });
    const previous = checkpoint ? null : await runs.getPreviousCheckpoint(runId, command.profileId);
    const output = await new CloseReviewService(reader, narratorFor(env), contextReaderFor(env), researchReaderFor(env)).execute({ runId, command, instrumentIds, watchlistRevision: watchlist?.revision ?? checkpoint?.evidence.watchlistRevision ?? "instrument-only", portfolioSnapshot, previous: previous?.snapshot, checkpoint: checkpoint ?? undefined, onCheckpoint: (value) => checkpointRun(runs, runId, command.profileId, claim.lease.leaseToken, value), onProgress: (status) => advanceRun(runs, runId, claim.lease.leaseToken, status) });
    await runs.complete(runId, claim.lease.leaseToken, output.evidence, output.result); return "ack";
  } catch (cause) { return settleRunFailure(runs, runId, claim.lease.leaseToken, cause, "CLOSE_REVIEW_RETRYABLE"); }
}

export async function processQueue(batch: MessageBatch<RunMessage>, env: Env): Promise<void> { for (const message of batch.messages) { const body = message.body; if (!body || typeof body.runId !== "string") { message.ack(); continue; } const disposition = await processRun(body.runId, env); if (disposition === "ack") message.ack(); else message.retry({ delaySeconds: 30 }); } }
export async function processDeadLetters(batch: MessageBatch<RunMessage>, env: Env): Promise<void> { if (!env.DB) return; const runs = new D1RunRepository(env.DB); for (const message of batch.messages) { const body = message.body; const run = body?.runId ? await runs.get(body.runId) : null; const status = !run ? "orphaned" : isTerminalRunStatus(run.status) ? "resolved_terminal" : "deferred_active_lease"; await runs.recordDeadLetter({ messageId: message.id, runId: body?.runId ?? null, generation: body?.generation ?? 0, status, errorCode: "QUEUE_RETRIES_EXHAUSTED" }); message.ack(); } await runs.sweepExpired(new Date().toISOString(), Number(env.MARKET_AGENT_MAX_RECOVERY_GENERATIONS ?? 2)); await relayOutbox(env, runs); }
export async function relayOutbox(env: Env, runs = new D1RunRepository(env.DB)): Promise<void> { if (!env.MARKET_AGENT_RUNS) return; for (const item of await runs.pendingDispatches()) { const run = await runs.get(item.runId); if (!run || isTerminalRunStatus(run.status)) { await runs.markDispatchSent(item.id); continue; } try { await env.MARKET_AGENT_RUNS.send({ runId: item.runId, generation: item.generation, kind: item.kind }); await runs.markDispatchSent(item.id); } catch { await runs.markDispatchError(item.id, "QUEUE_SEND_FAILED"); } } }

interface ResearchDossierRouteDependencies {
  repository: ResearchDossierRepository;
  mode: ResearchDossierProjectorMode;
  runtime: (mode: Exclude<ResearchDossierProjectorMode, "disabled">) => Pick<ResearchDossierRuntime, "rebase">;
  getCheckpoint: (runId: string, profileId: string) => Promise<{
    dossierBase?: DossierBaseReceipt;
    dossierProjectionUnavailable?: import("./run-checkpoint.ts").DossierProjectionUnavailableReceipt;
    evidence: SealedEvidenceBundle;
    research?: ResearchFactBundle;
  } | null>;
  getRunPayloadAvailability: (profileId: string, runId: string) => Promise<boolean>;
  now?: () => string;
}

export async function handleResearchDossierRoute(request: Request, path: string, profileId: string, dependencies: ResearchDossierRouteDependencies): Promise<Response | null> {
  if (!isResearchDossierRoute(path)) return null;
  if (dependencies.mode === "disabled") {
    return request.method === "GET"
      ? json({ error: "NOT_FOUND" }, 404)
      : json({ error: "DOSSIER_PROJECTOR_DISABLED" }, 409);
  }
  try {
    const now = dependencies.now?.() ?? new Date().toISOString();
    const dossierMatch = path.match(/^\/dossiers\/([^/]+)$/);
    if (dossierMatch && request.method === "DELETE") {
      const instrumentId = dossierInstrumentId(dossierMatch[1]);
      const body = await readDossierJson(request);
      const intent = dossierPurgeIntent(body);
      if (!intent) return json({ error: "DOSSIER_PURGE_INVALID" }, 400);
      return json(await dependencies.repository.purgeDossier(profileId, instrumentId, intent, now));
    }
    if (dossierMatch && request.method === "GET") {
      const instrumentId = dossierInstrumentId(dossierMatch[1]);
      const state = await dependencies.repository.getDossier(profileId, instrumentId);
      if (!state) return json({ dossier: null, revision: null, sourceRun: null });
      const sourceProposal = await dependencies.repository.getProposal(state.revision.sourceProposalId, profileId);
      if (!sourceProposal) throw new Error("DOSSIER_INTEGRITY_FAILURE");
      const sourceRun = sourceProposal.kind === "projection"
        ? { runId: sourceProposal.sourceRunId, available: await dependencies.getRunPayloadAvailability(profileId, sourceProposal.sourceRunId) }
        : null;
      return json({ ...state, sourceRun });
    }
    const projectionMatch = path.match(/^\/runs\/([^/]+)\/dossier-projection$/);
    if (projectionMatch && request.method === "GET") {
      const runId = dossierResourceId(projectionMatch[1]);
      const proposal = await dependencies.repository.getProjectionByRun(runId, profileId);
      if (proposal?.kind === "projection" && proposal.payload) return json({ result: { status: "projected", projection: proposal.payload }, proposal });
      const checkpoint = await dependencies.getCheckpoint(runId, profileId);
      const hasFinancialFacts = checkpoint?.research?.purpose === "company_update"
        && checkpoint.research.facts.some((fact) => fact.kind === "financial_metric");
      if (checkpoint?.dossierProjectionUnavailable && hasFinancialFacts) {
        return json({ error: "DOSSIER_PROJECTION_UNAVAILABLE", retryable: true }, 503);
      }
      if (!checkpoint?.dossierBase || !hasFinancialFacts) return json({ error: "NOT_FOUND" }, 404);
      return json({ error: "DOSSIER_PROJECTION_UNAVAILABLE", retryable: true }, 503);
    }
    const rebaseMatch = path.match(/^\/runs\/([^/]+)\/dossier-projection\/rebase$/);
    if (rebaseMatch && request.method === "POST") {
      const runId = dossierResourceId(rebaseMatch[1]);
      const body = await readDossierJson(request);
      const issues = validateDossierRebaseIntent(body);
      if (issues.length) return json({ error: "DOSSIER_REBASE_INVALID", issues }, 400);
      const source = await dependencies.repository.getProjectionByRun(runId, profileId);
      if (!source || source.kind !== "projection" || !source.payload) return json({ error: "NOT_FOUND" }, 404);
      const checkpoint = await dependencies.getCheckpoint(runId, profileId);
      if (!checkpoint?.dossierBase || !checkpoint.research) return json({ error: "NOT_FOUND" }, 404);
      if (source.payload.sourceEvidenceFingerprint !== checkpoint.evidence.fingerprint
        || source.payload.researchFingerprint !== checkpoint.research.fingerprint
        || checkpoint.dossierBase.instrumentId !== source.instrumentId) throw new Error("DOSSIER_INTEGRITY_FAILURE");
      const session = await dependencies.runtime(dependencies.mode).rebase({
        runId,
        profileId,
        instrumentId: source.instrumentId,
        evidence: checkpoint.evidence,
        research: checkpoint.research,
        idempotencyKey: (body as DossierRebaseIntent).idempotencyKey,
      });
      if (!session) return json({ error: "DOSSIER_REBASE_NOT_APPLICABLE" }, 409);
      return json({ result: session.result, proposal: session.proposal });
    }
    const thesisMatch = path.match(/^\/dossiers\/([^/]+)\/thesis-proposals$/);
    if (thesisMatch && request.method === "POST") {
      const instrumentId = dossierInstrumentId(thesisMatch[1]);
      const body = await readDossierJson(request);
      const issues = validateManualThesisProposalIntent(body);
      if (issues.length) return json({ error: "DOSSIER_THESIS_INTENT_INVALID", issues }, 400);
      const created = await dependencies.repository.createManualThesisProposal(profileId, instrumentId, body as ManualThesisProposalIntent, now, proposalExpiry(now));
      return json({ proposal: created.proposal, created: created.created }, created.created ? 201 : 200);
    }
    const confirmMatch = path.match(/^\/dossier-proposals\/([^/]+)\/confirm$/);
    if (confirmMatch && request.method === "POST") {
      const proposalId = dossierResourceId(confirmMatch[1]);
      const body = await readDossierJson(request);
      const issues = validateDossierConfirmIntent(body);
      if (issues.length) return json({ error: "DOSSIER_CONFIRM_INVALID", issues }, 400);
      return json(await dependencies.repository.confirm(proposalId, profileId, body as DossierConfirmIntent, now));
    }
    const dismissMatch = path.match(/^\/dossier-proposals\/([^/]+)\/dismiss$/);
    if (dismissMatch && request.method === "POST") {
      const proposalId = dossierResourceId(dismissMatch[1]);
      const body = await readDossierJson(request);
      const issues = validateDossierDismissIntent(body);
      if (issues.length) return json({ error: "DOSSIER_DISMISS_INVALID", issues }, 400);
      return json(await dependencies.repository.dismiss(proposalId, profileId, body as DossierDismissIntent, now));
    }
    const alertMatch = path.match(/^\/dossier-proposals\/([^/]+)\/alert-rule-drafts$/);
    if (alertMatch && request.method === "POST") {
      const proposalId = dossierResourceId(alertMatch[1]);
      const body = await readDossierJson(request);
      const issues = validateAlertRuleDraftIntent(body);
      if (issues.length) return json({ error: "ALERT_DRAFT_INTENT_INVALID", issues }, 400);
      const created = await dependencies.repository.createAlertRuleDraft(proposalId, profileId, body as AlertRuleDraftIntent, now);
      return json(created, created.reused ? 200 : 201);
    }
    if (path === "/alert-rule-drafts" && request.method === "GET") return json({ drafts: await dependencies.repository.listAlertRuleDrafts(profileId) });
    return json({ error: "NOT_FOUND" }, 404);
  } catch (cause) {
    if (cause instanceof DossierRouteBodyTooLarge) return json({ error: "DOSSIER_REQUEST_TOO_LARGE" }, 413);
    if (cause instanceof DossierRouteJsonError) return json({ error: "INVALID_JSON" }, 400);
    return dossierRouteError(cause);
  }
}

class DossierRouteJsonError extends Error {}
class DossierRouteBodyTooLarge extends Error {}

async function readDossierJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > DOSSIER_REQUEST_MAX_BYTES) throw new DossierRouteBodyTooLarge();
  if (!request.body) throw new DossierRouteJsonError();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > DOSSIER_REQUEST_MAX_BYTES) {
      await reader.cancel();
      throw new DossierRouteBodyTooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
  catch { throw new DossierRouteJsonError(); }
}

function isResearchDossierRoute(path: string): boolean {
  return path === "/alert-rule-drafts"
    || /^\/dossiers\/[^/]+(?:\/thesis-proposals)?$/.test(path)
    || /^\/runs\/[^/]+\/dossier-projection(?:\/rebase)?$/.test(path)
    || /^\/dossier-proposals\/[^/]+\/(?:confirm|dismiss|alert-rule-drafts)$/.test(path);
}

function dossierInstrumentId(encoded: string): string {
  const value = decodedDossierSegment(encoded);
  if (!/^(SSE|SZSE):\d{6}$/.test(value)) throw new Error("DOSSIER_ROUTE_IDENTIFIER_INVALID");
  return value;
}

function dossierResourceId(encoded: string): string {
  const value = decodedDossierSegment(encoded);
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(value)) throw new Error("DOSSIER_ROUTE_IDENTIFIER_INVALID");
  return value;
}

function decodedDossierSegment(value: string): string {
  try { return decodeURIComponent(value); }
  catch { throw new Error("DOSSIER_ROUTE_IDENTIFIER_INVALID"); }
}

function proposalExpiry(createdAt: string): string {
  return new Date(Date.parse(createdAt) + 30 * 24 * 60 * 60 * 1_000).toISOString();
}

function dossierPurgeIntent(value: unknown): DossierPurgeIntent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return keys.length === 2
    && keys[0] === "confirmation"
    && keys[1] === "idempotencyKey"
    && record.confirmation === "DELETE_RESEARCH_DOSSIER"
    && typeof record.idempotencyKey === "string"
    && /^[A-Za-z0-9._:-]{8,180}$/.test(record.idempotencyKey)
    ? { confirmation: "DELETE_RESEARCH_DOSSIER", idempotencyKey: record.idempotencyKey }
    : null;
}

function dossierRouteError(cause: unknown): Response {
  const code = cause instanceof Error ? cause.message : "INTERNAL_ERROR";
  if (code === "DOSSIER_PROPOSAL_EXPIRED") return json({ error: code }, 410);
  if (code === "DOSSIER_NOT_FOUND" || code === "DOSSIER_PROPOSAL_NOT_FOUND" || code === "DOSSIER_THESIS_NOT_FOUND") return json({ error: "NOT_FOUND" }, 404);
  if (code === "DOSSIER_ROUTE_IDENTIFIER_INVALID"
    || code.endsWith("_INVALID")
    || code === "ALERT_DRAFT_DELTA_NOT_FOUND"
    || code === "ALERT_DRAFT_COMPARISON_UNAVAILABLE") return json({ error: code }, 400);
  if (code === "DOSSIER_REVISION_CONFLICT"
    || code === "DOSSIER_IDEMPOTENCY_CONFLICT"
    || code === "DOSSIER_PROPOSAL_NOT_PENDING"
    || code === "DOSSIER_PROJECTION_CONFLICT"
    || code === "ALERT_DRAFT_RELIABLE_FACT_REQUIRED") return json({ error: code }, 409);
  if (code.includes("INTEGRITY_FAILURE")) return json({ error: "DOSSIER_INTEGRITY_FAILURE" }, 502);
  return json({ error: "INTERNAL_ERROR" }, 500);
}

async function retryRun(request: Request, env: Env, runs: D1RunRepository, snapshots: D1PortfolioSnapshotRepository, profileId: string, priorRunId: string): Promise<Response> {
  let body: { idempotencyKey?: unknown };
  try { body = await request.json() as { idempotencyKey?: unknown }; } catch { return json({ error: "INVALID_JSON" }, 400); }
  if (typeof body.idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{8,180}$/.test(body.idempotencyKey)) return json({ error: "INVALID_IDEMPOTENCY_KEY" }, 400);
  const prior = await runs.get(priorRunId);
  const priorCommand = await runs.getCommand(priorRunId);
  if (prior?.profileId !== profileId || !priorCommand) return json({ error: "NOT_FOUND" }, 404);
  const priorEvidence = prior.status === "success" || prior.status === "partial"
    ? await runs.getEvidence(priorRunId, profileId)
    : null;
  if (!canCreateRunRevision(prior.status, priorEvidence)) return json({ error: "RUN_NOT_RETRYABLE", status: prior.status }, 409);
  const command = { ...priorCommand, trigger: "manual" as const, idempotencyKey: body.idempotencyKey };
  const portfolioSnapshot = await snapshots.getCurrent(profileId);
  const created = await runs.createQueued(command, { command, actorScope: profileId, commandHash: await sha256({ command, revisionOfRunId: prior.id }), revisionOfRunId: prior.id, portfolioSnapshotId: isMarketAgentAskCommand(command) && !askEvidencePlan(command.scope).requiresPortfolioSnapshot ? null : portfolioSnapshot?.id ?? null });
  await relayOutbox(env, runs);
  return json({ runId: created.run.id, status: created.run.status, revisionOfRunId: prior.id, created: created.created }, 202);
}

function marketAgentProxySecret(env: Env): string { const secret = env.MARKET_AGENT_PROXY_TOKEN?.trim(); if (!secret) throw new Error("ACTOR_ENVELOPE_MISSING"); return secret; }
function privatePath(pathname: string): string { return pathname.replace(/^\/api\/v1\/private\/market-agent/, "") || "/"; }
async function runtimeHealth(request: Request, env: Env): Promise<Response> {
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!env.ZX_RUNTIME_SERVICE_TOKEN || supplied !== env.ZX_RUNTIME_SERVICE_TOKEN) return json({ error: "UNAUTHORIZED" }, 401);
  const generatedAt = new Date().toISOString();
  if (!env.DB) return json({ schemaVersion: "1", serviceId: "market-agent", status: "offline", version: "market-agent-worker", generatedAt, checks: [{ id: "d1", status: "offline", errorCode: "D1_UNAVAILABLE" }] }, 503);
  try { const counts = await new D1RunRepository(env.DB).runtimeHealth(); const status = counts.retryWait > 0 || counts.pendingDispatches > 0 ? "degraded" : "operational"; return json({ schemaVersion: "1", serviceId: "market-agent", status, version: "market-agent-worker", generatedAt, checks: [{ id: "d1", status: "operational", lastSuccessAt: generatedAt }, { id: "dispatch", status: counts.pendingDispatches > 0 ? "degraded" : "operational" }] }); }
  catch { return json({ schemaVersion: "1", serviceId: "market-agent", status: "offline", version: "market-agent-worker", generatedAt, checks: [{ id: "d1", status: "offline", errorCode: "D1_QUERY_FAILED" }] }, 503); }
}
async function sha256(value: unknown): Promise<`sha256:${string}`> { const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))); return `sha256:${[...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`; }
function terminalWithEvidence(run: { status: string; evidenceFingerprint: string | null }): boolean { return (run.status === "success" || run.status === "partial") && Boolean(run.evidenceFingerprint); }
function validResolvedAskScope(ids: unknown): ids is string[] { return Array.isArray(ids) && ids.length > 0 && ids.length <= 200 && ids.every((id) => typeof id === "string" && /^(SSE|SZSE):\d{6}$/.test(id)) && new Set(ids).size === ids.length; }
function sameInstrumentScope(left: string[], right: string[]): boolean { return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]); }
function boundedInteger(value: string | null | undefined, fallback: number, maximum: number): number { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback; }
function narratorFor(env: Env): GatewayNarrator | DeterministicNarrator { return env.MARKET_AGENT_GENERATION_ENABLED === "true" && env.MARKET_AGENT_GATEWAY_URL && env.MARKET_AGENT_GATEWAY_TOKEN ? new GatewayNarrator({ apiUrl: env.MARKET_AGENT_GATEWAY_URL, token: env.MARKET_AGENT_GATEWAY_TOKEN }) : new DeterministicNarrator(); }
function contextReaderFor(env: Env): SignalMemoryAdapter { return new SignalMemoryAdapter({ service: env.SIGNAL_MEMORY_SERVICE, token: env.MARKET_AGENT_MEMORY_TOKEN }); }
function researchReaderFor(env: Env): ResearchFactAdapter { return new ResearchFactAdapter({ service: env.MARKET_SNAPSHOT_SERVICE, token: env.MARKET_RESEARCH_TOKEN }); }
function companyUpdateResearchEnabled(env: Env): boolean { return env.COMPANY_UPDATE_RESEARCH_ENABLED === "true"; }
function configuredFinancialToolRuntimeMode(env: Env): "disabled" | "shadow" | "enabled" {
  return env.FINANCIAL_TOOL_RUNTIME_MODE === "shadow" || env.FINANCIAL_TOOL_RUNTIME_MODE === "enabled"
    ? env.FINANCIAL_TOOL_RUNTIME_MODE
    : "disabled";
}
export function configuredResearchDossierProjectorMode(env: Env): "disabled" | "fact_only" | "enabled" {
  return env.RESEARCH_DOSSIER_PROJECTOR_MODE === "fact_only" || env.RESEARCH_DOSSIER_PROJECTOR_MODE === "enabled"
    ? env.RESEARCH_DOSSIER_PROJECTOR_MODE
    : "disabled";
}
function financialToolRuntimeFor(env: Env): FinancialToolRuntime {
  return new FinancialToolRuntime({
    repository: new D1FinancialToolInvocationRepository(env.DB),
    planner: new GatewayFinancialToolPlanner({ apiUrl: env.MARKET_AGENT_GATEWAY_URL ?? "", token: env.MARKET_AGENT_GATEWAY_TOKEN ?? "", timeoutMs: 12_000 }),
    research: new ResearchFactAdapter({ service: env.MARKET_SNAPSHOT_SERVICE, token: env.MARKET_RESEARCH_TOKEN, timeoutMs: 35_000 }),
  });
}
function researchDossierRuntimeFor(env: Env, mode: Exclude<ResearchDossierProjectorMode, "disabled">): ResearchDossierRuntime {
  return new ResearchDossierRuntime({
    repository: new D1ResearchDossierRepository(env.DB),
    projector: researchDossierProjectorFor(env, mode),
    mode,
  });
}
function researchDossierProjectorFor(env: Env, mode: Exclude<ResearchDossierProjectorMode, "disabled">): ResearchDossierProjector {
  return new ResearchDossierProjector(mode === "enabled"
    ? new GatewayThesisImpactClassifier({ apiUrl: env.MARKET_AGENT_GATEWAY_URL ?? "", token: env.MARKET_AGENT_GATEWAY_TOKEN ?? "", timeoutMs: 12_000 })
    : undefined);
}
async function assertRunActive(runs: D1RunRepository, runId: string, profileId: string, attempt: number): Promise<void> {
  const run = await runs.get(runId);
  if (run?.profileId === profileId && run.status === "cancelled") throw new Error("RUN_CANCELLED");
  if (run?.profileId !== profileId || run.status !== "collecting" || run.attempt !== attempt) throw new Error("RUN_LEASE_LOST");
}
async function advanceRun(runs: D1RunRepository, runId: string, leaseToken: string, status: "evidence_sealed" | "generating" | "validating"): Promise<void> { if (!await runs.advance(runId, leaseToken, status)) throw new Error("RUN_LEASE_LOST"); }
async function checkpointRun(runs: D1RunRepository, runId: string, profileId: string, leaseToken: string, checkpoint: import("./run-checkpoint.ts").RunCheckpoint): Promise<void> { if (!await runs.checkpoint(runId, profileId, leaseToken, checkpoint)) throw new Error("RUN_LEASE_LOST"); }

export { MemoryRunRepository } from "./foundation.ts";
export { CloseReviewService } from "./close-review.ts";
