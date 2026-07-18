import type { GenerateAIErrorResponse, GenerateAISuccessResponse } from "../../../src/lib/ai/types.ts";
import { enforceAIAccess } from "../../_lib/ai/abuse.ts";
import type { AIEnv } from "../../_lib/ai/config.ts";
import { AIError, asAIError, httpStatusForAIError } from "../../_lib/ai/errors.ts";
import { generateAI } from "../../_lib/ai/router.ts";
import { readGenerateAIRequest } from "../../_lib/ai/validation.ts";

interface FunctionContext {
  request: Request;
  env: AIEnv;
  waitUntil?(promise: Promise<unknown>): void;
}

const responseHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function json(data: GenerateAISuccessResponse | GenerateAIErrorResponse, status: number): Response {
  return new Response(JSON.stringify(data), { status, headers: responseHeaders });
}

export async function onRequest(context: FunctionContext): Promise<Response> {
  const requestId = crypto.randomUUID();
  if (context.request.method !== "POST") {
    return new Response(JSON.stringify({
      ok: false, error: { code: "INVALID_INPUT", message: "Only POST is allowed." }, requestId,
    }), { status: 405, headers: { ...responseHeaders, Allow: "POST" } });
  }
  try {
    await enforceAIAccess(context.request, context.env);
    const input = await readGenerateAIRequest(context.request);
    const data = await generateAI(input, { env: context.env, requestId, telemetryDb: context.env.LLM_USAGE_DB,
      scheduleTelemetry: context.waitUntil ? (task) => context.waitUntil!(task) : undefined });
    return json({ ok: true, data, requestId }, 200);
  } catch (cause) {
    const error = cause instanceof AIError ? cause : asAIError(cause);
    const debug = context.env.ENVIRONMENT === "production" ? undefined : { lastErrorCode: error.code };
    return json({
      ok: false,
      error: {
        code: error.code,
        message: error.safeMessage,
        ...(error.attempts === undefined ? {} : { attempts: error.attempts }),
        ...(debug ? { debug } : {}),
      },
      requestId,
    }, httpStatusForAIError(error));
  }
}
