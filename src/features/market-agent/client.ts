import type {
  AgentFeedback,
  AgentFeedbackValue,
  AskScope,
  RunOutcome,
  PortfolioSnapshotUpload,
  SealedEvidenceBundle,
} from "@zxlab/market-agent-schema";

export type AgentRunMode = "market-only" | "portfolio-aware";
export type PortfolioPurgeScope = "all" | "expired";

export interface AgentObservationView {
  id: string;
  class: "fact" | "inference" | "unknown";
  importance: "high" | "medium" | "low";
  title: string;
  explanation: string;
  evidenceIds: string[];
}

export interface AgentRunView {
  id: string;
  workflow: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  evidenceFingerprint: string | null;
  payloadPurgedAt?: string | null;
  portfolioSnapshotId?: string | null;
  feedback?: AgentFeedback | null;
  result?: {
    status: "success" | "partial";
    headline: string;
    summary: string;
    mode?: AgentRunMode;
    askScope?: AskScope;
    observations: AgentObservationView[];
    portfolioImpacts: AgentObservationView[];
    watchNext: Array<{ condition: string; reason: string; evidenceIds: string[] }>;
    limitations: string[];
    outcome?: RunOutcome;
  };
}

export interface AgentRunPage {
  runs: AgentRunView[];
  nextCursor: string | null;
}

export interface AgentAskIntent {
  scope: AskScope;
  instrumentId?: string;
  question?: string;
  priorRunId?: string;
}

export interface AgentProfileView {
  profileId: string;
  watchlistRevision: string | null;
  bootstrap: "required" | "complete";
}

export interface AgentWatchlistItem {
  instrumentId: string;
  reason?: string;
}

export interface AgentPortfolioSnapshotView {
  id: string;
  sourceRevision: string;
  calculatedAt: string;
  effectiveAt: string;
  expiresAt: string;
  positions: Array<{ instrumentId: string; quantity: number; averageCost: number }>;
  cash: number;
  rulesVersion: string;
  reliable: boolean;
  warnings: string[];
  fingerprint: string;
  createdAt: string;
  stoppedAt: string | null;
}

export interface PortfolioSnapshotControlState {
  snapshot: AgentPortfolioSnapshotView | null;
  historicalSnapshotCount: number;
  linkedRunCount: number;
  expiredSnapshotCount: number;
  expiredLinkedRunCount: number;
}

export class MarketAgentApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "MarketAgentApiError";
  }
}

export async function getAgentRuns(): Promise<AgentRunView[]> {
  return (await getAgentRunPage()).runs;
}

export async function getAgentRunPage(cursor?: string | null, limit = 20): Promise<AgentRunPage> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  const response = await fetch(`/api/private/market-agent/runs?${params}`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw await apiError(response, "Agent Runs 暂不可用");
  const data = (await response.json()) as unknown;
  if (Array.isArray(data)) return { runs: data as AgentRunView[], nextCursor: null };
  const page = data as { runs?: unknown; nextCursor?: unknown };
  return {
    runs: Array.isArray(page?.runs) ? page.runs as AgentRunView[] : [],
    nextCursor: typeof page?.nextCursor === "string" ? page.nextCursor : null,
  };
}

export async function getAgentRun(runId: string, signal?: AbortSignal): Promise<AgentRunView> {
  const response = await fetch(
    `/api/private/market-agent/runs/${encodeURIComponent(runId)}`,
    { headers: { accept: "application/json" }, signal },
  );
  if (!response.ok) throw await apiError(response, "Agent Run 暂不可用");
  return (await response.json()) as AgentRunView;
}

export interface AgentRunStreamHandlers {
  onStatus?(run: AgentRunView): void;
  onAnswerDelta?(delta: string): void;
  onDone?(run: AgentRunView): void;
}

