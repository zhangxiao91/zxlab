import { parseAnnotationInput } from "@zxlab/signal-schema";
import { readJson, json } from "../lib/http";
import { AnnotationResponder } from "../services/annotation-responder";
import { WorkersSignalLLM } from "../services/llm";

export async function handleAnnotations(request: Request, pathname: string, env: Env): Promise<Response | null> {
  if (request.method !== "POST" || pathname !== "/api/annotations") return null;
  const input = parseAnnotationInput(await readJson(request));
  const responder = new AnnotationResponder(env, new WorkersSignalLLM(env));
  return json(await responder.respond(input), 201);
}
