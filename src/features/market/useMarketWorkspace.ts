import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { MarketSnapshotRequest } from "../../../packages/market-schema/src/index";
import { buildPositionsDetailed, LocalPortfolioRepository } from "../risk/ledger";
import { MarketClient } from "./client";
import type {
  MarketBar,
  MarketInterval,
  MarketProviderAttempt,
  MarketQuote,
  MarketWatchlistItem,
} from "./types";
import {
  emptyMarketWorkspaceState,
  marketBarSeriesKey,
  marketRequestCapabilityIds,
  marketSnapshotRequests,
  marketSnapshotFailureCapabilities,
  marketWorkspaceRefreshDecision,
  mergeMarketSnapshots,
  retainMarketWorkspaceAfterFailure,
  type MarketWorkspaceState,
} from "./workspace-policy";
import {
  defaultMarketWatchlist,
  loadMarketWatchlist,
  saveMarketWatchlist,
  toWatchlistItem,
} from "./watchlist";

const ACTIVE_SLOW_REFRESH_MS = 60_000;
const IDLE_SLOW_REFRESH_MS = 300_000;
const SNAPSHOT_REQUEST_CONCURRENCY = 3;

export type { MarketWorkspaceState } from "./workspace-policy";

interface MarketRefreshFlight {
  scopeKey: string;
  controller: AbortController;
  promise: Promise<void>;
}

export interface MarketWorkspace {
  state: MarketWorkspaceState;
  watchlist: MarketWatchlistItem[];
  selectedId: string;
  selectedQuote: MarketQuote | undefined;
  selectedBars: MarketBar[];
  draft: string;
  interval: MarketInterval;
  autoRefresh: boolean;
  pollIntervalMs: number;
  lastUpdatedAt: string | null;
  loading: boolean;
  error: string | null;
  holdingsWatchlist: MarketWatchlistItem[];
  setSelectedId: Dispatch<SetStateAction<string>>;
  setDraft: Dispatch<SetStateAction<string>>;
  setIntervalType: Dispatch<SetStateAction<MarketInterval>>;
  setAutoRefresh: Dispatch<SetStateAction<boolean>>;
  refresh(options?: { slow?: boolean }): Promise<void>;
  addInstrument(): void;
  addHoldings(): void;
  removeInstrument(instrumentId: string): void;
}

