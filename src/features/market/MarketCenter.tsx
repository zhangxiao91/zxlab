import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MarketClient, MarketDataError } from "./client";
import type { MarketBar, MarketInterval, MarketNewsItem, MarketProviderAttempt, MarketProviders, MarketQuote, MarketStatus, MarketWatchlistItem } from "./types";
import { defaultMarketWatchlist, loadMarketWatchlist, saveMarketWatchlist, toWatchlistItem } from "./watchlist";

const number = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 3 });
const compact = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 2 });
const time = (value: string | null | undefined) => value ? new Date(value).toLocaleString("zh-CN") : "—";
const qualityText = (quote?: MarketQuote) => !quote ? "缺报价" : quote.quality === "live" ? "实时" : quote.quality === "cached" ? "缓存" : quote.quality === "stale" ? "过期" : "不可用";
const POLL_INTERVAL_MS = 30_000;

interface MarketCenterState {
  quotes: MarketQuote[];
  bars: Record<string, MarketBar[]>;
  news: MarketNewsItem[];
  announcements: MarketNewsItem[];
  status: MarketStatus[];
  providers: MarketProviders | null;
  attempts: MarketProviderAttempt[];
  warnings: string[];
}

const emptyState = (): MarketCenterState => ({ quotes: [], bars: {}, news: [], announcements: [], status: [], providers: null, attempts: [], warnings: [] });

