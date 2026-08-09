import { useEffect, useMemo, useRef, useState } from "react";
import type { TradingScreenAction, TradingScreenStatus, TradingScreenToggle } from "../trading/screen";
import { resolveMarketChartKind } from "./chart-model";
import { marketStatusPresentation, quoteQualityPresentation } from "./presentation";
import type {
  MarketBar,
  MarketInterval,
  MarketNewsItem,
  MarketQuote,
  MarketStatus,
} from "./types";
import { useMarketWorkspace } from "./useMarketWorkspace";

const number = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 3 });
const compact = new Intl.NumberFormat("zh-CN", {
  notation: "compact",
  maximumFractionDigits: 2,
});
const time = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString("zh-CN") : "—";

export interface MarketScreenChrome {
  status: TradingScreenStatus;
  primaryAction: TradingScreenAction;
  secondaryToggle: TradingScreenToggle;
}

interface MarketCenterProps {
  embedded?: boolean;
  onScreenChange?: (chrome: MarketScreenChrome) => void;
}

export default function MarketCenter({
  embedded = false,
  onScreenChange,
}: MarketCenterProps = {}) {
  const {
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
    setSelectedId,
    setDraft,
    setIntervalType,
    setAutoRefresh,
    refresh,
    addInstrument,
    addHoldings,
    removeInstrument,
  } = useMarketWorkspace();
  const [intelTab, setIntelTab] = useState<"news" | "announcements">("news");

  const healthLabel = state.quality.status === "operational"
    ? "行情在线"
    : state.quality.status === "degraded"
      ? "数据降级"
      : "行情不可用";
  const healthTone: TradingScreenStatus["tone"] = state.quality.status === "operational"
    ? "live"
    : state.quality.status === "degraded"
      ? "degraded"
      : "offline";

  useEffect(() => {
    if (!onScreenChange) return;
    onScreenChange({
      status: {
        tone: healthTone,
        label: healthLabel,
        detail: lastUpdatedAt
          ? `${new Date(lastUpdatedAt).toLocaleTimeString("zh-CN")} · ${state.quality.freshness}`
          : (state.providers?.strategy ?? "等待首轮行情"),
      },
      primaryAction: {
        label: "刷新",
        pendingLabel: "刷新中",
        pending: loading,
        invoke: () => refresh({ slow: true }),
      },
      secondaryToggle: {
        label: autoRefresh ? `自动 ${pollIntervalMs / 1000}s` : "自动关闭",
        pressed: autoRefresh,
        invoke: () => setAutoRefresh((current) => !current),
      },
    });
  }, [
    autoRefresh,
    healthLabel,
    healthTone,
    lastUpdatedAt,
    loading,
    onScreenChange,
    pollIntervalMs,
    refresh,
    setAutoRefresh,
    state.providers?.strategy,
    state.quality.freshness,
  ]);

  const selectedWatchlistItem = watchlist.find((item) => item.instrumentId === selectedId);
  const move = quoteMove(selectedQuote);
  const rangePosition = quoteRangePosition(selectedQuote);
  const intelItems = useMemo(() => {
    if (intelTab === "announcements") return state.announcements;
    return state.news.filter((item) => !item.instrumentId || item.instrumentId === selectedId);
  }, [intelTab, selectedId, state.announcements, state.news]);

  const refreshControls = (
    <div className="risk-appbar__actions">
      <button
        type="button"
        className={autoRefresh ? "market-auto-button is-active" : "market-auto-button"}
        aria-pressed={autoRefresh}
        onClick={() => setAutoRefresh((current) => !current)}
      >
        {autoRefresh ? `自动 ${pollIntervalMs / 1000}s` : "自动关闭"}
      </button>
      <button type="button" disabled={loading} onClick={() => void refresh({ slow: true })}>
        {loading ? "刷新中" : "刷新"}
      </button>
      <div className="risk-appbar__status" role="status" aria-live="polite">
        <span className={`is-${healthTone}`} />
        <div>
          <strong>{healthLabel}</strong>
          <small>{state.quality.freshness}</small>
        </div>
      </div>
    </div>
  );

  return (
    <div className={embedded ? "market-app market-app--embedded" : "risk-app market-app"}>
      {!embedded && (
        <header className="risk-appbar">
          <a href="/lab" className="risk-brand">
            <span className="risk-brand__mark">Z</span>
            <span><strong>Market Center</strong><small>Quotes / evidence</small></span>
          </a>
          <nav aria-label="Market Center 导航">
            <a href="/lab/trading?view=overview">Risk</a>
            <a className="is-active" href="/lab/trading?view=market">行情</a>
          </nav>
          {refreshControls}
        </header>
      )}

      <main className="market-workbench">
        {error && <p className="market-workbench__alert" role="status">{error}</p>}

        <header className="market-quote-strip">
          <div className="market-quote-strip__identity">
            <span>{selectedQuote?.instrumentId ?? (selectedId || "未选择标的")}</span>
            <strong>{selectedWatchlistItem?.label ?? "Market"}</strong>
          </div>
          <div className="market-quote-strip__price">
            <strong>{formatPrice(selectedQuote?.price)}</strong>
            <span className={move.value == null ? "" : move.value >= 0 ? "is-up" : "is-down"}>
              {formatSigned(move.value)} {formatPercent(move.percent)}
            </span>
          </div>
          <dl className="market-quote-strip__facts">
            <div><dt>开盘</dt><dd>{formatPrice(selectedQuote?.open)}</dd></div>
            <div><dt>最高</dt><dd>{formatPrice(selectedQuote?.high)}</dd></div>
            <div><dt>最低</dt><dd>{formatPrice(selectedQuote?.low)}</dd></div>
            <div><dt>成交额</dt><dd>{formatCompact(selectedQuote?.turnover)}</dd></div>
          </dl>
          <div className="market-quote-strip__quality">
            <span className={`quality-tag quality-tag--${quoteQualityPresentation(selectedQuote).tone}`}>
              {quoteQualityPresentation(selectedQuote).label}
            </span>
            <time>{time(selectedQuote?.marketTimestamp)}</time>
          </div>
        </header>

        <section className="market-workbench__grid">
          <aside className="market-watch" aria-label="自选标的">
            <header>
              <div><strong>自选</strong><span>{watchlist.length}</span></div>
              <button type="button" onClick={addHoldings}>同步持仓</button>
            </header>
            <form
              className="market-watch__add"
              onSubmit={(event) => {
                event.preventDefault();
                addInstrument();
              }}
            >
              <label htmlFor="market-symbol">添加标的</label>
              <div>
                <input
                  id="market-symbol"
                  value={draft}
                  placeholder="SSE:512480"
                  aria-invalid={Boolean(draft && !/^(SSE|SZSE):\d{6}$/i.test(draft.trim()))}
                  onChange={(event) => setDraft(event.target.value)}
                />
                <button type="submit">添加</button>
              </div>
            </form>
            <div className="market-watch__list">
              {watchlist.map((item) => {
                const quote = state.quotes.find((entry) => entry.instrumentId === item.instrumentId);
                const itemMove = quoteMove(quote);
                return (
                  <article className={selectedId === item.instrumentId ? "is-selected" : ""} key={item.instrumentId}>
                    <button type="button" onClick={() => setSelectedId(item.instrumentId)}>
                      <span><strong>{item.label}</strong><small>{item.symbol}</small></span>
                      <span><strong>{formatPrice(quote?.price)}</strong><small className={itemMove.value == null ? "" : itemMove.value >= 0 ? "is-up" : "is-down"}>{formatPercent(itemMove.percent)}</small></span>
                    </button>
                    <button
                      type="button"
                      className="market-watch__remove"
                      aria-label={`从自选移除 ${item.label}`}
                      title="移除"
                      onClick={() => removeInstrument(item.instrumentId)}
                    >
                      ×
                    </button>
                  </article>
                );
              })}
              {!watchlist.length && (
                <div className="market-watch__empty">
                  <strong>自选为空</strong>
                  <p>输入交易所与六位代码，或从当前持仓同步。</p>
                </div>
              )}
            </div>
          </aside>

          <section className="market-chart-stage" aria-label="价格与成交量">
            <header>
              <div>
                <span>{selectedId || "PRICE"}</span>
                <strong>价格与成交量</strong>
              </div>
              <div className="market-chart-controls" role="tablist" aria-label="图表周期">
                <button type="button" role="tab" aria-selected={interval === "1m"} className={interval === "1m" ? "is-active" : ""} onClick={() => setIntervalType("1m")}>分时</button>
                <button type="button" role="tab" aria-selected={interval === "1d"} className={interval === "1d" ? "is-active" : ""} onClick={() => setIntervalType("1d")}>日 K</button>
              </div>
            </header>
            <CandlestickPanel bars={selectedBars} interval={interval} selectedId={selectedId} />
            <dl className="market-session-facts">
              <div><dt>昨收</dt><dd>{formatPrice(selectedQuote?.previousClose)}</dd></div>
              <div><dt>成交量</dt><dd>{formatCompact(selectedQuote?.volume)}</dd></div>
              <div><dt>区间位置</dt><dd>{rangePosition == null ? "—" : `${Math.round(rangePosition * 100)}%`}</dd></div>
              <div><dt>点数</dt><dd>{selectedBars.length}</dd></div>
              <div><dt>来源</dt><dd>{selectedQuote?.source ?? "—"}</dd></div>
            </dl>
            <CorroborationPlot quote={selectedQuote} />
          </section>

          <aside className="market-intel" aria-label="市场消息与公告">
            <header>
              <div>
                <strong>事件流</strong>
                <span>{intelItems.length}</span>
              </div>
              <div className="market-intel__tabs" role="tablist" aria-label="事件类型">
                <button type="button" role="tab" aria-selected={intelTab === "news"} className={intelTab === "news" ? "is-active" : ""} onClick={() => setIntelTab("news")}>新闻</button>
                <button type="button" role="tab" aria-selected={intelTab === "announcements"} className={intelTab === "announcements" ? "is-active" : ""} onClick={() => setIntelTab("announcements")}>公告</button>
              </div>
            </header>
            <NewsTimeline items={intelItems} />
          </aside>
        </section>

        <details className="market-diagnostics">
          <summary>
            <span>数据诊断</span>
            <strong>{state.attempts.length} 次上游请求 · {state.quality.unavailableCapabilities.length} 项不可用</strong>
          </summary>
          <div className="market-diagnostics__grid">
            <section>
              <h2>交易所状态</h2>
              {state.status.map((item) => (
                <div className="setting-row" key={item.exchange}>
                  <span><i className={`source-dot source-dot--${statusDot(item)}`} />{item.exchange}</span>
                  <strong>{marketStatusPresentation(item)} · {item.source}</strong>
                </div>
              ))}
            </section>
            <section>
              <h2>Provider</h2>
              <div className="setting-row"><span>策略</span><strong>{state.providers?.strategy ?? "—"}</strong></div>
              <div className="setting-row"><span>单次超时</span><strong>{state.providers?.timeoutMsPerProvider ?? "—"} ms</strong></div>
              <div className="setting-row"><span>自动刷新</span><strong>{autoRefresh ? `${pollIntervalMs / 1000} 秒` : "暂停"}</strong></div>
            </section>
            <section className="market-diagnostics__attempts">
              <h2>最近请求</h2>
              {state.attempts.slice(0, 12).map((attempt, index) => (
                <div key={`${attempt.provider}-${index}`} className={attempt.ok ? "is-ok" : "is-bad"}>
                  <strong>{attempt.provider}</strong>
                  <span>{attempt.ok ? "ok" : (attempt.errorCode ?? "failed")} · {attempt.latencyMs} ms</span>
                </div>
              ))}
            </section>
          </div>
          {[...state.quality.unavailableCapabilities.map((id) => `不可用 capability：${id}`), ...state.warnings].map((warning) => (
            <p key={warning} className="data-warning">{warning}</p>
          ))}
        </details>
      </main>
    </div>
  );
}

