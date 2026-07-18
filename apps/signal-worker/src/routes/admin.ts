import { parseGenerateBriefingRequest } from "@zxlab/signal-schema";
import { readJson, json } from "../lib/http";
import { BriefingGenerator } from "../services/briefing-generator";
import { WorkersSignalLLM } from "../services/llm";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function handleAdmin(request: Request, pathname: string, env: Env): Promise<Response | null> {
  if (request.method !== "POST" || pathname !== "/api/admin/briefings/generate") return null;
  const input = parseGenerateBriefingRequest(await readJson(request));
  const generator = new BriefingGenerator(env, new WorkersSignalLLM(env));
  const candidates = input.useFixture ? generator.fixture() : input.candidates ?? [];
  return json(await generator.generate({ date: input.date ?? today(), candidates, dataOrigin: input.useFixture ? "fixture" : "real" }), 201);
}
