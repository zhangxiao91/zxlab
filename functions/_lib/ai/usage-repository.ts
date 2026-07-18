import type { LLMUsageDatabase } from "./telemetry.ts";

export type LLMUsageRange = "24h" | "today" | "7d" | "30d";
const ranges: Record<LLMUsageRange, number> = { "24h": 24, today: 24, "7d": 168, "30d": 720 };
export function rangeStart(range: LLMUsageRange, now = new Date()): string {
  if (range === "today") return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  return new Date(now.getTime() - ranges[range] * 3_600_000).toISOString();
}
export function parseRange(value: string | null): LLMUsageRange { return value === "today" || value === "7d" || value === "30d" ? value : "24h"; }
type Row = Record<string, number | string | null>;
const n = (value: unknown) => typeof value === "number" ? value : Number(value ?? 0) || 0;

export async function getLLMUsageDashboard(db: LLMUsageDatabase, range: LLMUsageRange) {
  const start = rangeStart(range);
  const totals = await db.prepare(`SELECT COUNT(*) attempts, COUNT(DISTINCT request_id) logical_requests, SUM(input_tokens) input_tokens, SUM(output_tokens) output_tokens, SUM(cached_input_tokens) cached_input_tokens, SUM(reasoning_tokens) reasoning_tokens, SUM(total_tokens) total_tokens, SUM(estimated_cost_usd) estimated_cost_usd, AVG(latency_ms) average_latency_ms FROM llm_usage_events WHERE created_at >= ?`).bind(start).first<Row>() ?? {};
  const requests = await db.prepare(`SELECT request_id, MAX(CASE WHEN status = 'success' THEN 1 ELSE 0 END) succeeded, MAX(fallback_depth) depth FROM llm_usage_events WHERE created_at >= ? GROUP BY request_id`).bind(start).all<Row>();
  const successful = requests.results.filter((row) => n(row.succeeded) === 1).length;
  const fallbackRequests = requests.results.filter((row) => n(row.depth) > 0).length;
  const models = await db.prepare(`SELECT provider, model, COUNT(*) attempts, SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) successes, SUM(total_tokens) total_tokens, SUM(estimated_cost_usd) estimated_cost_usd, AVG(latency_ms) average_latency_ms FROM llm_usage_events WHERE created_at >= ? GROUP BY provider, model ORDER BY attempts DESC LIMIT 20`).bind(start).all<Row>();
  const sources = await db.prepare(`SELECT source, COUNT(*) attempts, SUM(total_tokens) total_tokens, SUM(estimated_cost_usd) estimated_cost_usd FROM llm_usage_events WHERE created_at >= ? GROUP BY source ORDER BY attempts DESC LIMIT 20`).bind(start).all<Row>();
  const bucket = range === "24h" ? "%Y-%m-%dT%H:00:00.000Z" : "%Y-%m-%dT00:00:00.000Z";
  const trend = await db.prepare(`SELECT strftime('${bucket}', created_at) bucket, COUNT(*) attempts, COUNT(DISTINCT request_id) logical_requests FROM llm_usage_events WHERE created_at >= ? GROUP BY bucket ORDER BY bucket`).bind(start).all<Row>();
  const fallbacks = await db.prepare(`SELECT fallback_from_provider, fallback_from_model, provider, model, fallback_depth, COUNT(*) attempts, SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) successes FROM llm_usage_events WHERE created_at >= ? AND fallback_depth > 0 GROUP BY fallback_from_provider, fallback_from_model, provider, model, fallback_depth ORDER BY attempts DESC LIMIT 20`).bind(start).all<Row>();
  const errors = await db.prepare(`SELECT created_at, source, provider, model, error_type, error_code, request_id FROM llm_usage_events WHERE created_at >= ? AND status != 'success' ORDER BY created_at DESC LIMIT 20`).bind(start).all<Row>();
  return {
    range, updatedAt: new Date().toISOString(), summary: { logicalRequests: n(totals.logical_requests), providerAttempts: n(totals.attempts), successfulRequests: successful, failedRequests: Math.max(0, n(totals.logical_requests) - successful), successRate: n(totals.logical_requests) ? successful / n(totals.logical_requests) : null, inputTokens: n(totals.input_tokens), outputTokens: n(totals.output_tokens), cachedInputTokens: n(totals.cached_input_tokens), reasoningTokens: n(totals.reasoning_tokens), totalTokens: n(totals.total_tokens), estimatedCostUsd: totals.estimated_cost_usd === null || totals.estimated_cost_usd === undefined ? null : n(totals.estimated_cost_usd), averageLatencyMs: totals.average_latency_ms === null || totals.average_latency_ms === undefined ? null : n(totals.average_latency_ms), fallbackRequests, fallbackRecoveredRequests: requests.results.filter((row) => n(row.depth) > 0 && n(row.succeeded) === 1).length }, models: models.results, sources: sources.results, trend: trend.results, fallbacks: fallbacks.results, recentErrors: errors.results,
  };
}
