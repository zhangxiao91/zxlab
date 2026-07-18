import { fallbackReview, generateGatewayReview, parseEvidencePackRequest, RiskReviewError, type RiskReviewEnv, verifyCloudflareAccess } from "../../_lib/risk/review.ts";

interface FunctionContext { request: Request; env: RiskReviewEnv }
interface ReviewDependencies { verifyAccess?: typeof verifyCloudflareAccess; fetcher?: typeof fetch }

const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers });

export async function handleRiskReview(context: FunctionContext, dependencies: ReviewDependencies = {}): Promise<Response> {
  const requestId = crypto.randomUUID();
  if (context.request.method !== "POST") return new Response(JSON.stringify({ ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "Only POST is allowed." }, requestId }), { status: 405, headers: { ...headers, Allow: "POST" } });
  try {
    await (dependencies.verifyAccess ?? verifyCloudflareAccess)(context.request, context.env);
    const contentType = context.request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") throw new RiskReviewError("INVALID_INPUT", "Content-Type 必须为 application/json。", 400);
    const declaredLength = Number(context.request.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > 256 * 1024) throw new RiskReviewError("EVIDENCE_TOO_LARGE", "Evidence Pack 超过请求上限。", 413);
    const raw = await context.request.text();
    if (new TextEncoder().encode(raw).byteLength > 256 * 1024) throw new RiskReviewError("EVIDENCE_TOO_LARGE", "Evidence Pack 超过请求上限。", 413);
    let body: unknown;
    try { body = JSON.parse(raw) as unknown; }
    catch (cause) { throw new RiskReviewError("INVALID_INPUT", "复盘请求不是有效 JSON。", 400, { cause }); }
    const pack = parseEvidencePackRequest(body);
    try {
      const review = await generateGatewayReview(context.request, context.env, pack, dependencies.fetcher);
      console.log(JSON.stringify({ event: "risk.review.completed", requestId, mode: review.mode, provider: review.provider, model: review.model, fallbackIndex: review.fallbackIndex, evidenceCount: pack.evidence.length }));
      return json({ ok: true, data: review, requestId });
    } catch (cause) {
      const failure = cause instanceof RiskReviewError ? cause : new RiskReviewError("REVIEW_FAILED", "真实复盘暂不可用。", 502, { cause });
      console.error(JSON.stringify({ event: "risk.review.fallback", requestId, code: failure.code, evidenceCount: pack.evidence.length }));
      return json({ ok: true, data: await fallbackReview(pack, failure.code), requestId });
    }
  } catch (cause) {
    const error = cause instanceof RiskReviewError ? cause : new RiskReviewError("UNKNOWN", "真实复盘请求失败。", 500, { cause });
    console.error(JSON.stringify({ event: "risk.review.rejected", requestId, code: error.code, status: error.status }));
    return json({ ok: false, error: { code: error.code, message: error.safeMessage }, requestId }, error.status);
  }
}

export const onRequest = (context: FunctionContext) => handleRiskReview(context);
