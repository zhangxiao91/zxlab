interface RuntimeHealthEnv {
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
    public: { branch: env.CF_PAGES_BRANCH ?? "unknown" },
  }, { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
};
