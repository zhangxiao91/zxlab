import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isCancellableRunStatus, type AgentFeedback, type AgentFeedbackValue, type RunTrace, type RunTraceEvent, type SealedEvidenceBundle, type ToolTrace, type ToolTraceEvent } from "@zxlab/market-agent-schema";
import { loadMarketWatchlist } from "../market/watchlist";
import { LocalPortfolioRepository } from "../risk/ledger";
import {
  deleteAgentRun,
  cancelAgentRun,
  exportAgentRuns,
  getAgentProfile,
  getAgentRun,
  getAgentRunEvidence,
  getAgentRunPage,
  getAgentRunTrace,
  getAgentToolTrace,
  getPortfolioSnapshotControlState,
  marketAgentAccessRequired,
  pollAgentRunUntilTerminal,
  purgePortfolioSnapshotHistory,
  retryAgentRun,
  sendRunFeedback,
  startAgentAsk,
  startCloseReview,
  streamAgentRun,
  stopPortfolioSnapshot,
  syncAgentWatchlist,
  syncPortfolioSnapshot,
  type AgentObservationView,
  type AgentAskIntent,
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
  mergeRunPagePreservingSelection,
  mergeRunWithCurrentFeedback,
  clearRetryKeyForRun,
  mergeRunTraceEvents,
  mergeToolTraceEvents,
  retryKeyForRun,
  evidenceSelectionAfterRunSelection,
  resolveSelectedRun,
} from "./run-state";

