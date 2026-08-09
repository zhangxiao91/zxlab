import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { buildPositionsDetailed, LocalPortfolioRepository } from "../risk/ledger";
import { MarketClient } from "./client";
import {
  capabilityHealth,
  LatestMarketRequest,
  summarizeMarketDataQuality,
} from "./quality";
import type {
  MarketBar,
  MarketDataQuality,
  MarketInterval,
  MarketNewsItem,
  MarketProviderAttempt,
  MarketProviders,
  MarketQuote,
  MarketStatus,
  MarketWatchlistItem,
} from "./types";
import {
  defaultMarketWatchlist,
  loadMarketWatchlist,
  saveMarketWatchlist,
  toWatchlistItem,
} from "./watchlist";

const INITIAL_POLL_INTERVAL_MS = 30_000;
const REALTIME_POLL_INTERVAL_MS = 15_000;
const SNAPSHOT_POLL_INTERVAL_MS = 60_000;

export interface MarketWorkspaceState {
  quotes: MarketQuote[];
  bars: Record<string, MarketBar[]>;
  news: MarketNewsItem[];
  announcements: MarketNewsItem[];
  status: MarketStatus[];
  providers: MarketProviders | null;
  attempts: MarketProviderAttempt[];
  warnings: string[];
  quality: MarketDataQuality;
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

const emptyQuality = (): MarketDataQuality => ({
  status: "unavailable",
  asOf: null,
  receivedAt: new Date(0).toISOString(),
  freshness: "unknown",
  capabilities: [],
  warnings: [],
  attempts: [],
  unavailableCapabilities: [],
});

const emptyState = (): MarketWorkspaceState => ({
  quotes: [],
  bars: {},
  news: [],
  announcements: [],
  status: [],
  providers: null,
  attempts: [],
  warnings: [],
  quality: emptyQuality(),
});

export function useMarketWorkspace(): MarketWorkspace {
  const storage = useMemo(
    () => (typeof window === "undefined" ? null : window.localStorage),
    [],
  );
  const client = useMemo(() => new MarketClient(), []);
  const [watchlist, setWatchlist] = useState<MarketWatchlistItem[]>(() =>
    storage ? loadMarketWatchlist(storage) : defaultMarketWatchlist(),
  );
  const [state, setState] = useState<MarketWorkspaceState>(emptyState);
  const [selectedId, setSelectedId] = useState(
    watchlist[0]?.instrumentId ?? "",
  );
  const [draft, setDraft] = useState("");
  const [interval, setIntervalType] = useState<MarketInterval>("1m");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestGateRef = useRef(new LatestMarketRequest());

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
    () => state.bars[selectedId] ?? [],
    [selectedId, state.bars],
  );
  const pollIntervalMs = state.status.length
    ? state.status.some((item) => item.open)
      ? REALTIME_POLL_INTERVAL_MS
      : SNAPSHOT_POLL_INTERVAL_MS
    : INITIAL_POLL_INTERVAL_MS;