export function useMarketWorkspace(): MarketWorkspace {
  const storage = useMemo(
    () => (typeof window === "undefined" ? null : window.localStorage),
    [],
  );
  const client = useMemo(() => new MarketClient(), []);
  const [watchlist, setWatchlist] = useState<MarketWatchlistItem[]>(() =>
    storage ? loadMarketWatchlist(storage) : defaultMarketWatchlist(),
  );
  const [state, setState] = useState<MarketWorkspaceState>(emptyMarketWorkspaceState);
  const [selectedId, setSelectedId] = useState(
    watchlist[0]?.instrumentId ?? "",
  );
  const [draft, setDraft] = useState("");
  const [interval, setIntervalType] = useState<MarketInterval>("1m");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const coreFlightRef = useRef<MarketRefreshFlight | null>(null);
  const slowFlightRef = useRef<MarketRefreshFlight | null>(null);
  const scopeKeyRef = useRef("");
  const lastSlowRefreshAtRef = useRef(0);

  const ids = useMemo(
    () => watchlist.map((item) => item.instrumentId),
    [watchlist],
  );
  const idsKey = ids.join(",");
  const holdingsWatchlist = useMemo(() => {
    if (!storage) return [];
    const repository = new LocalPortfolioRepository(storage);
    return buildPositionsDetailed(
      repository.listTransactions(),
      repository.getInstruments(),
    ).positions.flatMap((position) => {
      const item = toWatchlistItem(
        position.instrumentId,
        "来自当前持仓",
        position.name,
      );
      return item ? [item] : [];
    });
  }, [storage, idsKey]);
  const selectedQuote = useMemo(
    () => state.quotes.find((item) => item.instrumentId === selectedId),
    [selectedId, state.quotes],
  );
  const selectedBars = useMemo(
    () => state.bars[marketBarSeriesKey(selectedId, interval)] ?? [],
    [interval, selectedId, state.bars],
  );
  const refreshDecision = marketWorkspaceRefreshDecision(state);
  const pollIntervalMs = refreshDecision.intervalMs;
  const activeId = ids.includes(selectedId) ? selectedId : ids[0];
  const scopeKey = `${idsKey}|${activeId ?? ""}|${interval}`;
  scopeKeyRef.current = scopeKey;

  const startSlowRefresh = useCallback((): Promise<void> => {
    if (!ids.length || !activeId) return Promise.resolve();
    const requestScopeKey = `${idsKey}|${activeId}|${interval}`;
    if (scopeKeyRef.current !== requestScopeKey) return Promise.resolve();
    const currentFlight = slowFlightRef.current;
    if (currentFlight?.scopeKey === requestScopeKey) return currentFlight.promise;
    currentFlight?.controller.abort();

    const controller = new AbortController();
    const requests = marketSnapshotRequests(ids, activeId, interval, true)
      .filter(isIntelSnapshotRequest);
    let promise: Promise<void>;
    const loadIntel = async () => {
      const results = await settleWithConcurrency(
        requests.map((request) => () => client.getSnapshot(request, controller.signal)),
        1,
      );
      if (slowFlightRef.current?.controller !== controller || controller.signal.aborted) return;
      const outcome = snapshotOutcome(requests, results);
      if (outcome.snapshots.length) lastSlowRefreshAtRef.current = Date.now();
      setState((current) => mergeMarketSnapshots(current, outcome.snapshots, {
        requestedCapabilityIds: outcome.requestedCapabilityIds,
        failedCapabilities: outcome.failedCapabilities,
        preserveUnrequestedCapabilities: true,
        preserveUnrequestedStatuses: true,
        snapshotWarnings: outcome.snapshotWarnings,
      }));
    };
    const loadProviders = async () => {
      try {
        const response = await client.getProviders(controller.signal);
        if (slowFlightRef.current?.controller !== controller || controller.signal.aborted) return;
        setState((current) => mergeMarketSnapshots(current, [], {
          providers: response.data,
          diagnosticWarnings: [],
        }));
      } catch (reason) {
        if (slowFlightRef.current?.controller !== controller || controller.signal.aborted) return;
        setState((current) => mergeMarketSnapshots(current, [], {
          diagnosticWarnings: [`Provider 诊断暂不可用：${errorMessage(reason)}`],
        }));
      }
    };
    promise = Promise.allSettled([loadIntel(), loadProviders()])
      .then(() => undefined)
      .finally(() => {
        if (slowFlightRef.current?.controller !== controller) return;
        slowFlightRef.current = null;
      });
    slowFlightRef.current = { scopeKey: requestScopeKey, controller, promise };
    return promise;
  }, [activeId, client, ids, idsKey, interval]);

  const refresh = useCallback(
    ({ slow = true }: { slow?: boolean } = {}): Promise<void> => {
      if (!ids.length) {
        coreFlightRef.current?.controller.abort();
        slowFlightRef.current?.controller.abort();
        coreFlightRef.current = null;
        slowFlightRef.current = null;
        setState(emptyMarketWorkspaceState());
        setLastUpdatedAt(null);
        setError(null);
        setLoading(false);
        return Promise.resolve();
      }

      const requestScopeKey = `${idsKey}|${activeId}|${interval}`;
      if (scopeKeyRef.current !== requestScopeKey) return Promise.resolve();
      if (slow) void startSlowRefresh();
      const currentFlight = coreFlightRef.current;
      if (currentFlight?.scopeKey === requestScopeKey) return currentFlight.promise;
      currentFlight?.controller.abort();

      const controller = new AbortController();
      const requests = marketSnapshotRequests(ids, activeId, interval, false);
      setLoading(true);
      setError(null);

      let promise: Promise<void>;
      promise = (async () => {
        const results = await settleWithConcurrency(
          requests.map((request) => () => client.getSnapshot(request, controller.signal)),
          SNAPSHOT_REQUEST_CONCURRENCY,
        );
        if (coreFlightRef.current?.controller !== controller || controller.signal.aborted) return;
        const outcome = snapshotOutcome(requests, results);

        if (!outcome.snapshots.length) {
          const message = outcome.snapshotWarnings.join("；") || "Market Snapshot 暂不可用";
          setState((current) => mergeMarketSnapshots(
            retainMarketWorkspaceAfterFailure(current, message),
            [],
            {
              requestedCapabilityIds: outcome.requestedCapabilityIds,
              failedCapabilities: outcome.failedCapabilities,
              snapshotWarnings: outcome.snapshotWarnings,
            },
          ));
          setError(message);
          return;
        }

        setState((current) => mergeMarketSnapshots(current, outcome.snapshots, {
          requestedQuoteIds: ids,
          requestedCapabilityIds: outcome.requestedCapabilityIds,
          failedCapabilities: outcome.failedCapabilities,
          snapshotWarnings: outcome.snapshotWarnings,
        }));
        setLastUpdatedAt(latestReceivedAt(outcome.snapshots.map((snapshot) => snapshot.receivedAt)));
      })()
        .catch((reason) => {
          if (coreFlightRef.current?.controller !== controller || controller.signal.aborted) return;
          const message = errorMessage(reason);
          setState((current) => retainMarketWorkspaceAfterFailure(current, message));
          setError(message);
        })
        .finally(() => {
          if (coreFlightRef.current?.controller !== controller) return;
          coreFlightRef.current = null;
          setLoading(false);
        });
      coreFlightRef.current = { scopeKey: requestScopeKey, controller, promise };
      return promise;
    },
    [activeId, client, ids, idsKey, interval, startSlowRefresh],
  );

  useEffect(() => {
    void refresh({ slow: true });
    return () => {
      coreFlightRef.current?.controller.abort();
      slowFlightRef.current?.controller.abort();
      coreFlightRef.current = null;
      slowFlightRef.current = null;
    };
  }, [refresh, scopeKey]);

  useEffect(() => {
    if (!autoRefresh || loading || !ids.length) return;
    const timer = window.setTimeout(() => {
      if (document.visibilityState !== "visible") return;
      const slow = Date.now() - lastSlowRefreshAtRef.current
        >= slowRefreshInterval(refreshDecision.session);
      void refresh({ slow });
    }, refreshDecision.delayMs);
    return () => window.clearTimeout(timer);
  }, [autoRefresh, ids.length, loading, refresh, refreshDecision.delayMs, refreshDecision.session]);

  useEffect(() => {
    if (!autoRefresh) return;
    const refreshOnVisible = () => {
      if (document.visibilityState !== "visible" || coreFlightRef.current) return;
      const slow = Date.now() - lastSlowRefreshAtRef.current
        >= slowRefreshInterval(refreshDecision.session);
      void refresh({ slow });
    };
    document.addEventListener("visibilitychange", refreshOnVisible);
    return () => document.removeEventListener("visibilitychange", refreshOnVisible);
  }, [autoRefresh, refresh, refreshDecision.session]);

  const persistWatchlist = useCallback(
    (items: MarketWatchlistItem[]) => {
      const uniqueItems = [...new Map(
        items.map((item) => [item.instrumentId, item]),
      ).values()];
      setWatchlist(uniqueItems);
      setSelectedId((current) =>
        uniqueItems.some((item) => item.instrumentId === current)
          ? current
          : (uniqueItems[0]?.instrumentId ?? ""),
      );
      if (storage) saveMarketWatchlist(storage, uniqueItems);
    },
    [storage],
  );

  const addInstrument = useCallback(() => {
    const item = toWatchlistItem(draft, "Market Center 手动添加");
    if (
      !item ||
      watchlist.some((entry) => entry.instrumentId === item.instrumentId)
    ) {
      return;
    }
    persistWatchlist([...watchlist, item]);
    setSelectedId(item.instrumentId);
    setDraft("");
  }, [draft, persistWatchlist, watchlist]);

  const addHoldings = useCallback(() => {
    if (!holdingsWatchlist.length) {
      setError("当前持仓为空，请先导入交易记录或券商持仓。");
      return;
    }
    persistWatchlist([...watchlist, ...holdingsWatchlist]);
    setError(null);
  }, [holdingsWatchlist, persistWatchlist, watchlist]);

  const removeInstrument = useCallback(
    (instrumentId: string) => {
      persistWatchlist(
        watchlist.filter((item) => item.instrumentId !== instrumentId),
      );
    },
    [persistWatchlist, watchlist],
  );

  return {
    state,
    watchlist,
    selectedId,
    selectedQuote,
    selectedBars,
    draft,
    interval,
    autoRefresh,
    pollIntervalMs,
    lastUpdatedAt,
    loading,
    error,
    holdingsWatchlist,
    setSelectedId,
    setDraft,
    setIntervalType,
    setAutoRefresh,
    refresh,
    addInstrument,
    addHoldings,
    removeInstrument,
  };
}

