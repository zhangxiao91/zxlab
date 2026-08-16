import { isMarketAgentAskCommand, isRetryableRunStatus, isTerminalRunStatus, normalizePortfolioSnapshotUpload, subjectHash, validateBrowserAskIntent, validateBrowserRunIntent, type BrowserAskIntent, type BrowserRunIntent, type MarketAgentCommand } from "@zxlab/market-agent-schema";
import { MemoryRunRepository } from "./foundation.ts";
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
import { MARKET_AGENT_RUN_LEASE_MS } from "./runtime-budget.ts";
import { D1RunArchiveRepository } from "./run-archive.ts";
import { settleRunFailure } from "./run-failure-policy.ts";
import { handleRunFeedbackRequest } from "./run-feedback-route.ts";

const repository = new MemoryRunRepository();
type RunMessage = { runId: string; generation: number; kind: "initial" | "recovery" };
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" } }); }

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/internal/runtime/health" && request.method === "GET") return await runtimeHealth(request, env);
    const path = privatePath(url.pathname);
    if (path === "/health" && request.method === "GET") return json({ ok: true, service: "market-agent", generation: "evidence-bound-gateway" });
    if (!env.DB) return json({ error: "DATABASE_UNAVAILABLE" }, 503);
    try {
      const actor = await resolveMarketAgentActor(request, env); requireMarketAgentScope(actor, request.method); const profiles = new D1ProfileRepository(env.DB); const profile = await profiles.resolve(await subjectHash(actor.ownerSubject, marketAgentProxySecret(env))); const runs = new D1RunRepository(env.DB); const archive = new D1RunArchiveRepository(env.DB); const snapshots = new D1PortfolioSnapshotRepository(env.DB);
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
          ? createRunEventStream(request, runs, run.id, profile.profileId, { initialRun: run })
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
  async scheduled(controller: ScheduledController, env: Env): Promise<void> { if (!env.DB) return; const runs = new D1RunRepository(env.DB); const profiles = new D1ProfileRepository(env.DB); const now = new Date(controller.scheduledTime); await runs.sweepExpired(now.toISOString(), Number(env.MARKET_AGENT_MAX_RECOVERY_GENERATIONS ?? 2)); const retentionDays = boundedInteger(env.MARKET_AGENT_RUN_RETENTION_DAYS, 365, 3650); const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1_000).toISOString(); await new D1RunArchiveRepository(env.DB).sweepRetentionAll({ cutoff, purgedAt: now.toISOString() }); const workflow = scheduledWorkflowAt(now); if (workflow) { const decision = await decideScheduledWorkflow(workflow, now, productionTradingCalendar); if (decision.decision === "run") { const snapshots = new D1PortfolioSnapshotRepository(env.DB); for (const profileId of await profiles.listBootstrappedProfileIds()) { const command: MarketAgentCommand = { profileId, trigger: "scheduled", workflow, marketDate: decision.marketDate, idempotencyKey: `scheduled:${workflow}:${decision.marketDate}` }; const portfolioSnapshot = await snapshots.getCurrent(profileId); await runs.createQueued(command, { command, actorScope: profileId, commandHash: await sha256(command), portfolioSnapshotId: portfolioSnapshot?.id ?? null }); } } else await runs.recordScheduleDecision({ workflow, marketDate: decision.marketDate, decision: decision.decision, calendarSource: decision.calendar.source, reason: decision.reason }); } await relayOutbox(env, runs); },
} satisfies ExportedHandler<Env, RunMessage>;

export async function processRun(runId: string, env: Env): Promise<"ack" | "retry"> {
  if (!env.DB) return "retry"; const runs = new D1RunRepository(env.DB); const claim = await runs.claim(runId, "market-agent-consumer", new Date().toISOString(), new Date(Date.now() + MARKET_AGENT_RUN_LEASE_MS).toISOString());
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
  const watchlist = await profiles.getWatchlist(command.profileId); if (!checkpoint && command.trigger === "scheduled" && !watchlist) { await runs.fail(runId, claim.lease.leaseToken, "WATCHLIST_BOOTSTRAP_REQUIRED"); return "ack"; }
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
      const reader = new MarketSnapshotAdapter({ service: env.MARKET_SNAPSHOT_SERVICE, baseUrl: env.MARKET_SNAPSHOT_URL });
      const output = await new AskService(reader, narratorFor(env), contextReaderFor(env), researchReaderFor(env)).execute({ runId, command, watchlistRevision: watchlist?.revision ?? checkpoint?.evidence.watchlistRevision ?? "ask-without-watchlist", portfolioSnapshot, previous, previousSnapshot: previousCheckpoint?.snapshot, checkpoint: checkpoint ?? undefined, onCheckpoint: (value) => checkpointRun(runs, runId, command.profileId, claim.lease.leaseToken, value), onProgress: (status) => advanceRun(runs, runId, claim.lease.leaseToken, status) });
      await runs.complete(runId, claim.lease.leaseToken, output.evidence, output.result);
      return "ack";
    } catch (cause) {
      return settleRunFailure(runs, runId, claim.lease.leaseToken, cause, "ASK_RETRYABLE");
    }
  }
  const portfolioSnapshot = !checkpoint && claim.lease.run.portfolioSnapshotId ? await snapshots.getUsableForProfile(command.profileId, claim.lease.run.portfolioSnapshotId) : null;
  const instrumentIds = checkpoint?.evidence.instrumentIds ?? [...new Set([...(command.instrumentId ? [command.instrumentId] : (watchlist?.items.map((item) => item.instrumentId) ?? [])), ...(portfolioSnapshot?.positions.map((item) => item.instrumentId) ?? [])])]; if (!instrumentIds.length) { await runs.fail(runId, claim.lease.leaseToken, "INSTRUMENT_SCOPE_EMPTY"); return "ack"; }
  try {
    const reader = new MarketSnapshotAdapter({ service: env.MARKET_SNAPSHOT_SERVICE, baseUrl: env.MARKET_SNAPSHOT_URL });
    const previous = checkpoint ? null : await runs.getPreviousCheckpoint(runId, command.profileId);
    const output = await new CloseReviewService(reader, narratorFor(env), contextReaderFor(env), researchReaderFor(env)).execute({ runId, command, instrumentIds, watchlistRevision: watchlist?.revision ?? checkpoint?.evidence.watchlistRevision ?? "instrument-only", portfolioSnapshot, previous: previous?.snapshot, checkpoint: checkpoint ?? undefined, onCheckpoint: (value) => checkpointRun(runs, runId, command.profileId, claim.lease.leaseToken, value), onProgress: (status) => advanceRun(runs, runId, claim.lease.leaseToken, status) });
    await runs.complete(runId, claim.lease.leaseToken, output.evidence, output.result); return "ack";
  } catch (cause) { return settleRunFailure(runs, runId, claim.lease.leaseToken, cause, "CLOSE_REVIEW_RETRYABLE"); }
}

