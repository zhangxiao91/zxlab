import { randomUUID } from "node:crypto";

export const marketAgentAskScopes = [
  "today_change",
  "relative_performance",
  "news_and_announcements",
  "data_quality",
  "portfolio_impact",
  "compare_previous_run",
] as const;

export type MarketAgentAskScope = typeof marketAgentAskScopes[number];

export interface MarketAgentAskInput {
  scope: MarketAgentAskScope;
  instrumentId?: string;
  question?: string;
  priorRunId?: string;
}

export interface MarketAgentRun {
  id: string;
  workflow: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  evidenceFingerprint?: string | null;
  result?: Record<string, unknown>;
}

export interface MarketAgentAskResult {
  run: MarketAgentRun;
  evidence: Record<string, unknown> | null;
}

export interface MarketAgentClientOptions {
  baseUrl: string;
  accessClientId?: string;
  accessClientSecret?: string;
  timeoutMs: number;
  runWaitMs?: number;
  pollIntervalMs?: number;
  fetcher?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

const terminalStatuses = new Set(["success", "partial", "failed"]);

export async function askMarketAgent(
  options: MarketAgentClientOptions,
  input: MarketAgentAskInput,
): Promise<MarketAgentAskResult> {
  assertConfiguration(options);
  if (!marketAgentAskScopes.includes(input.scope)) {
    throw new Error("Market Agent scope is invalid.");
  }
  const started = await requestJson(options, "/api/private/market-agent/ask", {
    method: "POST",
    body: {
      scope: input.scope,
      idempotencyKey: `bot:${randomUUID()}`,
      ...(input.instrumentId?.trim()
        ? { instrumentId: input.instrumentId.trim().toUpperCase() }
        : {}),
      ...(input.question?.trim() ? { question: input.question.trim() } : {}),
      ...(input.priorRunId?.trim() ? { priorRunId: input.priorRunId.trim() } : {}),
    },
  });
  if (!isRecord(started) || typeof started.runId !== "string") {
    throw new Error("Market Agent returned an invalid queued Run.");
  }

  const deadline = Date.now() + (options.runWaitMs ?? 120_000);
  const interval = Math.max(100, options.pollIntervalMs ?? 1_300);
  const sleep = options.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let run: MarketAgentRun | null = null;
  while (Date.now() <= deadline) {
    const value = await requestJson(options, `/api/private/market-agent/runs/${encodeURIComponent(started.runId)}`, { method: "GET" });
    run = parseRun(value);
    if (terminalStatuses.has(run.status)) {
      const evidence = run.evidenceFingerprint
        ? await readEvidence(options, run.id)
        : null;
      return { run, evidence };
    }
    await sleep(interval);
  }
  throw new Error("Market Agent Run did not complete before the bridge timeout.");
}

async function readEvidence(
  options: MarketAgentClientOptions,
  runId: string,
): Promise<Record<string, unknown>> {
  const value = await requestJson(
    options,
    `/api/private/market-agent/runs/${encodeURIComponent(runId)}/evidence`,
    { method: "GET" },
  );
  if (!isRecord(value) || !isRecord(value.evidence)) {
    throw new Error("Market Agent returned an invalid Evidence bundle.");
  }
  return value.evidence;
}

function assertConfiguration(options: MarketAgentClientOptions) {
  if (!options.accessClientId?.trim() || !options.accessClientSecret?.trim()) {
    throw new Error("Cloudflare Access service-token credentials are not configured for Market Agent.");
  }
}

async function requestJson(
  options: MarketAgentClientOptions,
  path: string,
  request: { method: "GET" | "POST"; body?: unknown },
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await (options.fetcher ?? fetch)(new URL(path, options.baseUrl), {
      method: request.method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "zxlab-bot-bridge/0.2",
        "CF-Access-Client-Id": options.accessClientId!.trim(),
        "CF-Access-Client-Secret": options.accessClientSecret!.trim(),
      },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      signal: controller.signal,
    });
    const value: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw new Error(errorMessage(value, response.status));
    return value;
  } finally {
    clearTimeout(timeout);
  }
}

function parseRun(value: unknown): MarketAgentRun {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.workflow !== "string" || typeof value.status !== "string") {
    throw new Error("Market Agent returned an invalid Run.");
  }
  return {
    id: value.id,
    workflow: value.workflow,
    status: value.status,
    ...(typeof value.createdAt === "string" ? { createdAt: value.createdAt } : {}),
    ...(typeof value.updatedAt === "string" ? { updatedAt: value.updatedAt } : {}),
    ...(typeof value.evidenceFingerprint === "string" || value.evidenceFingerprint === null
      ? { evidenceFingerprint: value.evidenceFingerprint }
      : {}),
    ...(isRecord(value.result) ? { result: value.result } : {}),
  };
}

function errorMessage(value: unknown, status: number): string {
  if (isRecord(value)) {
    if (typeof value.clarification === "string") return value.clarification;
    if (typeof value.error === "string") return value.error;
    if (isRecord(value.error) && typeof value.error.message === "string") return value.error.message;
  }
  return `Market Agent returned HTTP ${status}.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
