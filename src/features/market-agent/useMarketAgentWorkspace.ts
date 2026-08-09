import { useCallback, useEffect, useMemo, useState } from "react";
import { loadMarketWatchlist } from "../market/watchlist";
import { LocalPortfolioRepository } from "../risk/ledger";
import {
  deleteAgentRun,
  exportAgentRuns,
  getAgentProfile,
  getAgentRuns,
  getPortfolioSnapshotControlState,
  purgePortfolioSnapshotHistory,
  sendRunFeedback,
  startCloseReview,
  stopPortfolioSnapshot,
  syncAgentWatchlist,
  syncPortfolioSnapshot,
  type AgentObservationView,
  type AgentProfileView,
  type AgentRunView,
  type AgentWatchlistItem,
  type PortfolioPurgeScope,
  type PortfolioSnapshotControlState,
} from "./client";
import {
  previewLocalPortfolioSnapshot,
  type LocalPortfolioSnapshotPreview,
} from "./portfolio-snapshot";

type RunFeedback = "helpful" | "fact_error" | "missing_factor";

export interface MarketAgentWorkspace {
  agent: {
    runs: AgentRunView[];
    latest: AgentRunView | undefined;
    events: AgentObservationView[];
    askInstruments: string[];
    bootstrap: AgentProfileView["bootstrap"] | null;
    loading: boolean;
    reviewBusy: boolean;
    error: string | null;
    setupNote: string | null;
    deletingRunId: string | null;
    activeEvidenceId: string | null;
  };
  watchlist: {
    items: AgentWatchlistItem[];
    syncing: boolean;
  };
  portfolio: {
    preview: LocalPortfolioSnapshotPreview | null;
    state: PortfolioSnapshotControlState | null;
    stateLoaded: boolean;
    busy: boolean;
    error: string | null;
    note: string | null;
    purgeScope: PortfolioPurgeScope | null;
  };
  commands: {
    refresh(): Promise<void>;
    runReview(): Promise<void>;
    confirmWatchlist(): Promise<void>;
    downloadRuns(): Promise<void>;
    removeRun(run: AgentRunView): Promise<void>;
    saveFeedback(runId: string, value: RunFeedback): Promise<void>;
    updateRun(run: AgentRunView): void;
    toggleEvidence(evidenceId: string): void;
    refreshPortfolioPreview(): LocalPortfolioSnapshotPreview;
    syncLocalPortfolioSnapshot(): Promise<void>;
    stopUsingPortfolioSnapshot(): Promise<void>;
    requestPortfolioPurge(scope: PortfolioPurgeScope): void;
    cancelPortfolioPurge(): void;
    confirmPortfolioPurge(): Promise<void>;
  };
}

