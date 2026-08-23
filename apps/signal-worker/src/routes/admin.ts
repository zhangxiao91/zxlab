import { parseGenerateBriefingRequest } from "@zxlab/signal-schema";
import { readJson, json } from "../lib/http";
import { SignalError } from "../lib/errors";
import { CollectionRepository } from "../repositories/collection-repository";
import { BriefingRepository } from "../repositories/briefing-repository";
import { BriefingGenerator } from "../services/briefing-generator";
import { ProjectApiSignalLLM } from "../services/llm";
import { DailySignalPipeline, selectBalancedDailyCandidates } from "../services/daily-signal-pipeline";
import { refreshStaticBriefing } from "../services/pages-refresh";
import { DailyPipelineRunner } from "../services/daily-pipeline-runner";
import { EvaluationModule } from "../evaluation/evaluation-module";

interface AdminDependencies {
  runPipeline?: (scheduledTime: number) => Promise<{ collectionRunId: string; briefingId: string; briefingRunId: string }>;
  refreshPages?: () => Promise<"triggered" | "not-configured">;
  now?: () => number;
  briefingGenerator?: Pick<BriefingGenerator, "fixture" | "generate">;
  pipelineRunner?: Pick<DailyPipelineRunner, "run" | "getByDate" | "diagnosticsByDate">;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function handleAdmin(request: Request, pathname: string, env: Env, dependencies: AdminDependencies = {}): Promise<Response | null> {
  if (request.method === "GET" && pathname === "/api/admin/evaluation/summary") {
    const url = new URL(request.url);
    return json(await new EvaluationModule(env.DB).summary({
      from: url.searchParams.get("from") ?? undefined,
      to: url.searchParams.get("to") ?? undefined,
      limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined,
    }));
  }
  const evaluationMatch = /^\/api\/admin\/evaluation\/editions\/([^/]+)$/.exec(pathname);
  if (request.method === "POST" && evaluationMatch) {
    return json(await new EvaluationModule(env.DB).upsertEditionAssessment(decodeURIComponent(evaluationMatch[1]!), await readJson(request)));
  }
  const pipelineStatusMatch = /^\/api\/admin\/pipeline\/status\/(\d{4}-\d{2}-\d{2})$/.exec(pathname);
  if (request.method === "GET" && pipelineStatusMatch) {
    const runner = dependencies.pipelineRunner ?? new DailyPipelineRunner(env.DB, {}, env);
    const diagnostic = await runner.diagnosticsByDate(pipelineStatusMatch[1]!);
    if (!diagnostic) throw new SignalError("BRIEFING_NOT_FOUND", "Daily pipeline run was not found", 404);
    return json(diagnostic);
  }
  if (request.method === "GET" && pathname === "/api/admin/briefing-runs/latest") {
    return json({ runs: await new BriefingRepository(env.DB).latestDiagnostics() });
  }
  if (request.method === "POST" && pathname === "/api/admin/pipeline/run") {
    const startedAt = (dependencies.now ?? Date.now)();
    let scheduledTime = startedAt;
    let resumeFrom: string | undefined;
    if (request.body) {
      const input = await readJson(request);
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new SignalError("INVALID_REQUEST", "Recovery input must be an object", 400);
      const value = input as Record<string, unknown>;
      if (value.date !== undefined) {
        if (typeof value.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.date)) {
          throw new SignalError("INVALID_REQUEST", "date must use YYYY-MM-DD", 400);
        }
        scheduledTime = Date.parse(`${value.date}T07:30:00+08:00`);
        const existing = await (dependencies.pipelineRunner ?? new DailyPipelineRunner(env.DB, {}, env)).getByDate(value.date);
        if (!existing) throw new SignalError("BRIEFING_NOT_FOUND", "Daily pipeline run was not found", 404);
        resumeFrom = typeof value.resumeFrom === "string" ? value.resumeFrom : undefined;
        if (resumeFrom && resumeFrom !== existing.currentStage) {
          throw new SignalError("INVALID_REQUEST", "resumeFrom must match the current failed stage", 409);
        }
      }
    }
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`${JSON.stringify({ status: "accepted", startedAt: new Date(startedAt).toISOString() })}\n`));
        const heartbeat = setInterval(() => {
          controller.enqueue(encoder.encode(`${JSON.stringify({ status: "running" })}\n`));
        }, 15_000);
        void (async () => {
          try {
            const completed = dependencies.runPipeline || dependencies.refreshPages
              ? await (async () => {
                const runPipeline = dependencies.runPipeline ?? ((scheduledTime) => new DailySignalPipeline(env).run(scheduledTime));
                const refreshPages = dependencies.refreshPages ?? (() => refreshStaticBriefing(env));
                const result = await runPipeline(scheduledTime);
                return { status: "succeeded" as const, pagesRefresh: await refreshPages(), ...result };
              })()
              : await (dependencies.pipelineRunner ?? new DailyPipelineRunner(env.DB, {}, env)).run(scheduledTime, { force: true });
            console.log(JSON.stringify({ event: "signal.pipeline.recovery.succeeded", ...completed }));
            controller.enqueue(encoder.encode(`${JSON.stringify(completed)}\n`));
          } catch (cause) {
            const errorCode = cause instanceof SignalError ? cause.code : "PIPELINE_FAILED";
            console.error(JSON.stringify({ event: "signal.pipeline.recovery.failed", errorCode }));
            controller.enqueue(encoder.encode(`${JSON.stringify({ status: "failed", errorCode })}\n`));
          } finally {
            clearInterval(heartbeat);
            controller.close();
          }
        })();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "application/x-ndjson; charset=utf-8" } });
  }
  if (request.method !== "POST" || pathname !== "/api/admin/briefings/generate") return null;
  const input = parseGenerateBriefingRequest(await readJson(request));
  const generator = dependencies.briefingGenerator ?? new BriefingGenerator(env, new ProjectApiSignalLLM(env));
  const fixture = input.useFixture || input.candidateMode === "fixture";
  if (fixture) {
    const candidates = selectBalancedDailyCandidates(generator.fixture());
    return json(await generator.generate({ date: input.date ?? today(), candidates, dataOrigin: "fixture",
      stats: { fetched: null, unique: null, balanced: candidates.length } }), 201);
  }
  if (input.candidates?.length) {
    const candidates = selectBalancedDailyCandidates(input.candidates);
    return json(await generator.generate({ date: input.date ?? today(), candidates, dataOrigin: "real",
      stats: { fetched: null, unique: null, balanced: candidates.length } }), 201);
  }
  const mode = input.candidateMode ?? (input.collectionRunId ? "collection-run" : "time-window");
  if (mode === "collection-run" && !input.collectionRunId) {
    throw new SignalError("INVALID_REQUEST", "collectionRunId is required for collection-run mode", 400);
  }
  const repository = new CollectionRepository(env.DB);
  const filters = {
    collectionRunId: mode === "collection-run" ? input.collectionRunId : undefined,
    since: mode === "time-window" ? input.since ?? new Date(Date.now() - 86_400_000).toISOString() : undefined,
    until: mode === "time-window" ? input.until : undefined,
    category: input.category,
  };
  if (mode === "collection-run") {
    const collectionRunId = input.collectionRunId!;
    const collectionRun = await repository.getRun(collectionRunId);
    if (collectionRun.status === "running" || collectionRun.status === "failed") {
      throw new SignalError("INVALID_REQUEST", `Collection run ${collectionRunId} is ${collectionRun.status} and cannot publish a briefing`, 409);
    }
    const [candidatePool, uniqueCount] = await Promise.all([
      repository.candidatesForBriefing({ ...filters, maxCandidates: input.maxCandidates ?? 40 }),
      repository.countCandidatesForBriefing(filters),
    ]);
    const candidates = selectBalancedDailyCandidates(candidatePool);
    return json(await generator.generate({ date: input.date ?? today(), candidates, dataOrigin: "real", collectionRunId,
      sourceQualityDegraded: collectionRun.status === "partial",
      stats: { fetched: collectionRun.fetchedCount, unique: uniqueCount, balanced: candidates.length } }), 201);
  }
  const [candidatePool, uniqueCount] = await Promise.all([
    repository.candidatesForBriefing({ ...filters, maxCandidates: input.maxCandidates ?? 40 }),
    repository.countCandidatesForBriefing(filters),
  ]);
  const candidates = selectBalancedDailyCandidates(candidatePool);
  return json(await generator.generate({ date: input.date ?? today(), candidates, dataOrigin: "real",
    stats: { fetched: null, unique: uniqueCount, balanced: candidates.length } }), 201);
}
