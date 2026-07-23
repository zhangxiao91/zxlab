import { parseGenerateBriefingRequest } from "@zxlab/signal-schema";
import { readJson, json } from "../lib/http";
import { SignalError } from "../lib/errors";
import { CollectionRepository } from "../repositories/collection-repository";
import { BriefingRepository } from "../repositories/briefing-repository";
import { BriefingGenerator } from "../services/briefing-generator";
import { ProjectApiSignalLLM } from "../services/llm";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function handleAdmin(request: Request, pathname: string, env: Env): Promise<Response | null> {
  if (request.method === "GET" && pathname === "/api/admin/briefing-runs/latest") {
    return json({ runs: await new BriefingRepository(env.DB).latestDiagnostics() });
  }
  if (request.method !== "POST" || pathname !== "/api/admin/briefings/generate") return null;
  const input = parseGenerateBriefingRequest(await readJson(request));
  const generator = new BriefingGenerator(env, new ProjectApiSignalLLM(env));
  const fixture = input.useFixture || input.candidateMode === "fixture";
  if (fixture) return json(await generator.generate({ date: input.date ?? today(), candidates: generator.fixture(), dataOrigin: "fixture" }), 201);
  if (input.candidates?.length) {
    return json(await generator.generate({ date: input.date ?? today(), candidates: input.candidates, dataOrigin: "real" }), 201);
  }
  const mode = input.candidateMode ?? (input.collectionRunId ? "collection-run" : "time-window");
  if (mode === "collection-run" && !input.collectionRunId) {
    throw new SignalError("INVALID_REQUEST", "collectionRunId is required for collection-run mode", 400);
  }
  const repository = new CollectionRepository(env.DB);
  const candidates = await repository.candidatesForBriefing({
    collectionRunId: mode === "collection-run" ? input.collectionRunId : undefined,
    since: mode === "time-window" ? input.since ?? new Date(Date.now() - 86_400_000).toISOString() : undefined,
    until: mode === "time-window" ? input.until : undefined,
    category: input.category,
    maxCandidates: input.maxCandidates ?? 40,
  });
  return json(await generator.generate({ date: input.date ?? today(), candidates, dataOrigin: "real",
    collectionRunId: mode === "collection-run" ? input.collectionRunId : undefined }), 201);
}
