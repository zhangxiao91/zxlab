import { applyRunFeedback, type D1RunRepository } from "./d1-repository.ts";

export async function handleRunFeedbackRequest(
  request: Request,
  runs: Pick<D1RunRepository, "get" | "recordFeedback">,
  runId: string,
  profileId: string,
): Promise<Response> {
  let body: unknown;
  try { body = await request.json(); }
  catch { return feedbackJson({ error: "INVALID_JSON" }, 400); }

  const value = body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>).value
    : undefined;
  const outcome = await applyRunFeedback(runs, runId, profileId, value);
  if (outcome.kind === "not_found") return feedbackJson({ error: "NOT_FOUND" }, 404);
  if (outcome.kind === "invalid") return feedbackJson({ error: "INVALID_FEEDBACK" }, 400);
  return feedbackJson({ feedback: outcome.feedback });
}

function feedbackJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
    },
  });
}