function snapshotRequestLabel(request: MarketSnapshotRequest | undefined): string {
  if (!request) return "Snapshot 请求";
  if (request.include.includes("quotes")) {
    const first = request.instrumentIds[0] ?? "unknown";
    return request.instrumentIds.length > 1
      ? `报价批次 ${first} 等 ${request.instrumentIds.length} 个标的`
      : `报价 ${first}`;
  }
  return `详情 ${request.instrumentIds[0] ?? "unknown"}`;
}

function isIntelSnapshotRequest(request: MarketSnapshotRequest): boolean {
  return request.include.some((capability) =>
    capability === "news" || capability === "announcements"
  );
}

function snapshotOutcome(
  requests: MarketSnapshotRequest[],
  results: Array<PromiseSettledResult<Awaited<ReturnType<MarketClient["getSnapshot"]>>>>,
) {
  const failedAt = new Date().toISOString();
  const failures = results.flatMap((result, index) => {
    if (result.status !== "rejected") return [];
    const request = requests[index];
    const warning = `${snapshotRequestLabel(request)}失败：${errorMessage(result.reason)}`;
    return request ? [{ request, warning, reason: result.reason }] : [];
  });
  return {
    snapshots: results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value.data] : []
    ),
    snapshotWarnings: failures.map((failure) => failure.warning),
    failedCapabilities: failures.flatMap((failure) =>
      marketSnapshotFailureCapabilities(
        failure.request,
        failure.warning,
        failedAt,
        errorAttempts(failure.reason),
      )
    ),
    requestedCapabilityIds: marketRequestCapabilityIds(requests),
  };
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "Market Center 加载失败";
}

function errorAttempts(reason: unknown): MarketProviderAttempt[] {
  if (!reason || typeof reason !== "object" || !("details" in reason)) return [];
  const details = (reason as { details?: unknown }).details;
  if (!details || typeof details !== "object" || !("attempts" in details)) return [];
  const attempts = (details as { attempts?: unknown }).attempts;
  return Array.isArray(attempts)
    ? attempts.filter((attempt): attempt is MarketProviderAttempt =>
        Boolean(attempt)
        && typeof attempt === "object"
        && typeof (attempt as MarketProviderAttempt).provider === "string"
      )
    : [];
}

function latestReceivedAt(values: string[]): string {
  return values.slice().sort().at(-1) ?? new Date().toISOString();
}

function slowRefreshInterval(
  session: ReturnType<typeof marketWorkspaceRefreshDecision>["session"],
): number {
  return session === "closed" || session === "holiday"
    ? IDLE_SLOW_REFRESH_MS
    : ACTIVE_SLOW_REFRESH_MS;
}

async function settleWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<Array<PromiseSettledResult<T>>> {
  const results = new Array<PromiseSettledResult<T>>(tasks.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (nextIndex < tasks.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = { status: "fulfilled", value: await tasks[index]() };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}
