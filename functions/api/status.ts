import { fetchRuntimeStatus, runtimeHeaders, type RuntimeClientEnv } from "../_lib/runtime-client.ts";

interface FunctionContext { request: Request; env: RuntimeClientEnv }

export const onRequestGet = async ({ request, env }: FunctionContext) => {
  try {
    return new Response(JSON.stringify(await fetchRuntimeStatus(env, request.signal)), { headers: runtimeHeaders });
  } catch {
    return Response.json({ error: { code: "RUNTIME_UNAVAILABLE", message: "Runtime status is temporarily unavailable." } }, { status: 503, headers: runtimeHeaders });
  }
};