export function useMarketAgentWorkspace(): MarketAgentWorkspace {
  const [runs, setRuns] = useState<AgentRunView[]>([]);
  const [profile, setProfile] = useState<AgentProfileView | null>(null);
  const [localWatchlist, setLocalWatchlist] = useState<AgentWatchlistItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [setupNote, setSetupNote] = useState<string | null>(null);
  const [activeEvidenceId, setActiveEvidenceId] = useState<string | null>(null);
  const [deletingRunId, setDeletingRunId] = useState<string | null>(null);
  const [portfolioPreview, setPortfolioPreview] =
    useState<LocalPortfolioSnapshotPreview | null>(null);
  const [portfolioState, setPortfolioState] =
    useState<PortfolioSnapshotControlState | null>(null);
  const [portfolioStateLoaded, setPortfolioStateLoaded] = useState(false);
  const [portfolioBusy, setPortfolioBusy] = useState(false);
  const [portfolioError, setPortfolioError] = useState<string | null>(null);
  const [portfolioNote, setPortfolioNote] = useState<string | null>(null);
  const [purgeScope, setPurgeScope] = useState<PortfolioPurgeScope | null>(null);

  const refreshPortfolioPreview = useCallback(() => {
    const preview = previewLocalPortfolioSnapshot(
      new LocalPortfolioRepository(window.localStorage),
    );
    setPortfolioPreview(preview);
    return preview;
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [nextRuns, nextProfile] = await Promise.all([
        getAgentRuns(),
        getAgentProfile(),
      ]);
      setRuns(nextRuns);
      setProfile(nextProfile);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Agent 暂不可用");
    } finally {
      setLoading(false);
    }

    try {
      setPortfolioState(await getPortfolioSnapshotControlState());
      setPortfolioError(null);
    } catch (cause) {
      setPortfolioState(null);
      setPortfolioError(
        cause instanceof Error ? cause.message : "持仓快照状态暂不可用",
      );
    } finally {
      setPortfolioStateLoaded(true);
    }
  }, []);

  useEffect(() => {
    setLocalWatchlist(
      loadMarketWatchlist(window.localStorage).map(
        ({ instrumentId, reason }) => ({ instrumentId, reason }),
      ),
    );
    refreshPortfolioPreview();
    void refresh();
  }, [refresh, refreshPortfolioPreview]);

  const syncLocalPortfolioSnapshot = useCallback(async () => {
    const preview = refreshPortfolioPreview();
    if (!preview.upload) {
      setPortfolioError(preview.issues[0] ?? "本机持仓快照尚不能同步。");
      return;
    }
    setPortfolioBusy(true);
    try {
      const nextState = await syncPortfolioSnapshot(preview.upload);
      setPortfolioState(nextState);
      setPortfolioError(null);
      setPortfolioNote(
        `已同步 ${preview.positionCount} 个持仓；将在 ${formatDate(preview.upload.expiresAt)} 后自动失效。`,
      );
    } catch (cause) {
      setPortfolioError(
        cause instanceof Error ? cause.message : "持仓快照同步失败",
      );
    } finally {
      setPortfolioBusy(false);
    }
  }, [refreshPortfolioPreview]);

  const stopUsingPortfolioSnapshot = useCallback(async () => {
    const snapshot = portfolioState?.snapshot;
    if (!snapshot) return;
    setPortfolioBusy(true);
    try {
      const nextState = await stopPortfolioSnapshot(snapshot.id);
      setPortfolioState(nextState);
      setRuns(await getAgentRuns());
      setPortfolioError(null);
      setPortfolioNote(
        nextState.detachedRunCount
          ? `已停止后续使用，并将 ${nextState.detachedRunCount} 个排队 Run 切回仅市场模式。`
          : "已停止后续使用；后续 Run 将保持仅市场模式。",
      );
    } catch (cause) {
      setPortfolioError(
        cause instanceof Error ? cause.message : "停止使用持仓快照失败",
      );
    } finally {
      setPortfolioBusy(false);
    }
  }, [portfolioState?.snapshot]);

  const confirmPortfolioPurge = useCallback(async () => {
    if (!purgeScope) return;
    setPortfolioBusy(true);
    try {
      const nextState = await purgePortfolioSnapshotHistory(purgeScope);
      setPortfolioState(nextState);
      setRuns(await getAgentRuns());
      setPortfolioError(null);
      setPortfolioNote(
        `已清除 ${nextState.snapshots} 份快照及 ${nextState.runs} 条关联 Run；审计墓碑已保留。`,
      );
      setPurgeScope(null);
    } catch (cause) {
      setPortfolioError(
        cause instanceof Error ? cause.message : "清除持仓快照历史失败",
      );
    } finally {
      setPortfolioBusy(false);
    }
  }, [purgeScope]);

  const confirmWatchlist = useCallback(async () => {
    if (!localWatchlist.length) {
      setError("Market Center 中没有可同步的观察标的。");
      return;
    }
    setSyncBusy(true);
    try {
      const revision = `browser:${Date.now().toString(36)}`;
      const result = await syncAgentWatchlist(revision, localWatchlist);
      setProfile(result.profile);
      setSetupNote(
        `已确认 ${result.watchlist.items.length} 个标的，revision ${result.watchlist.revision}`,
      );
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "观察列表同步失败");
    } finally {
      setSyncBusy(false);
    }
  }, [localWatchlist]);

  const runReview = useCallback(async () => {
    if (profile?.bootstrap === "required") {
      setError("请先确认并同步观察列表。");
      return;
    }
    setReviewBusy(true);
    try {
      await startCloseReview();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "复盘启动失败");
    } finally {
      setReviewBusy(false);
    }
  }, [profile?.bootstrap, refresh]);

  const downloadRuns = useCallback(async () => {
    try {
      const exported = await exportAgentRuns();
      const blob = new Blob([JSON.stringify(exported, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `market-agent-runs-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "记录导出失败");
    }
  }, []);

  const removeRun = useCallback(async (run: AgentRunView) => {
    if (!window.confirm(`删除 ${formatDate(run.createdAt)} 的复盘记录及其 Evidence？此操作无法恢复。`)) {
      return;
    }
    setDeletingRunId(run.id);
    try {
      await deleteAgentRun(run.id);
      setRuns((current) => current.filter((item) => item.id !== run.id));
      if (activeEvidenceId === run.id) setActiveEvidenceId(null);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "记录删除失败");
    } finally {
      setDeletingRunId(null);
    }
  }, [activeEvidenceId]);

  const saveFeedback = useCallback(async (
    runId: string,
    value: RunFeedback,
  ) => {
    try {
      await sendRunFeedback(runId, value);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "反馈未保存");
    }
  }, []);

  const updateRun = useCallback((run: AgentRunView) => {
    setRuns((current) => {
      const index = current.findIndex((item) => item.id === run.id);
      if (index < 0) return [run, ...current];
      const existing = current[index];
      if (
        existing.status === run.status
        && existing.updatedAt === run.updatedAt
        && existing.evidenceFingerprint === run.evidenceFingerprint
      ) {
        return current;
      }
      return current.map((item) => item.id === run.id ? run : item);
    });
  }, []);

  const toggleEvidence = useCallback((evidenceId: string) => {
    setActiveEvidenceId((current) => current === evidenceId ? null : evidenceId);
  }, []);

  const latest = runs[0];
  const events = useMemo(() => latest?.result?.observations ?? [], [latest]);
  const askInstruments = useMemo(
    () => [...new Set([
      ...localWatchlist.map((item) => item.instrumentId),
      ...(portfolioState?.snapshot?.positions.map((item) => item.instrumentId) ?? []),
    ])].sort(),
    [localWatchlist, portfolioState?.snapshot?.positions],
  );

  return {
    agent: {
      runs,
      latest,
      events,
      askInstruments,
      bootstrap: profile?.bootstrap ?? null,
      loading,
      reviewBusy,
      error,
      setupNote,
      deletingRunId,
      activeEvidenceId,
    },
    watchlist: {
      items: localWatchlist,
      syncing: syncBusy,
    },
    portfolio: {
      preview: portfolioPreview,
      state: portfolioState,
      stateLoaded: portfolioStateLoaded,
      busy: portfolioBusy,
      error: portfolioError,
      note: portfolioNote,
      purgeScope,
    },
    commands: {
      refresh,
      runReview,
      confirmWatchlist,
      downloadRuns,
      removeRun,
      saveFeedback,
      updateRun,
      toggleEvidence,
      refreshPortfolioPreview,
      syncLocalPortfolioSnapshot,
      stopUsingPortfolioSnapshot,
      requestPortfolioPurge: setPurgeScope,
      cancelPortfolioPurge: () => setPurgeScope(null),
      confirmPortfolioPurge,
    },
  };
}

function formatDate(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
