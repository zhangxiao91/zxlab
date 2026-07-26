import { getPublicTailscaleDevices, type TailscaleEnv } from "../../_lib/tailscale.ts";

interface RuntimeHealthEnv extends TailscaleEnv {
  ZX_RUNTIME_SERVICE_TOKEN?: string;
  CF_PAGES_BRANCH?: string;
  CF_PAGES_COMMIT_SHA?: string;
}

interface FunctionContext { request: Request; env: RuntimeHealthEnv }

async function tokenMatches(provided: string, expected: string) {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return new Uint8Array(left).every((value, index) => value === new Uint8Array(right)[index]);
}

export const onRequestGet = async ({ request, env }: FunctionContext) => {
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const expected = env.ZX_RUNTIME_SERVICE_TOKEN ?? "";
  if (!provided || !expected || !await tokenMatches(provided, expected)) {
    return Response.json({ error: { code: "UNAUTHORIZED", message: "Runtime service token is required." } }, { status: 401 });
  }
  const generatedAt = new Date().toISOString();
  let devices: Awaited<ReturnType<typeof getPublicTailscaleDevices>> = [];
  let devicesAvailable = false;
  try {
    const deviceFetcher: typeof fetch = (input, init = {}) => fetch(input, { ...init, signal: AbortSignal.timeout(1_800) });
    devices = await getPublicTailscaleDevices(env, deviceFetcher);
    devicesAvailable = true;
  } catch {
    // Site health must stay independent from the optional device-presence source.
  }
  return Response.json({
    schemaVersion: "1",
    serviceId: "pages",
    status: "operational",
    version: env.CF_PAGES_COMMIT_SHA?.slice(0, 7) ?? "unknown",
    generatedAt,
    checks: [
      { id: "site", status: "operational", lastSuccessAt: generatedAt },
      { id: "functions", status: "operational", lastSuccessAt: generatedAt },
    ],
    public: { branch: env.CF_PAGES_BRANCH ?? "unknown", devices, devicesAvailable },
  }, { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
};
