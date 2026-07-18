import { readJson, json } from "../../lib/http";
import { SignalError } from "../../lib/errors";
import { MemoryConsolidationService } from "../consolidation/service";
import { UnifiedMemoryRepository } from "../repository/memory-repository";
import { parseConsolidationRequest, parseCreateMemory, parseFeedbackEvent, parseRetrieveMemory, parseUpdateMemory } from "../schema/validation";
import { MemoryService } from "../service/memory-service";

function idFrom(pathname: string, suffix = ""): string | undefined {
  const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = pathname.match(new RegExp(`^/api/memory/items/([^/]+)${escaped}$`));
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

function reason(value: unknown, fallback: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const candidate = (value as Record<string, unknown>).reason;
  if (candidate === undefined) return fallback;
  if (typeof candidate !== "string" || !candidate.trim() || candidate.length > 1_000) throw new SignalError("INVALID_REQUEST", "reason is invalid", 400);
  return candidate.trim();
}

export async function handleMemoryApi(request: Request, pathname: string, env: Env): Promise<Response | null> {
  if (!pathname.startsWith("/api/memory/")) return null;
  const service = new MemoryService(env.DB);
  const repository = new UnifiedMemoryRepository(env.DB);

  if (request.method === "POST" && pathname === "/api/memory/events") {
    return json({ event: await repository.createEvent(parseFeedbackEvent(await readJson(request))) }, 201);
  }
  if (request.method === "POST" && pathname === "/api/memory/retrieve") {
    return json(await service.retrieve(parseRetrieveMemory(await readJson(request))));
  }
  if (request.method === "POST" && pathname === "/api/memory/items") {
    return json({ memory: await service.create(parseCreateMemory(await readJson(request))) }, 201);
  }
  if (request.method === "PATCH") {
    const id = idFrom(pathname);
    if (id) return json({ memory: await service.update(id, parseUpdateMemory(await readJson(request))) });
  }
  if (request.method === "POST") {
    const id = idFrom(pathname, "/forget");
    if (id) return json({ memory: await service.forget(id, reason(await readJson(request), "Manually forgotten")) });
  }
  if (request.method === "GET" && pathname === "/api/memory/items") {
    return json({ memories: await repository.listItems(), revisions: await repository.revisions(), candidates: await repository.listCandidates() });
  }
  if (request.method === "GET") {
    const match = pathname.match(/^\/api\/memory\/items\/([^/]+)\/revisions$/);
    if (match?.[1]) return json({ revisions: await repository.revisions(decodeURIComponent(match[1])) });
  }
  if (request.method === "POST" && pathname === "/api/memory/consolidate") {
    const input = parseConsolidationRequest(await readJson(request));
    return json({ candidates: await new MemoryConsolidationService(env).generate(input.limit) }, 201);
  }
  const candidateMatch = pathname.match(/^\/api\/memory\/consolidation\/candidates\/([^/]+)\/(accept|reject)$/);
  if (request.method === "POST" && candidateMatch?.[1] && candidateMatch[2]) {
    const consolidation = new MemoryConsolidationService(env);
    const id = decodeURIComponent(candidateMatch[1]);
    return candidateMatch[2] === "accept" ? json(await consolidation.accept(id)) : json({ candidate: await consolidation.reject(id) });
  }
  return null;
}
