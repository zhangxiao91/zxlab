import type { RuntimePublicSnapshot } from "@zxlab/runtime-schema";

export interface RuntimeClientEnv { RUNTIME_API_URL?: string }

export async function fetchRuntimeStatus(env: RuntimeClientEnv, signal?: AbortSignal): Promise<RuntimePublicSnapshot> {
  const base = env.RUNTIME_API_URL?.trim() || "https://runtime-api.zx-dx.xyz";
  const response = await fetch(new URL("/api/v1/public/status", base), { headers: { Accept: "application/json" }, signal });
  if (!response.ok) throw new Error(`Runtime API returned ${response.status}`);
  return response.json() as Promise<RuntimePublicSnapshot>;
}

export const runtimeHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "public, max-age=15, s-maxage=30",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