export default function MarketCenter() {
  const storage = typeof window === "undefined" ? null : window.localStorage;
  const client = useMemo(() => new MarketClient(), []);
  const [watchlist, setWatchlist] = useState<MarketWatchlistItem[]>(() => storage ? loadMarketWatchlist(storage) : defaultMarketWatchlist());
  const [state, setState] = useState<MarketCenterState>(emptyState);
  const [selectedId, setSelectedId] = useState(watchlist[0]?.instrumentId ?? "SSE:512480");
  const [draft, setDraft] = useState("");
  const [interval, setIntervalType] = useState<MarketInterval>("1m");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);
  const ids = useMemo(() => watchlist.map((item) => item.instrumentId), [watchlist]);
  const idsKey = ids.join(",");
  const selectedQuote = state.quotes.find((item) => item.instrumentId === selectedId);
  const selectedBars = state.bars[selectedId] ?? [];

  const refresh = useCallback(async ({ slow = true }: { slow?: boolean } = {}) => {
    if (inFlightRef.current || !ids.length) return;
    inFlightRef.current = true;
    setLoading(true); setError(null);
    try {
      const activeId = selectedId || ids[0];
      const [quotes, providers, sse, szse, news, bars] = await Promise.allSettled([
        client.getQuotes(ids),
        client.getProviders(),
        client.getStatus("SSE"),
        client.getStatus("SZSE"),
        slow ? client.getNews(ids, 36) : Promise.resolve(null),
        activeId ? client.getBars(activeId, interval) : Promise.resolve(null),
      ]);
      const next = emptyState();
      if (quotes.status === "fulfilled") {
        next.quotes = quotes.value.data;
        next.attempts.push(...attemptsOf(quotes.value.meta?.attempts));
        next.warnings.push(...stringsOf(quotes.value.meta?.warnings));
      } else next.warnings.push(errorText("quotes", quotes.reason));
      if (providers.status === "fulfilled") next.providers = providers.value.data;
      else next.warnings.push(errorText("providers", providers.reason));
      for (const result of [sse, szse]) {
        if (result.status === "fulfilled") next.status.push(result.value.data);
        else next.warnings.push(errorText("status", result.reason));
      }
      if (news.status === "fulfilled" && news.value) {
        next.news = news.value.data.filter((item) => item.type !== "announcement");
        next.announcements = news.value.data.filter((item) => item.type === "announcement");
        next.attempts.push(...attemptsOf(news.value.meta?.attempts));
        next.warnings.push(...stringsOf(news.value.meta?.warnings));
      } else if (news.status === "rejected") next.warnings.push(errorText("news", news.reason));
      if (bars.status === "fulfilled" && bars.value) next.bars[activeId] = bars.value.data;
      else if (bars.status === "rejected") next.warnings.push(errorText(`bars:${activeId}`, bars.reason));
      setState((current) => ({
        ...next,
        news: slow ? next.news : current.news,
        announcements: slow ? next.announcements : current.announcements,
        bars: { ...current.bars, ...next.bars },
      }));
      setLastUpdatedAt(new Date().toISOString());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Market Center 加载失败");
    } finally {
      setLoading(false);
      inFlightRef.current = false;
    }
  }, [client, ids, idsKey, selectedId, interval]);

  useEffect(() => { void refresh({ slow: true }); }, [refresh]);
  useEffect(() => {
    if (!autoRefresh) return;
    const tick = () => {
      if (document.visibilityState === "visible") void refresh({ slow: false });
    };
    const timer = window.setInterval(tick, POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [autoRefresh, refresh]);

  const save = (items: MarketWatchlistItem[]) => {
    setWatchlist(items);
    if (!items.some((item) => item.instrumentId === selectedId)) setSelectedId(items[0]?.instrumentId ?? "");
    if (storage) saveMarketWatchlist(storage, items);
  };
  const addInstrument = () => {
    const item = toWatchlistItem(draft, "Market Center 手动添加");
    if (!item || watchlist.some((entry) => entry.instrumentId === item.instrumentId)) return;
    save([...watchlist, item]);
    setSelectedId(item.instrumentId);
    setDraft("");
  };

  return <div className="risk-app market-app"><header className="risk-appbar"><a href="/lab" className="risk-brand"><span className="risk-brand__mark">Z</span><span><strong>Market Center</strong><small>Quotes, news, providers</small></span></a><nav aria-label="Market Center 导航"><a href="/lab/risk">Risk</a><button className="is-active">行情中心</button></nav><div className="risk-appbar__actions"><button className={autoRefresh ? "market-auto-button is-active" : "market-auto-button"} onClick={() => setAutoRefresh((value) => !value)}>{autoRefresh ? "自动刷新 30s" : "自动刷新关"}</button><button disabled={loading} onClick={() => void refresh({ slow: true })}>{loading ? "刷新中" : "刷新"}</button><div className="risk-appbar__status"><span className={error ? "is-mock" : "is-live"}/><div><strong>{error ? "部分不可用" : "Market API"}</strong><small>{lastUpdatedAt ? `更新 ${new Date(lastUpdatedAt).toLocaleTimeString("zh-CN")}` : state.providers?.strategy ?? "sequential-fallback"}</small></div></div></div></header><main className="risk-main market-main"><header className="market-hero"><div><p>行情、K 线、公告与消息面统一入口</p><h1>Market Center 承接估值事实，Risk 只消费它。</h1><span>价格质量、上游 fallback、7x24 新闻和巨潮公告会在这里先被看见，再进入风险台。</span></div><aside className="market-hero__panel"><p>行情中心</p><strong>{state.quotes.length} 个标的</strong><small>{state.news.length} 条消息面 · {state.announcements.length} 条公告</small><span>{state.providers?.strategy ?? "sequential-fallback"} · {autoRefresh ? "报价与当前 K 线轮询中" : "自动刷新已暂停"}</span><a className="market-hero__link" href="/lab/risk">回到 Risk 工作台</a></aside></header>{error && <p className="review-status review-status--warning">{error}</p>}<section className="market-grid"><article className="market-panel market-panel--wide"><header><div><span>自选报价</span><h2>{watchlist.length} 个标的</h2></div><div className="market-add"><input value={draft} placeholder="SSE:512480" onChange={(event) => setDraft(event.target.value)}/><button onClick={addInstrument}>添加</button></div></header><div className="position-table-wrap"><table className="position-table market-table"><thead><tr><th>标的</th><th>价格</th><th>质量</th><th>成交额</th><th>上游</th><th>市场时间</th><th/></tr></thead><tbody>{watchlist.map((item) => { const quote = state.quotes.find((entry) => entry.instrumentId === item.instrumentId); return <tr key={item.instrumentId} className={selectedId === item.instrumentId ? "is-selected" : ""}><td><button className="market-instrument-button" onClick={() => setSelectedId(item.instrumentId)}><strong>{item.label}</strong><span>{item.instrumentId} · {item.reason}</span></button></td><td><strong>{quote?.price == null ? "—" : number.format(quote.price)}</strong></td><td><span className={`quality-tag quality-tag--${quote?.quality === "live" ? "live" : quote?.quality === "unavailable" ? "stale" : "stale"}`}>{qualityText(quote)}</span></td><td>{quote?.turnover == null ? "—" : compact.format(quote.turnover)}</td><td>{quote?.source ?? "—"}</td><td>{time(quote?.marketTimestamp)}</td><td><button className="market-row-action" onClick={() => save(watchlist.filter((entry) => entry.instrumentId !== item.instrumentId))}>移除</button></td></tr>; })}</tbody></table></div></article><article className="market-panel"><header><div><span>价格质量</span><h2>{selectedId}</h2></div><div className="market-chart-controls"><button className={interval === "1m" ? "is-active" : ""} onClick={() => setIntervalType("1m")}>1分钟</button><button className={interval === "1d" ? "is-active" : ""} onClick={() => setIntervalType("1d")}>日K</button></div></header><CandlestickPanel bars={selectedBars} interval={interval}/><dl className="market-kv"><div><dt>现价</dt><dd>{selectedQuote?.price == null ? "—" : number.format(selectedQuote.price)}</dd></div><div><dt>昨收</dt><dd>{selectedQuote?.previousClose == null ? "—" : number.format(selectedQuote.previousClose)}</dd></div><div><dt>来源</dt><dd>{selectedQuote?.source ?? "—"}</dd></div><div><dt>{interval === "1m" ? "1分钟K线点数" : "日K点数"}</dt><dd>{selectedBars.length}</dd></div></dl>{selectedQuote?.warnings.map((warning) => <p key={warning} className="duplicate-note">{warning}</p>)}</article><article className="market-panel"><header><div><span>交易状态</span><h2>交易所</h2></div></header>{state.status.map((item) => <div className="setting-row" key={item.exchange}><span><i className={`source-dot source-dot--${item.open ? "healthy" : "degraded"}`}/>{item.exchange}</span><strong>{item.open ? "开市" : "休市"} · {item.source}</strong></div>)}<div className="setting-row"><span>Provider 策略</span><strong>{state.providers?.strategy ?? "—"}</strong></div><div className="setting-row"><span>自动刷新</span><strong>{autoRefresh ? `${POLL_INTERVAL_MS / 1000} 秒` : "暂停"}</strong></div><div className="setting-row"><span>超时</span><strong>{state.providers?.timeoutMsPerProvider ?? "—"} ms</strong></div></article><article className="market-panel market-panel--half"><header><div><span>消息面</span><h2>7x24 + 个股新闻</h2></div><strong>{state.news.length}</strong></header><NewsList items={state.news}/></article><article className="market-panel market-panel--half"><header><div><span>公告</span><h2>巨潮公告</h2></div><strong>{state.announcements.length}</strong></header><NewsList items={state.announcements}/></article><article className="market-panel market-panel--wide"><header><div><span>上游健康</span><h2>{state.attempts.length} 次 provider attempt</h2></div></header><div className="market-attempts">{state.attempts.slice(0, 18).map((attempt, index) => <div key={`${attempt.provider}-${index}`} className={attempt.ok ? "is-ok" : "is-bad"}><strong>{attempt.provider}</strong><span>{attempt.ok ? "ok" : attempt.errorCode ?? "failed"} · {attempt.latencyMs}ms</span></div>)}</div>{state.warnings.map((warning) => <p key={warning} className="data-warning">{warning}</p>)}</article></section></main><footer className="risk-footer"><span>zxlab / market</span><p>Market Center 是只读行情层；交易账本仍由 Risk 本地维护。</p><a href="/lab/risk">Risk</a></footer></div>;
}

function NewsList({ items }: { items: MarketNewsItem[] }) {
  return <div className="market-news-list">{items.slice(0, 12).map((item) => <a key={item.id} href={item.url} target="_blank" rel="noreferrer"><time>{time(item.publishedAt ?? item.receivedAt)}</time><strong>{item.title}</strong><span>{item.instrumentId ?? item.source}</span>{item.summary && <p>{item.summary}</p>}</a>)}{!items.length && <p className="empty-note">暂无可显示条目。</p>}</div>;
}

function CandlestickPanel({ bars, interval }: { bars: MarketBar[]; interval: MarketInterval }) {
  const ref = useRef<HTMLDivElement>(null);
  const validBars = useMemo(() => bars.filter((item) => item.open != null && item.high != null && item.low != null && item.close != null), [bars]);
  useEffect(() => {
    if (!ref.current || validBars.length < 2) return;
    let chart: import("echarts/core").EChartsType | undefined;
    let disposed = false;
    const resize = () => chart?.resize();
    void import("../risk/chart").then(({ createCandlestickChart }) => {
      if (!ref.current || disposed) return;
      chart = createCandlestickChart(ref.current, validBars, interval);
      window.addEventListener("resize", resize);
    });
    return () => {
      disposed = true;
      window.removeEventListener("resize", resize);
      chart?.dispose();
    };
  }, [validBars, interval]);
  if (validBars.length < 2) return <div className="market-candlestick is-empty">等待 K 线</div>;
  return <div ref={ref} className="market-candlestick" role="img" aria-label={`${interval === "1m" ? "1分钟" : "日"}K 线蜡烛图`}/>;
}

function attemptsOf(value: unknown): MarketProviderAttempt[] {
  return Array.isArray(value) ? value.filter((item): item is MarketProviderAttempt => Boolean(item) && typeof item === "object" && typeof (item as MarketProviderAttempt).provider === "string") : [];
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function errorText(scope: string, reason: unknown): string {
  if (reason instanceof MarketDataError) return `${scope}: ${reason.code}`;
  if (reason instanceof Error) return `${scope}: ${reason.message}`;
  return `${scope}: unavailable`;
}
