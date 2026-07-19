import type { AIStreamEvent, GenerateAIErrorResponse } from "../../../src/lib/ai/types.ts";
import { enforceAIAccess } from "../../_lib/ai/abuse.ts";
import type { AIEnv } from "../../_lib/ai/config.ts";
import { AIError, asAIError, httpStatusForAIError } from "../../_lib/ai/errors.ts";
import { streamAI } from "../../_lib/ai/router.ts";
import { readGenerateAIRequest } from "../../_lib/ai/validation.ts";

interface FunctionContext {
  request: Request;
  env: AIEnv;
  waitUntil?(promise: Promise<unknown>): void;
}

const jsonHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

const streamHeaders = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function jsonError(error: AIError, requestId: string, environment: string | undefined): Response {
  const debug = environment === "production" ? undefined : { lastErrorCode: error.code };
  const body: GenerateAIErrorResponse = {
    ok: false,
    error: {
      code: error.code,
      message: error.safeMessage,
      ...(error.attempts === undefined ? {} : { attempts: error.attempts }),
      ...(debug ? { debug } : {}),
    },
    requestId,
  };
  return new Response(JSON.stringify(body), { status: httpStatusForAIError(error), headers: jsonHeaders });
}

function encodeEvent(encoder: TextEncoder, event: AIStreamEvent): Uint8Array {
  return encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

export async function onRequest(context: FunctionContext): Promise<Response> {
  const requestId = crypto.randomUUID();
  if (context.request.method !== "POST") {
    return new Response(JSON.stringify({
      ok: false, error: { code: "INVALID_INPUT", message: "Only POST is allowed." }, requestId,
    }), { status: 405, headers: { ...jsonHeaders, Allow: "POST" } });
  }

  try {
    await enforceAIAccess(context.request, context.env);
    const input = await readGenerateAIRequest(context.request);
    const encoder = new TextEncoder();
    const aborter = new AbortController();
    const abort = () => aborter.abort(context.request.signal.reason);
    if (context.request.signal.aborted) abort();
    else context.request.signal.addEventListener("abort", abort, { once: true });

    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = async (event: AIStreamEvent): Promise<void> => {
          if (!aborter.signal.aborted) controller.enqueue(encodeEvent(encoder, event));
        };
        try {
          await send({ type: "start", requestId });
          const data = await streamAI(input, {
            attempt: (event) => send({ type: "attempt", requestId, ...event }),
            delta: (text) => send({ type: "delta", requestId, text }),
            reset: (reason) => send({ type: "reset", requestId, reason }),
          }, {
            env: context.env,
            requestId,
            telemetryDb: context.env.LLM_USAGE_DB,
            scheduleTelemetry: context.waitUntil ? (task) => context.waitUntil!.call(context, task) : undefined,
            signal: aborter.signal,
          });
          await send({ type: "done", requestId, data });
        } catch (cause) {
          const error = cause instanceof AIError ? cause : asAIError(cause);
          if (!aborter.signal.aborted) {
            const debug = context.env.ENVIRONMENT === "production" ? undefined : { lastErrorCode: error.code };
            await send({
              type: "error",
              requestId,
              error: {
                code: error.code,
                message: error.safeMessage,
                ...(error.attempts === undefined ? {} : { attempts: error.attempts }),
                ...(debug ? { debug } : {}),
              },
            });
          }
        } finally {
          context.request.signal.removeEventListener("abort", abort);
          try { controller.close(); } catch { /* The consumer already cancelled the stream. */ }
        }
      },
      cancel(reason) {
        aborter.abort(reason);
        context.request.signal.removeEventListener("abort", abort);
      },
    });

    return new Response(body, { status: 200, headers: streamHeaders });
  } catch (cause) {
    return jsonError(cause instanceof AIError ? cause : asAIError(cause), requestId, context.env.ENVIRONMENT);
  }
}