export async function processQueue(batch: MessageBatch<RunMessage>, env: Env): Promise<void> { for (const message of batch.messages) { const body = message.body; if (!body || typeof body.runId !== "string") { message.ack(); continue; } const disposition = await processRun(body.runId, env); if (disposition === "ack") message.ack(); else message.retry({ delaySeconds: 30 }); } }
export async function processDeadLetters(batch: MessageBatch<RunMessage>, env: Env): Promise<void> { if (!env.DB) return; const runs = new D1RunRepository(env.DB); for (const message of batch.messages) { const body = message.body; const run = body?.runId ? await runs.get(body.runId) : null; const status = !run ? "orphaned" : isTerminalRunStatus(run.status) ? "resolved_terminal" : "deferred_active_lease"; await runs.recordDeadLetter({ messageId: message.id, runId: body?.runId ?? null, generation: body?.generation ?? 0, status, errorCode: "QUEUE_RETRIES_EXHAUSTED" }); message.ack(); } await runs.sweepExpired(new Date().toISOString(), Number(env.MARKET_AGENT_MAX_RECOVERY_GENERATIONS ?? 2)); await relayOutbox(env, runs); }
export async function relayOutbox(env: Env, runs = new D1RunRepository(env.DB)): Promise<void> { if (!env.MARKET_AGENT_RUNS) return; for (const item of await runs.pendingDispatches()) { const run = await runs.get(item.runId); if (!run || isTerminalRunStatus(run.status)) { await runs.markDispatchSent(item.id); continue; } try { await env.MARKET_AGENT_RUNS.send({ runId: item.runId, generation: item.generation, kind: item.kind }); await runs.markDispatchSent(item.id); } catch { await runs.markDispatchError(item.id, "QUEUE_SEND_FAILED"); } } }

async function retryRun(request: Request, env: Env, runs: D1RunRepository, snapshots: D1PortfolioSnapshotRepository, profileId: string, priorRunId: string): Promise<Response> {
  let body: { idempotencyKey?: unknown };
  try { body = await request.json() as { idempotencyKey?: unknown }; } catch { return json({ error: "INVALID_JSON" }, 400); }
  if (typeof body.idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{8,180}$/.test(body.idempotencyKey)) return json({ error: "INVALID_IDEMPOTENCY_KEY" }, 400);
  const prior = await runs.get(priorRunId);
  const priorCommand = await runs.getCommand(priorRunId);
  if (prior?.profileId !== profileId || !priorCommand) return json({ error: "NOT_FOUND" }, 404);
  if (!isRetryableRunStatus(prior.status)) return json({ error: "RUN_NOT_RETRYABLE", status: prior.status }, 409);
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
function contextReaderFor(env: Env): SignalMemoryAdapter { return new SignalMemoryAdapter({ service: env.SIGNAL_MEMORY_SERVICE, baseUrl: env.SIGNAL_MEMORY_URL, token: env.MARKET_AGENT_MEMORY_TOKEN }); }
function researchReaderFor(env: Env): ResearchFactAdapter { return new ResearchFactAdapter({ service: env.MARKET_SNAPSHOT_SERVICE, baseUrl: env.MARKET_SNAPSHOT_URL, token: env.MARKET_RESEARCH_TOKEN }); }
async function advanceRun(runs: D1RunRepository, runId: string, leaseToken: string, status: "evidence_sealed" | "generating" | "validating"): Promise<void> { if (!await runs.advance(runId, leaseToken, status)) throw new Error("RUN_LEASE_LOST"); }
async function checkpointRun(runs: D1RunRepository, runId: string, profileId: string, leaseToken: string, checkpoint: import("./run-checkpoint.ts").RunCheckpoint): Promise<void> { if (!await runs.checkpoint(runId, profileId, leaseToken, checkpoint)) throw new Error("RUN_LEASE_LOST"); }

export { MemoryRunRepository } from "./foundation.ts";
export { CloseReviewService } from "./close-review.ts";
