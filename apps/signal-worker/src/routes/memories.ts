import { parseResolveMemoryRequest } from "@zxlab/signal-schema";
import { readJson, json } from "../lib/http";
import { SignalError } from "../lib/errors";
import { UnifiedMemoryRepository } from "../memory/repository/memory-repository";
import { MemoryConsolidationService } from "../memory/consolidation/service";

export async function handleMemories(request: Request, pathname: string, env: Env): Promise<Response | null> {
  const repository = new UnifiedMemoryRepository(env.DB);
  if (request.method === "GET" && pathname === "/api/memories") {
    const [items, candidates] = await Promise.all([repository.listItems(), repository.listCandidates()]);
    return json({
      memories: items.map((item) => ({
        id: item.id,
        scope: item.kind === "preference" ? "preference" : "project",
        scopeKey: item.namespace,
        content: item.content,
        confidence: item.confidence,
        status: item.status === "active" ? "active" : "revoked",
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        lastConfirmedAt: item.updatedAt,
        expiresAt: item.expiresAt,
      })),
      candidates: candidates.map((item) => ({
        id: item.id,
        annotationId: item.sourceEventIds[0] ?? "unknown",
        scope: item.memory?.kind === "preference" ? "preference" : "project",
        scopeKey: item.memory?.namespace,
        content: item.memory?.content ?? item.reason,
        confidence: item.memory?.confidence ?? 0,
        reason: item.reason,
        status: item.status,
        createdAt: item.createdAt,
        resolvedAt: item.resolvedAt,
      })),
    });
  }
  const match = pathname.match(/^\/api\/memory-candidates\/([^/]+)\/(accept|reject)$/);
  if (!match || request.method !== "POST") return null;
  const id = decodeURIComponent(match[1] ?? "");
  const action = match[2];
  if (!id) throw new SignalError("INVALID_REQUEST", "Memory candidate id is required", 400);
  const consolidation = new MemoryConsolidationService(env);
  if (action === "reject") return json({ candidate: await consolidation.reject(id) });
  const input = parseResolveMemoryRequest(await readJson(request));
  const candidate = await repository.getCandidate(id);
  if (candidate.action !== "create" || !candidate.memory) throw new SignalError("INVALID_REQUEST", "Memory candidate cannot be accepted", 400);
  const namespace = input.scope === "preference" ? "global"
    : input.scope === "discussion" ? "briefing"
      : input.scope === "project" && input.scopeKey === "markets" ? "markets" : candidate.memory.namespace ?? "zxlab";
  const kind = input.scope === "preference" ? "preference" : input.scope === "belief" ? "fact" : input.scope === "project" ? "decision" : "summary";
  await env.DB.prepare("UPDATE memory_consolidation_candidates SET namespace = ?, kind = ? WHERE id = ? AND status = 'proposed'").bind(namespace, kind, id).run();
  return json(await consolidation.accept(id));
}
