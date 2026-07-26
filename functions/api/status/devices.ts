import { fetchRuntimeStatus, runtimeHeaders, type RuntimeClientEnv } from "../../_lib/runtime-client";

interface FunctionContext { request: Request; env: RuntimeClientEnv }

export const onRequestGet = async ({ request, env }: FunctionContext) => {
  try {
    const snapshot = await fetchRuntimeStatus(env, request.signal);
    const module = snapshot.modules.find((item) => item.id === "agents");
    const data = module?.data as { agents?: unknown[] } | null;
    if (!data?.agents) throw new Error("Agents unavailable");
    return new Response(JSON.stringify(data.agents), { headers: runtimeHeaders });
  } catch {
    return Response.json({ error: "status_unavailable", message: "Live agent status is temporarily unavailable." }, { status: 503, headers: runtimeHeaders });
  }
};
