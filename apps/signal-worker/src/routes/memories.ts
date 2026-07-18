import { parseResolveMemoryRequest } from "@zxlab/signal-schema";
import { readJson, json } from "../lib/http";
import { SignalError } from "../lib/errors";
import { MemoryRepository } from "../services/memory-repository";

export async function handleMemories(request: Request, pathname: string, env: Env): Promise<Response | null> {
  const repository = new MemoryRepository(env.DB);
  if (request.method === "GET" && pathname === "/api/memories") return json(await repository.list());
  const match = pathname.match(/^\/api\/memory-candidates\/([^/]+)\/(accept|reject)$/);
  if (!match || request.method !== "POST") return null;
  const id = decodeURIComponent(match[1] ?? "");
  const action = match[2];
  if (!id) throw new SignalError("INVALID_REQUEST", "Memory candidate id is required", 400);
  if (action === "reject") return json({ candidate: await repository.reject(id) });
  const input = parseResolveMemoryRequest(await readJson(request));
  return json(await repository.accept(id, input));
}
