import { parseAnnotationInput } from "@zxlab/signal-schema";
import { readJson, json } from "../lib/http";
import { AnnotationResponder } from "../services/annotation-responder";
import { ProjectApiSignalLLM, type SignalLLM } from "../services/llm";

interface AnnotationDependencies {
  llm?: SignalLLM;
}

const streamHeaders = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  "X-Content-Type-Options": "nosniff",
};

function encodeEvent(encoder: TextEncoder, type: string, data: Record<string, unknown>): Uint8Array {
  return encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}

export async function handleAnnotations(request: Request, pathname: string, env: Env, dependencies: AnnotationDependencies = {}): Promise<Response | null> {
  if (request.method !== "POST" || pathname !== "/api/annotations") return null;
  const input = parseAnnotationInput(await readJson(request));
  const responder = new AnnotationResponder(env, dependencies.llm ?? new ProjectApiSignalLLM(env));
  const streamRequested = new URL(request.url).searchParams.get("stream") === "1"
    || request.headers.get("accept")?.toLowerCase().includes("text/event-stream");
  if (streamRequested) {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (type: string, data: Record<string, unknown> = {}) => controller.enqueue(encodeEvent(encoder, type, data));
        try {
          send("start");
          const response = await responder.respond(input, {
            replyDelta: (text) => send("reply_delta", { text }),
            replyReady: ({ annotation, reply }) => send("reply", { annotation, reply }),
            memoryReady: (memoryCandidate) => send("memory", { memoryCandidate }),
          });
          send("done", { response });
        } catch (cause) {
          send("error", { error: { message: cause instanceof Error ? cause.message : "Signal annotation failed" } });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(body, { status: 200, headers: streamHeaders });
  }
  return json(await responder.respond(input), 201);
}