  const refresh = useCallback(
    async ({ slow = true }: { slow?: boolean } = {}) => {
      const requestToken = requestGateRef.current.begin();
      if (!ids.length) {
        setState(emptyState());
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const activeId = selectedId || ids[0];
        const [quotes, providers, sse, szse, news, announcements, bars] =
          await Promise.allSettled([
            client.getQuotes(ids),
            client.getProviders(),
            client.getStatus("SSE"),
            client.getStatus("SZSE"),
            slow ? client.getNews(ids, 36) : Promise.resolve(null),
            slow && activeId
              ? client.getAnnouncements(activeId, 20)
              : Promise.resolve(null),
            activeId
              ? client.getBars(activeId, interval)
              : Promise.resolve(null),
          ]);
        if (!requestGateRef.current.isCurrent(requestToken)) return;
        const next = emptyState();
        const capabilityResults: ReturnType<typeof capabilityHealth>[] = [];
        if (quotes.status === "fulfilled") {
          next.quotes = quotes.value.data;
        }
        capabilityResults.push(
          capabilityHealth({
            id: "quotes",
            response: quotes.status === "fulfilled" ? quotes.value : undefined,
            error: quotes.status === "rejected" ? quotes.reason : undefined,
            emptyIsUnavailable: true,
            itemQualities:
              quotes.status === "fulfilled"
                ? quotes.value.data.map((item) => item.quality)
                : [],
          }),
        );
        if (providers.status === "fulfilled") {
          next.providers = providers.value.data;
        }
        capabilityResults.push(
          capabilityHealth({
            id: "providers",
            response:
              providers.status === "fulfilled" ? providers.value : undefined,
            error:
              providers.status === "rejected" ? providers.reason : undefined,
          }),
        );
        for (const [exchange, result] of [
          ["SSE", sse],
          ["SZSE", szse],
        ] as const) {
          if (result.status === "fulfilled") {
            next.status.push(result.value.data);
          }
          capabilityResults.push(
            capabilityHealth({
              id: `status:${exchange}`,
              response:
                result.status === "fulfilled" ? result.value : undefined,
              error: result.status === "rejected" ? result.reason : undefined,
              extraWarnings:
                result.status === "fulfilled"
                  ? (result.value.data.warnings ?? [])
                  : [],
            }),
          );
        }
        if (news.status === "fulfilled" && news.value) {
          next.news = news.value.data;
        }
        if (slow) {
          capabilityResults.push(
            capabilityHealth({
              id: "news",
              response:
                news.status === "fulfilled"
                  ? (news.value ?? undefined)
                  : undefined,
              error: news.status === "rejected" ? news.reason : undefined,
            }),
          );
        }
        if (announcements.status === "fulfilled" && announcements.value) {
          next.announcements = announcements.value.data;
        }
        if (slow) {
          capabilityResults.push(
            capabilityHealth({
              id: `announcements:${activeId}`,
              response:
                announcements.status === "fulfilled"
                  ? (announcements.value ?? undefined)
                  : undefined,
              error:
                announcements.status === "rejected"
                  ? announcements.reason
                  : undefined,
            }),
          );
        }
        if (bars.status === "fulfilled" && bars.value) {
          next.bars[activeId] = bars.value.data;
        }
        capabilityResults.push(
          capabilityHealth({
            id: `bars:${activeId}:${interval}`,
            response:
              bars.status === "fulfilled" ? (bars.value ?? undefined) : undefined,
            error: bars.status === "rejected" ? bars.reason : undefined,
            emptyIsUnavailable: true,
          }),
        );
        const receivedAt = new Date().toISOString();
        setState((current) => ({
          ...next,
          news: slow ? next.news : current.news,
          announcements: slow ? next.announcements : current.announcements,
          bars: { ...current.bars, ...next.bars },
          ...qualityState(
            capabilityResults,
            current.quality,
            receivedAt,
            !slow,
          ),
        }));
        setLastUpdatedAt(receivedAt);
      } catch (reason) {
        setError(
          reason instanceof Error ? reason.message : "Market Center 加载失败",
        );
      } finally {
        if (requestGateRef.current.isCurrent(requestToken)) {
          setLoading(false);
        }
      }
    },
    [client, ids, selectedId, interval],
  );

  useEffect(() => {
    void refresh({ slow: true });
  }, [refresh]);

  useEffect(() => {
    if (!autoRefresh) return;
    const tick = () => {
      if (document.visibilityState === "visible") {
        void refresh({ slow: false });
      }
    };
    const timer = window.setInterval(tick, pollIntervalMs);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [autoRefresh, pollIntervalMs, refresh]);

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

function qualityState(
  fresh: ReturnType<typeof capabilityHealth>[],
  current: MarketDataQuality,
  receivedAt: string,
  retainSlowCapabilities: boolean,
) {
  const replaced = new Set(fresh.map((item) => item.id));
  const retained = retainSlowCapabilities
    ? current.capabilities.filter(
        (item) =>
          !replaced.has(item.id) &&
          (item.id === "news" || item.id.startsWith("announcements:")),
      )
    : [];
  const quality = summarizeMarketDataQuality(
    [...fresh, ...retained],
    receivedAt,
  );
  return { quality, attempts: quality.attempts, warnings: quality.warnings };
}
