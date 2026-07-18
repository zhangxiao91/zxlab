import type { CandidateSignal, SignalCategory, SignalSourceType } from "@zxlab/signal-schema";
import { parseStartCollectionRequest } from "@zxlab/signal-schema";
import { readJson, json } from "../lib/http";
import { CollectionRepository } from "../repositories/collection-repository";
import { CollectionService } from "../services/collection-service";

const sourceTypes = new Set<SignalSourceType>(["rss", "github-release", "hacker-news", "arxiv", "manual"]);
const categories = new Set<SignalCategory>(["ai-engineering", "zxlab", "markets", "uncategorized"]);
const statuses = new Set<CandidateSignal["status"]>(["new", "duplicate", "eligible", "filtered", "selected", "archived"]);

export async function handleCollection(request: Request, url: URL, env: Env): Promise<Response | null> {
  const { pathname } = url;
  if (request.method === "POST" && pathname === "/api/admin/collection-runs") {
    const input = parseStartCollectionRequest(await readJson(request));
    return json(await new CollectionService(env).run(input), 201);
  }
  const repository = new CollectionRepository(env.DB);
  if (request.method === "GET" && pathname === "/api/admin/collection-runs/latest") {
    return json({ runs: await repository.latestRuns(10) });
  }
  const runMatch = pathname.match(/^\/api\/admin\/collection-runs\/([^/]+)$/);
  if (request.method === "GET" && runMatch?.[1]) return json(await repository.getRun(decodeURIComponent(runMatch[1])));

  if (request.method === "GET" && pathname === "/api/admin/candidates") {
    const typeValue = url.searchParams.get("sourceType") ?? undefined;
    const categoryValue = url.searchParams.get("category") ?? undefined;
    const statusValue = url.searchParams.get("status") ?? undefined;
    return json(await repository.listCandidates({
      sourceId: url.searchParams.get("source") ?? undefined,
      sourceType: typeValue && sourceTypes.has(typeValue as SignalSourceType) ? typeValue as SignalSourceType : undefined,
      category: categoryValue && categories.has(categoryValue as SignalCategory) ? categoryValue as SignalCategory : undefined,
      status: statusValue && statuses.has(statusValue as CandidateSignal["status"]) ? statusValue as CandidateSignal["status"] : undefined,
      collectionRunId: url.searchParams.get("collectionRunId") ?? undefined,
      since: url.searchParams.get("since") ?? undefined,
      keyword: url.searchParams.get("keyword") ?? undefined,
      limit: Number(url.searchParams.get("limit") ?? 50),
      cursor: url.searchParams.get("cursor") ?? undefined,
    }));
  }
  const candidateMatch = pathname.match(/^\/api\/admin\/candidates\/([^/]+)$/);
  if (request.method === "GET" && candidateMatch?.[1]) return json(await repository.getCandidate(decodeURIComponent(candidateMatch[1])));
  return null;
}
