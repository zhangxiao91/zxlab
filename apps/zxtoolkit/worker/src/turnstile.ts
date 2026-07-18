const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const EXPECTED_ACTION = "turnstile-spin-v1";

interface TurnstileResult {
  success?: boolean;
  hostname?: string;
  action?: string;
  "error-codes"?: string[];
}

export type TurnstileVerification =
  | { success: true }
  | { success: false; code: "missing" | "unconfigured" | "rejected" | "unavailable" };

export async function verifyTurnstile(request: Request, env: Env, token: unknown): Promise<TurnstileVerification> {
  if (typeof token !== "string" || token.length < 1 || token.length > 2048) return { success: false, code: "missing" };
  if (!env.TURNSTILE_SECRET_KEY) return { success: false, code: "unconfigured" };

  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        secret: env.TURNSTILE_SECRET_KEY,
        response: token,
        remoteip: request.headers.get("cf-connecting-ip") || undefined,
        idempotency_key: crypto.randomUUID()
      }),
      signal: AbortSignal.timeout(5_000)
    });
    if (!response.ok) return { success: false, code: "unavailable" };
    const result: unknown = await response.json();
    if (!isAcceptedResult(result, env)) return { success: false, code: "rejected" };
    return { success: true };
  } catch {
    return { success: false, code: "unavailable" };
  }
}

export function isAcceptedResult(value: unknown, env: Pick<Env, "ENVIRONMENT" | "TURNSTILE_EXPECTED_HOSTNAMES">): boolean {
  if (!value || typeof value !== "object") return false;
  const result = value as TurnstileResult;
  if (result.success !== true) return false;
  if (result.action && result.action !== EXPECTED_ACTION) return false;
  if (env.ENVIRONMENT !== "production") return true;
  const expected = new Set(env.TURNSTILE_EXPECTED_HOSTNAMES.split(",").map((hostname) => hostname.trim()).filter(Boolean));
  return typeof result.hostname === "string" && expected.has(result.hostname);
}
