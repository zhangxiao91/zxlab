import type { PortfolioSnapshotUpload } from "@zxlab/market-agent-schema";

export type AgentRunMode = "market-only" | "portfolio-aware";
export type PortfolioPurgeScope = "all" | "expired";

export interface AgentRunView {
  id: string;
  workflow: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  evidenceFingerprint: string | null;
  portfolioSnapshotId?: string | null;
  result?: {
    headline: string;
    summary: string;
    mode?: AgentRunMode;
    observations: Array<{
      id: string;
      class: string;
      title: string;
      explanation: string;
      evidenceIds: string[];
    }>;
    limitations: string[];
  };
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
  const response = await fetch("/api/private/market-agent/runs", {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw await apiError(response, "Agent Runs 暂不可用");
  const data = (await response.json()) as unknown;
  return Array.isArray(data)
    ? (data as AgentRunView[])
    : Array.isArray((data as { runs?: unknown })?.runs)
      ? (data as { runs: AgentRunView[] }).runs
      : [];
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

export async function sendRunFeedback(
  runId: string,
  value: "helpful" | "fact_error" | "missing_factor",
): Promise<void> {
  const response = await fetch(
    `/api/private/market-agent/runs/${encodeURIComponent(runId)}/feedback`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value }),
    },
  );
  if (!response.ok) throw await apiError(response, "反馈未保存");
}

export async function exportAgentRuns(): Promise<unknown> {
  const response = await fetch("/api/private/market-agent/export", {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw await apiError(response, "记录导出失败");
  return (await response.json()) as unknown;
}

export async function deleteAgentRun(runId: string): Promise<void> {
  const response = await fetch(
    `/api/private/market-agent/runs/${encodeURIComponent(runId)}`,
    { method: "DELETE", headers: { accept: "application/json" } },
  );
  if (!response.ok) throw await apiError(response, "记录删除失败");
}

async function apiError(response: Response, fallback: string): Promise<MarketAgentApiError> {
  let value: unknown;
  try { value = await response.json(); } catch { value = null; }
  const error = value && typeof value === "object" ? (value as { error?: unknown }).error : null;
  const code = typeof error === "string" ? error : error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string" ? String((error as { code: string }).code) : "MARKET_AGENT_UNAVAILABLE";
  const message = (
    {
      WATCHLIST_BOOTSTRAP_REQUIRED: "请先确认并同步观察列表。",
      PORTFOLIO_SNAPSHOT_NOT_CURRENT: "这份持仓快照已不再用于后续运行。",
      INVALID_PORTFOLIO_SNAPSHOT: "持仓快照未通过服务端字段校验。",
    } as Record<string, string>
  )[code] ?? fallback;
  return new MarketAgentApiError(code, message, response.status);
}
