import { parseCreateWatchRequest, SignalValidationError } from "@zxlab/signal-schema";
import { json, readJson } from "../lib/http";
import { WatchModule } from "../watch/watch-module";

export async function handleWatches(request: Request, pathname: string, env: Env): Promise<Response | null> {
  const watches = new WatchModule(env.DB);
  if (request.method === "GET" && pathname === "/api/watches") {
    return json({ watches: await watches.list() });
  }
  if (request.method === "POST" && pathname === "/api/watches") {
    const input = parseCreateWatchRequest(await readJson(request));
    return json({ watch: await watches.create(input) }, 201);
  }
  const resolveMatch = pathname.match(/^\/api\/watches\/([^/]+)\/resolve$/);
  if (!resolveMatch || request.method !== "POST") return null;
  let id: string;
  try {
    id = decodeURIComponent(resolveMatch[1] ?? "");
  } catch {
    throw new SignalValidationError("Watch id is invalid");
  }
  if (!id || id.length > 120) throw new SignalValidationError("Watch id is invalid");
  return json({ watch: await watches.resolve(id) });
}