function NewsTimeline({ items }: { items: MarketNewsItem[] }) {
  return (
    <div className="market-news-timeline">
      {items.slice(0, 20).map((item) => (
        <a key={item.id} href={item.url} target="_blank" rel="noreferrer">
          <time>{time(item.publishedAt ?? item.receivedAt)}</time>
          <strong>{item.title}</strong>
          <span>{item.instrumentId ? `${item.instrumentId} · ${item.source}` : item.source}</span>
          {item.summary && <p>{item.summary}</p>}
        </a>
      ))}
      {!items.length && <p className="market-intel__empty">当前标的暂无这类事件。</p>}
    </div>
  );
}

function CorroborationPlot({ quote }: { quote: MarketQuote | undefined }) {
  const corroboration = quote?.corroboration;
  const observations = corroboration?.observations ?? [];
  const prices = observations.map((item) => item.price);
  const minimum = Math.min(...prices);
  const maximum = Math.max(...prices);
  const spread = maximum - minimum;

  return (
    <section className="market-corroboration" aria-label="多源报价核验">
      <header>
        <div><span>多源核验</span><strong>{corroboration?.status ?? "not requested"}</strong></div>
        <span>{corroboration?.maxDeviationBps == null ? "—" : `${corroboration.maxDeviationBps.toFixed(1)} bps`} / 阈值 {corroboration?.thresholdBps ?? "—"}</span>
      </header>
      {observations.length ? (
        <div className="market-corroboration__plot">
          {observations.map((observation) => {
            const position = spread > 0 ? ((observation.price - minimum) / spread) * 100 : 50;
            return (
              <div key={`${observation.provider}-${observation.receivedAt}`}>
                <span>{observation.provider}</span>
                <i style={{ "--market-observation-position": `${position}%` } as React.CSSProperties} />
                <strong>{number.format(observation.price)}</strong>
              </div>
            );
          })}
        </div>
      ) : (
        <p>当前报价使用顺序回退，未请求多源核验。</p>
      )}
    </section>
  );
}

