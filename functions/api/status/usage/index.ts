import { fetchRuntimeStatus, runtimeHeaders, type RuntimeClientEnv } from "../../../_lib/runtime-client";

interface FunctionContext { request: Request; env: RuntimeClientEnv }

export const onRequestGet = async ({ request, env }: FunctionContext) => {
  try {
    const snapshot = await fetchRuntimeStatus(env, request.signal);
    const module = snapshot.modules.find((item) => item.id === "usage");
    if (!module?.data) throw new Error("Usage unavailable");
    return new Response(JSON.stringify(module.data), { headers: runtimeHeaders });
  } catch {
    return Response.json({ status: "offline", updatedAt: new Date().toISOString(), limits: [], tokenSummary: {}, dailyUsage: [], error: { code: "RUNTIME_UNAVAILABLE", message: "Codex usage is temporarily unavailable." } }, { status: 503, headers: runtimeHeaders });
  }
};
