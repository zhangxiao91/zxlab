import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentFeedback, AgentFeedbackValue } from "@zxlab/market-agent-schema";
import { loadMarketWatchlist } from "../market/watchlist";
import { LocalPortfolioRepository } from "../risk/ledger";
import {
  deleteAgentRun,
  exportAgentRuns,
  getAgentProfile,
  getAgentRunPage,
  getPortfolioSnapshotControlState,
  marketAgentAccessRequired,
  pollAgentRunUntilTerminal,
  purgePortfolioSnapshotHistory,
  sendRunFeedback,
  startCloseReview,
  streamAgentRun,
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
import {
  completePortfolioWrite,
  portfolioRecheckNotice,
  type PortfolioAction,
} from "./action-state";
import {
  enqueueRunFeedback,
  mergeRunPageWithCurrentFeedback,
  mergeRunWithCurrentFeedback,
} from "./run-state";

export interface MarketAgentWorkspace {
  agent: {
    runs: AgentRunView[];
    latest: AgentRunView | undefined;
    events: AgentObservationView[];
    askInstruments: string[];
    bootstrap: AgentProfileView["bootstrap"] | null;
    loading: boolean;
    reviewBusy: boolean;
    streamingAnswer: string;
    error: string | null;
    accessRequired: boolean;
    setupNote: string | null;
    deletingRunId: string | null;
    loadingMoreRuns: boolean;
    hasMoreRuns: boolean;
    activeEvidenceId: string | null;
    exportBusy: boolean;
    exportNote: string | null;
    exportError: string | null;
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
    action: PortfolioAction | null;
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
    loadMoreRuns(): Promise<void>;
    saveFeedback(runId: string, value: AgentFeedbackValue): Promise<AgentFeedback>;
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
  const [streamingAnswers, setStreamingAnswers] = useState<Record<string, string>>({});
  const [syncBusy, setSyncBusy] = useState(false);
  const [agentIssue, setAgentIssue] = useState<{
    message: string;
    accessRequired: boolean;
  } | null>(null);
  const [setupNote, setSetupNote] = useState<string | null>(null);
  const [activeEvidenceId, setActiveEvidenceId] = useState<string | null>(null);
  const [deletingRunId, setDeletingRunId] = useState<string | null>(null);
  const [nextRunsCursor, setNextRunsCursor] = useState<string | null>(null);
  const [loadingMoreRuns, setLoadingMoreRuns] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [portfolioPreview, setPortfolioPreview] =
    useState<LocalPortfolioSnapshotPreview | null>(null);
  const [portfolioState, setPortfolioState] =
    useState<PortfolioSnapshotControlState | null>(null);
  const [portfolioStateLoaded, setPortfolioStateLoaded] = useState(false);
  const [portfolioAction, setPortfolioAction] = useState<PortfolioAction | null>(null);
  const [portfolioError, setPortfolioError] = useState<string | null>(null);
  const [portfolioNote, setPortfolioNote] = useState<string | null>(null);
  const [purgeScope, setPurgeScope] = useState<PortfolioPurgeScope | null>(null);
  const activeStreams = useRef(new Map<string, AbortController>());
  const feedbackQueues = useRef(new Map<string, Promise<AgentFeedback>>());

  const clearAgentIssue = useCallback(() => setAgentIssue(null), []);
  const reportAgentIssue = useCallback((cause: unknown, fallback: string) => {
    setAgentIssue({
      message: cause instanceof Error ? cause.message : fallback,
      accessRequired: marketAgentAccessRequired(cause),
    });
  }, []);
  const reportLocalIssue = useCallback((message: string) => {
    setAgentIssue({ message, accessRequired: false });
  }, []);

  const updateRun = useCallback((run: AgentRunView) => {
    setRuns((current) => {
      const index = current.findIndex((item) => item.id === run.id);
      if (index < 0) return [run, ...current];
      const existing = current[index];
      const next = mergeRunWithCurrentFeedback(existing, run);
      if (
        existing.status === next.status
        && existing.updatedAt === next.updatedAt
        && existing.evidenceFingerprint === next.evidenceFingerprint
        && existing.feedback?.value === next.feedback?.value
        && existing.feedback?.updatedAt === next.feedback?.updatedAt
      ) {
        return current;
      }
      return current.map((item) => item.id === next.id ? next : item);
    });
  }, []);

  const clearStreamingAnswer = useCallback((runId: string) => {
    setStreamingAnswers((current) => {
      if (!(runId in current)) return current;
      const next = { ...current };
      delete next[runId];
      return next;
    });
  }, []);

  const followRun = useCallback(async (runId: string) => {
    if (activeStreams.current.has(runId)) return;
    const controller = new AbortController();
    activeStreams.current.set(runId, controller);
    setStreamingAnswers((current) => ({ ...current, [runId]: "" }));
    try {
      await streamAgentRun(runId, {
        onStatus: updateRun,
        onAnswerDelta: (delta) => {
          setStreamingAnswers((current) => ({
            ...current,
            [runId]: `${current[runId] ?? ""}${delta}`,
          }));
        },
        onDone: (run) => {
          updateRun(run);
          clearStreamingAnswer(runId);
        },
      }, { signal: controller.signal });
      clearAgentIssue();
    } catch (cause) {
      if (controller.signal.aborted) return;
      try {
        const run = await pollAgentRunUntilTerminal(runId, updateRun, controller.signal);
        updateRun(run);
        clearStreamingAnswer(runId);
        clearAgentIssue();
      } catch (fallbackCause) {
        if (!controller.signal.aborted) {
          reportAgentIssue(
            fallbackCause instanceof Error ? fallbackCause : cause,
            "Agent 运行状态暂不可用",
          );
        }
      }
    } finally {
      activeStreams.current.delete(runId);
    }
  }, [clearAgentIssue, clearStreamingAnswer, reportAgentIssue, updateRun]);

  const refreshPortfolioPreview = useCallback(() => {
    const preview = previewLocalPortfolioSnapshot(
      new LocalPortfolioRepository(window.localStorage),
    );
    setPortfolioPreview(preview);
    return preview;
  }, []);

  const recheckPortfolioPreview = useCallback(() => {
    const preview = refreshPortfolioPreview();
    const notice = portfolioRecheckNotice(
      preview.upload
        ? `本机快照包含 ${preview.positionCount} 个持仓，可用于同步。`
        : preview.issues[0] ?? "本机暂时没有可同步的持仓快照。",
    );
    setPortfolioError(notice.error);
    setPortfolioNote(notice.note);
    return preview;
  }, [refreshPortfolioPreview]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [runPage, nextProfile] = await Promise.all([
        getAgentRunPage(),
        getAgentProfile(),
      ]);
      setRuns((current) => mergeRunPageWithCurrentFeedback(current, runPage.runs));
      setNextRunsCursor(runPage.nextCursor);
      setProfile(nextProfile);
      clearAgentIssue();
    } catch (cause) {
      reportAgentIssue(cause, "Agent 暂不可用");
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
  }, [clearAgentIssue, reportAgentIssue]);

  const loadMoreRuns = useCallback(async () => {
    if (!nextRunsCursor || loadingMoreRuns) return;
    setLoadingMoreRuns(true);
    try {
      const page = await getAgentRunPage(nextRunsCursor);
      setRuns((current) => {
        const seen = new Set(current.map((run) => run.id));
        return [...current, ...page.runs.filter((run) => !seen.has(run.id))];
      });
      setNextRunsCursor(page.nextCursor);
      clearAgentIssue();
    } catch (cause) {
      reportAgentIssue(cause, "更早的运行记录暂不可用");
    } finally {
      setLoadingMoreRuns(false);
    }
  }, [clearAgentIssue, loadingMoreRuns, nextRunsCursor, reportAgentIssue]);

  useEffect(() => {
    setLocalWatchlist(
      loadMarketWatchlist(window.localStorage).map(
        ({ instrumentId, reason }) => ({ instrumentId, reason }),
      ),
    );
    refreshPortfolioPreview();
    void refresh();
  }, [refresh, refreshPortfolioPreview]);

  useEffect(() => {
    const activeRun = runs.find((run) => run.workflow !== "ask" && !["success", "partial", "failed"].includes(run.status));
    if (activeRun) void followRun(activeRun.id);
  }, [followRun, runs]);

  useEffect(() => () => {
    for (const controller of activeStreams.current.values()) controller.abort();
    activeStreams.current.clear();
  }, []);

  const syncLocalPortfolioSnapshot = useCallback(async () => {
    const preview = refreshPortfolioPreview();
    if (!preview.upload) {
      setPortfolioNote(null);
      setPortfolioError(preview.issues[0] ?? "本机持仓快照尚不能同步。");
      return;
    }
    setPortfolioAction("syncing");
    setPortfolioError(null);
    setPortfolioNote(null);
    try {
      const nextState = await syncPortfolioSnapshot(preview.upload);
      setPortfolioState(nextState);
      setPortfolioError(null);
      setPortfolioNote(
        `已同步 ${preview.positionCount} 个持仓；将在 ${formatDate(preview.upload.expiresAt)} 后自动失效。`,
      );
    } catch (cause) {
      setPortfolioNote(null);
      setPortfolioError(
        cause instanceof Error ? cause.message : "持仓快照同步失败",
      );
    } finally {
      setPortfolioAction(null);
    }
  }, [refreshPortfolioPreview]);

  const stopUsingPortfolioSnapshot = useCallback(async () => {
    const snapshot = portfolioState?.snapshot;
    if (!snapshot) return;
    setPortfolioAction("stopping");
    setPortfolioError(null);
    setPortfolioNote(null);
    try {
      const completion = await completePortfolioWrite(
        () => stopPortfolioSnapshot(snapshot.id),
        () => getAgentRunPage(),
        (nextState) => nextState.detachedRunCount
          ? `已停止后续使用，并将 ${nextState.detachedRunCount} 个排队 Run 切回仅市场模式。`
          : "已停止后续使用；后续 Run 将保持仅市场模式。",
      );
      setPortfolioState(completion.writeResult);
      const refreshed = completion.refreshResult;
      if (refreshed) {
        setRuns((current) => mergeRunPageWithCurrentFeedback(current, refreshed.runs));
        setNextRunsCursor(refreshed.nextCursor);
      }
      setPortfolioError(completion.notice.error);
      setPortfolioNote(completion.notice.note);
    } catch (cause) {
      setPortfolioNote(null);
      setPortfolioError(
        cause instanceof Error ? cause.message : "停止使用持仓快照失败",
      );
    } finally {
      setPortfolioAction(null);
    }
  }, [portfolioState?.snapshot]);

  const confirmPortfolioPurge = useCallback(async () => {
    if (!purgeScope) return;
    setPortfolioAction("purging");
    setPortfolioError(null);
    setPortfolioNote(null);
    try {
      const completion = await completePortfolioWrite(
        () => purgePortfolioSnapshotHistory(purgeScope),
        () => getAgentRunPage(),
        (nextState) => `已清除 ${nextState.snapshots} 份快照及 ${nextState.runs} 条关联 Run；审计墓碑已保留。`,
      );
      setPortfolioState(completion.writeResult);
      const refreshed = completion.refreshResult;
      if (refreshed) {
        setRuns((current) => mergeRunPageWithCurrentFeedback(current, refreshed.runs));
        setNextRunsCursor(refreshed.nextCursor);
      }
      setPortfolioError(completion.notice.error);
      setPortfolioNote(completion.notice.note);
      setPurgeScope(null);
    } catch (cause) {
      setPortfolioNote(null);
      setPortfolioError(
        cause instanceof Error ? cause.message : "清除持仓快照历史失败",
      );
    } finally {
      setPortfolioAction(null);
    }
  }, [purgeScope]);

  const confirmWatchlist = useCallback(async () => {
    if (!localWatchlist.length) {
      reportLocalIssue("Market Center 中没有可同步的观察标的。");
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
      clearAgentIssue();
    } catch (cause) {
      reportAgentIssue(cause, "观察列表同步失败");
    } finally {
      setSyncBusy(false);
    }
  }, [clearAgentIssue, localWatchlist, reportAgentIssue, reportLocalIssue]);

  const runReview = useCallback(async () => {
    if (profile?.bootstrap === "required") {
      reportLocalIssue("请先确认并同步观察列表。");
      return;
    }
    setReviewBusy(true);
    try {
      const started = await startCloseReview();
      const now = new Date().toISOString();
      updateRun({
        id: started.runId,
        workflow: "close_review",
        status: started.status,
        createdAt: now,
        updatedAt: now,
        evidenceFingerprint: null,
      });
      clearAgentIssue();
    } catch (cause) {
      reportAgentIssue(cause, "复盘启动失败");
    } finally {
      setReviewBusy(false);
    }
  }, [clearAgentIssue, profile?.bootstrap, reportAgentIssue, reportLocalIssue, updateRun]);

  const downloadRuns = useCallback(async () => {
    if (exportBusy) return;
    setExportBusy(true);
    setExportNote("正在准备运行记录导出文件。");
    setExportError(null);
    try {
      const exported = await exportAgentRuns();
      const url = URL.createObjectURL(exported);
      const link = document.createElement("a");
      link.href = url;
      link.download = `market-agent-runs-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setExportNote("导出文件已准备并开始下载。");
    } catch (cause) {
      setExportNote(null);
      setExportError(cause instanceof Error ? cause.message : "记录导出失败");
    } finally {
      setExportBusy(false);
    }
  }, [exportBusy]);

  const removeRun = useCallback(async (run: AgentRunView) => {
    if (!window.confirm(`清除 ${formatDate(run.createdAt)} 的复盘正文及 Evidence？审计 fingerprint 与 tombstone 会保留，此操作无法恢复。`)) {
      return;
    }
    setDeletingRunId(run.id);
    try {
      const tombstone = await deleteAgentRun(run.id);
      setRuns((current) => current.map((item) => item.id === run.id ? {
        ...item,
        result: undefined,
        feedback: null,
        payloadPurgedAt: tombstone.purgedAt,
      } : item));
      if (activeEvidenceId === run.id) setActiveEvidenceId(null);
      clearAgentIssue();
    } catch (cause) {
      reportAgentIssue(cause, "记录删除失败");
    } finally {
      setDeletingRunId(null);
    }
  }, [activeEvidenceId, clearAgentIssue, reportAgentIssue]);

  const saveFeedback = useCallback((
    runId: string,
    value: AgentFeedbackValue,
  ) => {
    return enqueueRunFeedback(feedbackQueues.current, runId, async () => {
      try {
        const feedback = await sendRunFeedback(runId, value);
        setRuns((current) => current.map((run) => (
          run.id === runId
            ? mergeRunWithCurrentFeedback(run, { ...run, feedback })
            : run
        )));
        clearAgentIssue();
        return feedback;
      } catch (cause) {
        if (marketAgentAccessRequired(cause)) {
          reportAgentIssue(cause, "需要重新授权。");
        } else {
          clearAgentIssue();
        }
        throw cause;
      }
    });
  }, [clearAgentIssue, reportAgentIssue]);

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
      streamingAnswer: latest ? streamingAnswers[latest.id] ?? "" : "",
      error: agentIssue?.message ?? null,
      accessRequired: agentIssue?.accessRequired ?? false,
      setupNote,
      deletingRunId,
      loadingMoreRuns,
      hasMoreRuns: Boolean(nextRunsCursor),
      activeEvidenceId,
      exportBusy,
      exportNote,
      exportError,
    },
    watchlist: {
      items: localWatchlist,
      syncing: syncBusy,
    },
    portfolio: {
      preview: portfolioPreview,
      state: portfolioState,
      stateLoaded: portfolioStateLoaded,
      busy: portfolioAction !== null,
      action: portfolioAction,
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
      loadMoreRuns,
      saveFeedback,
      updateRun,
      toggleEvidence,
      refreshPortfolioPreview: recheckPortfolioPreview,
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