function CandlestickPanel({
  bars,
  interval,
  selectedId,
}: {
  bars: MarketBar[];
  interval: MarketInterval;
  selectedId: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartKind = useMemo(() => resolveMarketChartKind(bars), [bars]);
  const validBars = useMemo(() => bars.filter((item) => item.open != null && item.high != null && item.low != null && item.close != null), [bars]);
  const closeBars = useMemo(() => bars.filter((item) => item.close != null), [bars]);

  useEffect(() => {
    if (!ref.current || chartKind === "empty") return;
    let chart: import("echarts/core").EChartsType | undefined;
    let disposed = false;
    const resize = () => chart?.resize();
    void import("../risk/chart").then(({ createCandlestickChart, createMarketLineChart }) => {
      if (!ref.current || disposed) return;
      chart = chartKind === "candlestick"
        ? createCandlestickChart(ref.current, validBars, interval)
        : createMarketLineChart(ref.current, closeBars, interval);
      window.addEventListener("resize", resize);
    });
    return () => {
      disposed = true;
      window.removeEventListener("resize", resize);
      chart?.dispose();
    };
  }, [chartKind, closeBars, interval, selectedId, validBars]);

  if (chartKind === "empty") {
    return (
      <div className="market-candlestick is-empty">
        <strong>暂无价格序列</strong>
        <span>{selectedId ? "等待行情上游返回 K 线。" : "先从左侧选择或添加一个标的。"}</span>
      </div>
    );
  }
  return <div ref={ref} className="market-candlestick" role="img" aria-label={`${selectedId} ${interval === "1m" ? "分钟" : "日"}价格与成交量图`} />;
}

function quoteMove(quote: MarketQuote | undefined) {
  if (quote?.price == null || quote.previousClose == null || quote.previousClose === 0) {
    return { value: null, percent: null };
  }
  const value = quote.price - quote.previousClose;
  return { value, percent: value / quote.previousClose };
}

function quoteRangePosition(quote: MarketQuote | undefined) {
  if (quote?.price == null || quote.high == null || quote.low == null || quote.high === quote.low) return null;
  return Math.max(0, Math.min(1, (quote.price - quote.low) / (quote.high - quote.low)));
}

function formatPrice(value: number | null | undefined) {
  return value == null ? "—" : number.format(value);
}

function formatCompact(value: number | null | undefined) {
  return value == null ? "—" : compact.format(value);
}

function formatSigned(value: number | null) {
  if (value == null) return "—";
  return `${value >= 0 ? "+" : ""}${number.format(value)}`;
}

function formatPercent(value: number | null) {
  if (value == null) return "—";
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
}

function statusDot(item: MarketStatus): "healthy" | "degraded" | "offline" {
  if (item.quality === "unavailable") return "offline";
  if (item.quality === "degraded" || item.reliable === false || item.warnings?.length) return "degraded";
  return "healthy";
}