export async function streamAgentRun(
  runId: string,
  handlers: AgentRunStreamHandlers,
  options: { signal?: AbortSignal; fetcher?: typeof fetch } = {},
): Promise<AgentRunView> {
  const response = await (options.fetcher ?? fetch)(
    `/api/private/market-agent/runs/${encodeURIComponent(runId)}/stream`,
    { headers: { accept: "text/event-stream" }, signal: options.signal },
  );
  if (!response.ok) throw await apiError(response, "Agent 实时状态暂不可用");
  if (!response.body || !response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
    throw new MarketAgentApiError("RUN_STREAM_INVALID", "Agent 实时响应格式无效", response.status);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let buffer = "";
  let eventName = "message";
  let dataLines: string[] = [];
  let completed: AgentRunView | null = null;

  const dispatch = () => {
    if (!dataLines.length) {
      eventName = "message";
      return;
    }
    const raw = dataLines.join("\n");
    dataLines = [];
    let data: Record<string, unknown>;
    try { data = JSON.parse(raw) as Record<string, unknown>; }
    catch { throw new MarketAgentApiError("RUN_STREAM_INVALID", "Agent 实时响应无法解析", response.status); }
    if (eventName === "status" && isRunView(data.run)) handlers.onStatus?.(data.run);
    if (eventName === "answer_delta" && typeof data.delta === "string") handlers.onAnswerDelta?.(data.delta);
    if (eventName === "done" && isRunView(data.run)) {
      completed = data.run;
      handlers.onDone?.(data.run);
    }
    if (eventName === "error") {
      const code = typeof data.code === "string" ? data.code : "RUN_STREAM_UNAVAILABLE";
      throw new MarketAgentApiError(code, streamErrorMessage(code), response.status);
    }
    eventName = "message";
  };

  while (!completed) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 2 * 1024 * 1024) throw new MarketAgentApiError("RUN_STREAM_TOO_LARGE", "Agent 实时响应过大", response.status);
    buffer += decoder.decode(value, { stream: true });
    while (!completed) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (!line) dispatch();
      else if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
  }

  if (completed) {
    void reader.cancel();
    return completed;
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    for (const line of buffer.split(/\r?\n/)) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    dispatch();
  }
  if (completed) return completed;
  throw new MarketAgentApiError("RUN_STREAM_INCOMPLETE", "Agent 实时连接提前结束", response.status);
}

export async function pollAgentRunUntilTerminal(
  runId: string,
  onRun: (run: AgentRunView) => void,
  signal?: AbortSignal,
  intervalMs = 1_200,
): Promise<AgentRunView> {
  while (!signal?.aborted) {
    const run = await getAgentRun(runId, signal);
    onRun(run);
    if (["success", "partial", "failed"].includes(run.status)) return run;
    await wait(intervalMs, signal);
  }
  throw new DOMException("Aborted", "AbortError");
}

export async function getAgentRunEvidence(
  runId: string,
): Promise<SealedEvidenceBundle> {
  const response = await fetch(
    `/api/private/market-agent/runs/${encodeURIComponent(runId)}/evidence`,
    { headers: { accept: "application/json" } },
  );
  if (!response.ok) throw await apiError(response, "Evidence 暂不可用");
  const data = (await response.json()) as { evidence?: unknown };
  if (!data.evidence || typeof data.evidence !== "object") {
    throw new MarketAgentApiError(
      "EVIDENCE_INVALID",
      "Evidence 响应格式无效",
      response.status,
    );
  }
  return data.evidence as SealedEvidenceBundle;
}

export async function getAgentProfile(): Promise<AgentProfileView> {
  const response = await fetch("/api/private/market-agent/profile", {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw await apiError(response, "Profile 暂不可用");
  return (await response.json()) as AgentProfileView;
}

export async function syncAgentWatchlist(
  revision: string,
  items: AgentWatchlistItem[],
): Promise<{
  profile: AgentProfileView;
  watchlist: { revision: string; items: AgentWatchlistItem[] };
}> {
  const response = await fetch("/api/private/market-agent/watchlist", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ revision, items }),
  });
  if (!response.ok) throw await apiError(response, "观察列表同步失败");
  return (await response.json()) as {
    profile: AgentProfileView;
    watchlist: { revision: string; items: AgentWatchlistItem[] };
  };
}

export async function getPortfolioSnapshotControlState(): Promise<PortfolioSnapshotControlState> {
  const response = await fetch("/api/private/market-agent/portfolio-snapshot", {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw await apiError(response, "持仓快照状态暂不可用");
  return (await response.json()) as PortfolioSnapshotControlState;
}

export async function syncPortfolioSnapshot(
  snapshot: PortfolioSnapshotUpload,
): Promise<PortfolioSnapshotControlState> {
  const response = await fetch("/api/private/market-agent/portfolio-snapshot", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(snapshot),
  });
  if (!response.ok) throw await apiError(response, "持仓快照同步失败");
  return (await response.json()) as PortfolioSnapshotControlState;
}

export async function stopPortfolioSnapshot(
  snapshotId: string,
): Promise<PortfolioSnapshotControlState & { stopped: boolean; detachedRunCount: number }> {
  const response = await fetch("/api/private/market-agent/portfolio-snapshot/stop", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ snapshotId }),
  });
  if (!response.ok) throw await apiError(response, "停止使用持仓快照失败");
  return (await response.json()) as PortfolioSnapshotControlState & {
    stopped: boolean;
    detachedRunCount: number;
  };
}

export async function purgePortfolioSnapshotHistory(
  scope: PortfolioPurgeScope,
): Promise<PortfolioSnapshotControlState & { snapshots: number; runs: number }> {
  const response = await fetch("/api/private/market-agent/portfolio-snapshot/purge", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ scope, confirmation: "purge-portfolio-history" }),
  });
  if (!response.ok) throw await apiError(response, "清除持仓快照历史失败");
  return (await response.json()) as PortfolioSnapshotControlState & {
    snapshots: number;
    runs: number;
  };
}