export interface MarketAgentWorkspace {
  agent: {
    runs: AgentRunView[];
    latest: AgentRunView | undefined;
    selectedRunId: string | null;
    selectedRun: AgentRunView | undefined;
    events: AgentObservationView[];
    askInstruments: string[];
    bootstrap: AgentProfileView["bootstrap"] | null;
    loading: boolean;
    reviewBusy: boolean;
    askBusy: boolean;
    streamingAnswer: string;
    error: string | null;
    accessRequired: boolean;
    setupNote: string | null;
    deletingRunId: string | null;
    loadingMoreRuns: boolean;
    hasMoreRuns: boolean;
    evidence: SealedEvidenceBundle | null;
    evidenceLoading: boolean;
    evidenceError: string | null;
    selectedEvidenceId: string | null;
    exportBusy: boolean;
    exportNote: string | null;
    exportError: string | null;
    trace: RunTrace | null;
    traceLoading: boolean;
    traceError: string | null;
    toolTrace: ToolTrace | null;
    toolTraceLoading: boolean;
    toolTraceError: string | null;
    runControlBusy: { runId: string; action: "cancel" | "retry" } | null;
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
    runReview(): Promise<string | null>;
    submitAsk(intent: AgentAskIntent): Promise<string>;
    selectRun(runId: string): Promise<void>;
    selectEvidence(evidenceId: string | null): void;
    confirmWatchlist(): Promise<void>;
    downloadRuns(): Promise<void>;
    removeRun(run: AgentRunView): Promise<void>;
    loadMoreRuns(): Promise<void>;
    saveFeedback(runId: string, value: AgentFeedbackValue): Promise<AgentFeedback>;
    cancelRun(runId: string): Promise<void>;
    retryRun(runId: string): Promise<string>;
    updateRun(run: AgentRunView): void;
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
  const [askBusy, setAskBusy] = useState(false);
  const [streamingAnswers, setStreamingAnswers] = useState<Record<string, string>>({});
  const [syncBusy, setSyncBusy] = useState(false);
  const [agentIssue, setAgentIssue] = useState<{
    message: string;
    accessRequired: boolean;
  } | null>(null);
  const [setupNote, setSetupNote] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [evidenceByRunId, setEvidenceByRunId] = useState<Record<string, SealedEvidenceBundle>>({});
  const [evidenceLoadingRunId, setEvidenceLoadingRunId] = useState<string | null>(null);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string | null>(null);
  const [deletingRunId, setDeletingRunId] = useState<string | null>(null);
  const [nextRunsCursor, setNextRunsCursor] = useState<string | null>(null);
  const [loadingMoreRuns, setLoadingMoreRuns] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [traceByRunId, setTraceByRunId] = useState<Record<string, RunTrace>>({});
  const [streamedTraceByRunId, setStreamedTraceByRunId] = useState<Record<string, RunTraceEvent[]>>({});
  const [traceLoadingRunId, setTraceLoadingRunId] = useState<string | null>(null);
  const [traceError, setTraceError] = useState<string | null>(null);
  const [toolTraceByRunId, setToolTraceByRunId] = useState<Record<string, ToolTrace>>({});
  const [streamedToolTraceByRunId, setStreamedToolTraceByRunId] = useState<Record<string, ToolTraceEvent[]>>({});
  const [toolTraceLoadingRunId, setToolTraceLoadingRunId] = useState<string | null>(null);
  const [toolTraceError, setToolTraceError] = useState<string | null>(null);
  const [runControlBusy, setRunControlBusy] = useState<{ runId: string; action: "cancel" | "retry" } | null>(null);
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
  const runControlLock = useRef<{ runId: string; action: "cancel" | "retry" } | null>(null);
  const retryKeysBySource = useRef(new Map<string, string>());
  const runsRef = useRef<AgentRunView[]>([]);
  const selectedRunIdRef = useRef<string | null>(null);
  const latest = runs[0];
  const selectedRun = useMemo(
    () => resolveSelectedRun(runs, selectedRunId),
    [runs, selectedRunId],
  );

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
        && existing.timing?.serverNow === next.timing?.serverNow
        && existing.timing?.elapsedMs === next.timing?.elapsedMs
        && existing.timing?.durationMs === next.timing?.durationMs
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
        onTrace: (event) => {
          setStreamedTraceByRunId((current) => {
            try {
              return {
                ...current,
                [event.runId]: mergeRunTraceEvents(current[event.runId] ?? [], [event]),
              };
            } catch {
              return current;
            }
          });
        },
        onToolTrace: (event) => {
          setStreamedToolTraceByRunId((current) => {
            try {
              return {
                ...current,
                [event.runId]: mergeToolTraceEvents(current[event.runId] ?? [], [event]),
              };
            } catch {
              return current;
            }
          });
        },
        onAnswerDelta: (delta) => {
          setStreamingAnswers((current) => ({
            ...current,
            [runId]: `${current[runId] ?? ""}${delta}`,
          }));
        },
        onDone: (run) => {
          updateRun(run);
          clearStreamingAnswer(runId);
          void getAgentRunTrace(runId).then((trace) => {
            setTraceByRunId((current) => ({ ...current, [runId]: trace }));
          }).catch(() => undefined);
          void getAgentToolTrace(runId).then((trace) => {
            setToolTraceByRunId((current) => ({ ...current, [runId]: trace }));
          }).catch(() => undefined);
        },
      }, { signal: controller.signal });
      clearAgentIssue();
    } catch (cause) {
      if (controller.signal.aborted) return;
      try {
        const run = await pollAgentRunUntilTerminal(runId, updateRun, controller.signal);
        updateRun(run);
        clearStreamingAnswer(runId);
        const [trace, toolTrace] = await Promise.allSettled([
          getAgentRunTrace(runId),
          getAgentToolTrace(runId),
        ]);
        if (trace.status === "fulfilled") setTraceByRunId((current) => ({ ...current, [runId]: trace.value }));
        if (toolTrace.status === "fulfilled") setToolTraceByRunId((current) => ({ ...current, [runId]: toolTrace.value }));
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
      setRuns((current) => mergeRunPagePreservingSelection(current, runPage.runs, selectedRunIdRef.current));
      setSelectedRunId((current) => current ?? runPage.runs[0]?.id ?? null);
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
    runsRef.current = runs;
  }, [runs]);

  useEffect(() => {
    selectedRunIdRef.current = selectedRunId;
  }, [selectedRunId]);

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
    for (const activeRun of runs.filter((run) => isCancellableRunStatus(run.status))) {
      void followRun(activeRun.id);
    }
  }, [followRun, runs]);

  useEffect(() => {
    setSelectedEvidenceId(null);
    setEvidenceError(null);
    setTraceError(null);
    setToolTraceError(null);
  }, [selectedRun?.id]);

  useEffect(() => {
    if (!selectedRun?.id) return;
    const controller = new AbortController();
    setToolTraceLoadingRunId(selectedRun.id);
    setToolTraceError(null);
    void getAgentToolTrace(selectedRun.id, controller.signal)
      .then((trace) => {
        setToolTraceByRunId((current) => ({ ...current, [trace.runId]: trace }));
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setToolTraceError(cause instanceof Error ? cause.message : "无法读取服务器工具事件");
      })
      .finally(() => {
        if (!controller.signal.aborted) setToolTraceLoadingRunId((current) => current === selectedRun.id ? null : current);
      });
    return () => controller.abort();
  }, [selectedRun?.id]);

  useEffect(() => {
    if (!selectedRun?.id) return;
    const controller = new AbortController();
    setTraceLoadingRunId(selectedRun.id);
    setTraceError(null);
    void getAgentRunTrace(selectedRun.id, controller.signal)
      .then((trace) => {
        setTraceByRunId((current) => ({ ...current, [trace.runId]: trace }));
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setTraceError(cause instanceof Error ? cause.message : "无法读取服务器运行事件");
      })
      .finally(() => {
        if (!controller.signal.aborted) setTraceLoadingRunId((current) => current === selectedRun.id ? null : current);
      });
    return () => controller.abort();
  }, [selectedRun?.id]);

  useEffect(() => {
    if (!selectedRun?.evidenceFingerprint || !["success", "partial"].includes(selectedRun.status)) return;
    if (evidenceByRunId[selectedRun.id]) return;
    let cancelled = false;
    setEvidenceLoadingRunId(selectedRun.id);
    setEvidenceError(null);
    void getAgentRunEvidence(selectedRun.id)
      .then((evidence) => {
        if (!cancelled) setEvidenceByRunId((current) => ({ ...current, [selectedRun.id]: evidence }));
      })
      .catch((cause) => {
        if (!cancelled) setEvidenceError(cause instanceof Error ? cause.message : "无法读取已封存 Evidence");
      })
      .finally(() => {
        if (!cancelled) setEvidenceLoadingRunId((current) => current === selectedRun.id ? null : current);
      });
    return () => { cancelled = true; };
  }, [evidenceByRunId, selectedRun?.evidenceFingerprint, selectedRun?.id, selectedRun?.status]);

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
        setRuns((current) => mergeRunPagePreservingSelection(current, refreshed.runs, selectedRunIdRef.current));
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
        setRuns((current) => mergeRunPagePreservingSelection(current, refreshed.runs, selectedRunIdRef.current));
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
      return null;
    }
    setReviewBusy(true);
    try {
      const started = await startCloseReview();
      const now = new Date().toISOString();
      const run: AgentRunView = {
        id: started.runId,
        workflow: "close_review",
        trigger: "manual",
        input: { workflow: "close_review" },
        status: started.status,
        createdAt: now,
        updatedAt: now,
        evidenceFingerprint: null,
      };
      updateRun(run);
      selectedRunIdRef.current = run.id;
      setSelectedRunId(run.id);
      clearAgentIssue();
      return run.id;
    } catch (cause) {
      reportAgentIssue(cause, "复盘启动失败");
      return null;
    } finally {
      setReviewBusy(false);
    }
  }, [clearAgentIssue, profile?.bootstrap, reportAgentIssue, reportLocalIssue, updateRun]);

  const submitAsk = useCallback(async (intent: AgentAskIntent) => {
    setAskBusy(true);
    try {
      const started = await startAgentAsk(intent);
      const now = new Date().toISOString();
      const run: AgentRunView = {
        id: started.runId,
        workflow: "ask",
        trigger: "manual",
        input: {
          workflow: "ask",
          askScope: intent.scope,
          ...(intent.instrumentId?.trim() ? { instrumentId: intent.instrumentId.trim().toUpperCase() } : {}),
          ...(intent.question?.trim() ? { question: intent.question.trim() } : {}),
          ...(intent.priorRunId?.trim() ? { priorRunId: intent.priorRunId.trim() } : {}),
        },
        status: started.status,
        createdAt: now,
        updatedAt: now,
        evidenceFingerprint: null,
      };
      updateRun(run);
      selectedRunIdRef.current = run.id;
      setSelectedRunId(run.id);
      clearAgentIssue();
      return run.id;
    } catch (cause) {
      reportAgentIssue(cause, "受限问答启动失败");
      throw cause;
    } finally {
      setAskBusy(false);
    }
  }, [clearAgentIssue, reportAgentIssue, updateRun]);

  const selectRun = useCallback(async (runId: string) => {
    setSelectedEvidenceId((current) => evidenceSelectionAfterRunSelection(
      selectedRunIdRef.current,
      runId,
      current,
    ));
    selectedRunIdRef.current = runId;
    setSelectedRunId(runId);
    if (runsRef.current.some((run) => run.id === runId)) return;
    try {
      const run = await getAgentRun(runId);
      updateRun(run);
      clearAgentIssue();
    } catch (cause) {
      const fallbackRunId = runsRef.current[0]?.id ?? null;
      setSelectedRunId((current) => {
        if (current !== runId) return current;
        selectedRunIdRef.current = fallbackRunId;
        return fallbackRunId;
      });
      reportAgentIssue(cause, "这条运行记录暂不可用");
    }
  }, [clearAgentIssue, reportAgentIssue, updateRun]);

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
        input: null,
        result: undefined,
        feedback: null,
        payloadPurgedAt: tombstone.purgedAt,
      } : item));
      setEvidenceByRunId((current) => {
        if (!(run.id in current)) return current;
        const next = { ...current };
        delete next[run.id];
        return next;
      });
      if (selectedRunId === run.id) setSelectedEvidenceId(null);
      clearAgentIssue();
    } catch (cause) {
      reportAgentIssue(cause, "记录删除失败");
    } finally {
      setDeletingRunId(null);
    }
  }, [clearAgentIssue, reportAgentIssue, selectedRunId]);

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

  const cancelRun = useCallback(async (runId: string) => {
    if (runControlLock.current) {
      reportLocalIssue("另一条 Run 控制操作尚未完成。");
      return;
    }
    const lock = { runId, action: "cancel" as const };
    runControlLock.current = lock;
    setRunControlBusy(lock);
    try {
      const result = await cancelAgentRun(runId);
      const run = result.run ?? await getAgentRun(result.runId);
      updateRun(run);
      activeStreams.current.get(runId)?.abort();
      clearStreamingAnswer(runId);
      try {
        const trace = await getAgentRunTrace(runId);
        setTraceByRunId((current) => ({ ...current, [runId]: trace }));
      } catch {
        // The terminal Run state remains authoritative if a trace refresh is temporarily unavailable.
      }
      clearAgentIssue();
    } catch (cause) {
      reportAgentIssue(cause, "取消 Run 失败");
      throw cause;
    } finally {
      runControlLock.current = null;
      setRunControlBusy(null);
    }
  }, [clearAgentIssue, clearStreamingAnswer, reportAgentIssue, reportLocalIssue, updateRun]);

  const retryRun = useCallback(async (runId: string) => {
    if (runControlLock.current) {
      reportLocalIssue("另一条 Run 控制操作尚未完成。");
      throw new Error("已有 Run 控制操作正在进行。");
    }
    const lock = { runId, action: "retry" as const };
    runControlLock.current = lock;
    setRunControlBusy(lock);
    const idempotencyKey = retryKeyForRun(retryKeysBySource.current, runId, undefined, window.sessionStorage);
    try {
      const result = await retryAgentRun(runId, idempotencyKey);
      const run = result.run ?? await getAgentRun(result.runId);
      updateRun(run);
      selectedRunIdRef.current = run.id;
      setSelectedRunId(run.id);
      setSelectedEvidenceId(null);
      clearRetryKeyForRun(retryKeysBySource.current, runId, window.sessionStorage);
      clearAgentIssue();
      return run.id;
    } catch (cause) {
      reportAgentIssue(cause, "重试 Run 失败");
      throw cause;
    } finally {
      runControlLock.current = null;
      setRunControlBusy(null);
    }
  }, [clearAgentIssue, reportAgentIssue, reportLocalIssue, updateRun]);

  const selectEvidence = useCallback((evidenceId: string | null) => {
    setSelectedEvidenceId(evidenceId);
  }, []);

  const events = useMemo(() => selectedRun?.result?.observations ?? [], [selectedRun]);
  const selectedTrace = useMemo(() => {
    if (!selectedRun) return null;
    const persisted = traceByRunId[selectedRun.id];
    const streamed = streamedTraceByRunId[selectedRun.id] ?? [];
    if (!persisted) {
      return selectedRun.timing && streamed.length
        ? { runId: selectedRun.id, timing: selectedRun.timing, events: streamed }
        : null;
    }
    return {
      ...persisted,
      timing: selectedRun.timing ?? persisted.timing,
      events: mergeRunTraceEvents(persisted.events, streamed),
    };
  }, [selectedRun, streamedTraceByRunId, traceByRunId]);
  const selectedToolTrace = useMemo(() => {
    if (!selectedRun) return null;
    const persisted = toolTraceByRunId[selectedRun.id];
    const streamed = streamedToolTraceByRunId[selectedRun.id] ?? [];
    if (!persisted) return streamed.length ? { runId: selectedRun.id, events: streamed } : null;
    return { ...persisted, events: mergeToolTraceEvents(persisted.events, streamed) };
  }, [selectedRun, streamedToolTraceByRunId, toolTraceByRunId]);
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
      selectedRunId: selectedRun?.id ?? null,
      selectedRun,
      events,
      askInstruments,
      bootstrap: profile?.bootstrap ?? null,
      loading,
      reviewBusy,
      askBusy,
      streamingAnswer: selectedRun ? streamingAnswers[selectedRun.id] ?? "" : "",
      error: agentIssue?.message ?? null,
      accessRequired: agentIssue?.accessRequired ?? false,
      setupNote,
      deletingRunId,
      loadingMoreRuns,
      hasMoreRuns: Boolean(nextRunsCursor),
      evidence: selectedRun ? evidenceByRunId[selectedRun.id] ?? null : null,
      evidenceLoading: Boolean(selectedRun && evidenceLoadingRunId === selectedRun.id),
      evidenceError,
      selectedEvidenceId,
      exportBusy,
      exportNote,
      exportError,
      trace: selectedTrace,
      traceLoading: Boolean(selectedRun && traceLoadingRunId === selectedRun.id),
      traceError,
      toolTrace: selectedToolTrace,
      toolTraceLoading: Boolean(selectedRun && toolTraceLoadingRunId === selectedRun.id),
      toolTraceError,
      runControlBusy,
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
      submitAsk,
      selectRun,
      selectEvidence,
      confirmWatchlist,
      downloadRuns,
      removeRun,
      loadMoreRuns,
      saveFeedback,
      cancelRun,
      retryRun,
      updateRun,
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