export async function startCloseReview(
  idempotencyKey = crypto.randomUUID(),
): Promise<{ runId: string; status: string }> {
  const response = await fetch("/api/private/market-agent/runs", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ workflow: "close_review", idempotencyKey }),
  });
  if (!response.ok) throw await apiError(response, "盘后复盘暂不可用");
  return (await response.json()) as { runId: string; status: string };
}

export async function startAgentAsk(
  intent: AgentAskIntent,
  idempotencyKey = crypto.randomUUID(),
): Promise<{ runId: string; status: string; created: boolean; scope: AskScope }> {
  const response = await fetch("/api/private/market-agent/ask", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      scope: intent.scope,
      idempotencyKey,
      ...(intent.instrumentId?.trim()
        ? { instrumentId: intent.instrumentId.trim().toUpperCase() }
        : {}),
      ...(intent.question?.trim() ? { question: intent.question.trim() } : {}),
      ...(intent.priorRunId?.trim() ? { priorRunId: intent.priorRunId.trim() } : {}),
    }),
  });
  if (!response.ok) throw await apiError(response, "受限问答暂不可用");
  return (await response.json()) as {
    runId: string;
    status: string;
    created: boolean;
    scope: AskScope;
  };
}

export async function sendRunFeedback(
  runId: string,
  value: AgentFeedbackValue,
): Promise<AgentFeedback> {
  const response = await fetch(
    `/api/private/market-agent/runs/${encodeURIComponent(runId)}/feedback`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value }),
    },
  );
  if (!response.ok) throw await apiError(response, "反馈未保存");
  const payload = (await response.json()) as { feedback?: AgentFeedback };
  if (!payload.feedback) {
    throw new MarketAgentApiError("INVALID_FEEDBACK_RESPONSE", "反馈已提交，但服务器没有返回保存状态。", 502);
  }
  return payload.feedback;
}

export async function exportAgentRuns(): Promise<Blob> {
  const response = await fetch("/api/private/market-agent/export", {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw await apiError(response, "记录导出失败");
  return response.blob();
}

export async function deleteAgentRun(runId: string): Promise<{ runId: string; evidenceFingerprint: string | null; purgedAt: string; reason: "user_deleted" }> {
  const response = await fetch(
    `/api/private/market-agent/runs/${encodeURIComponent(runId)}`,
    { method: "DELETE", headers: { accept: "application/json" } },
  );
  if (!response.ok) throw await apiError(response, "记录删除失败");
  const data = await response.json() as { tombstone?: unknown };
  if (!data.tombstone || typeof data.tombstone !== "object") throw new MarketAgentApiError("RUN_TOMBSTONE_INVALID", "记录删除结果无效", response.status);
  return data.tombstone as { runId: string; evidenceFingerprint: string | null; purgedAt: string; reason: "user_deleted" };
}

async function apiError(response: Response, fallback: string): Promise<MarketAgentApiError> {
  let value: unknown;
  try { value = await response.json(); } catch { value = null; }
  const record = value && typeof value === "object" ? value as { error?: unknown; clarification?: unknown } : null;
  const error = record?.error ?? null;
  const clarification = typeof record?.clarification === "string" ? record.clarification : null;
  const code = typeof error === "string" ? error : error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string" ? String((error as { code: string }).code) : "MARKET_AGENT_UNAVAILABLE";
  const mappedMessage = (
    {
      WATCHLIST_BOOTSTRAP_REQUIRED: "请先确认并同步观察列表。",
      PORTFOLIO_SNAPSHOT_NOT_CURRENT: "这份持仓快照已不再用于后续运行。",
      INVALID_PORTFOLIO_SNAPSHOT: "持仓快照未通过服务端字段校验。",
      ASK_CLARIFICATION_REQUIRED: "当前问题需要补充范围后才能运行。",
    } as Record<string, string>
  )[code];
  const message = clarification ?? mappedMessage ?? fallback;
  return new MarketAgentApiError(code, message, response.status);
}

function isRunView(value: unknown): value is AgentRunView {
  return Boolean(value && typeof value === "object"
    && typeof (value as { id?: unknown }).id === "string"
    && typeof (value as { status?: unknown }).status === "string");
}

function streamErrorMessage(code: string): string {
  return ({
    RUN_NOT_FOUND: "这条 Agent Run 已不存在。",
    RUN_STREAM_TIMEOUT: "Agent 运行时间超过实时连接窗口。",
    RUN_STREAM_ABORTED: "Agent 实时连接已取消。",
  } as Record<string, string>)[code] ?? "Agent 实时连接暂不可用";
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
