import { useEffect } from "react";
import type { TradingScreenAction, TradingScreenStatus } from "../trading/screen";
import AskPanel, { RunActivity } from "./AskPanel";
import {
  type AgentObservationView,
  type AgentRunMode,
  type AgentRunView,
} from "./client";
import { useMarketAgentWorkspace } from "./useMarketAgentWorkspace";

const date = (value: string) =>
  new Date(value).toLocaleString("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

export interface AgentScreenChrome {
  status: TradingScreenStatus;
  primaryAction: TradingScreenAction;
}

export default function AgentToday({
  embedded = false,
  onScreenChange,
}: {
  embedded?: boolean;
  onScreenChange?: (chrome: AgentScreenChrome) => void;
} = {}) {
  const { agent, watchlist, portfolio, commands } = useMarketAgentWorkspace();
  const {
    runs,
    latest,
    events,
    askInstruments,
    bootstrap,
    loading,
    reviewBusy: busy,
    streamingAnswer,
    error,
    setupNote,
    deletingRunId,
    activeEvidenceId: activeRun,
  } = agent;
  const { items: localWatchlist, syncing: syncBusy } = watchlist;
  const {
    preview: portfolioPreview,
    state: portfolioState,
    stateLoaded: portfolioStateLoaded,
    busy: portfolioBusy,
    error: portfolioError,
    note: portfolioNote,
    purgeScope,
  } = portfolio;
  const {
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
    requestPortfolioPurge,
    cancelPortfolioPurge,
    confirmPortfolioPurge,
  } = commands;
  useEffect(() => {
    if (!onScreenChange) return;
    const running = latest && !["success", "partial", "failed"].includes(latest.status);
    onScreenChange({
      status: {
        tone: error ? "degraded" : running ? "neutral" : latest ? "live" : "neutral",
        label: error ? "Agent 降级" : running ? statusLabel(latest.status) : latest ? "Evidence 已封存" : "等待运行",
        detail: latest ? `${date(latest.updatedAt)} · ${modeLabel(latest.result?.mode, latest.portfolioSnapshotId)}` : "只读市场事实",
      },
      primaryAction: {
        label: "盘后复盘",
        pendingLabel: "排队中",
        pending: busy,
        disabled: bootstrap === "required",
        invoke: runReview,
      },
    });
  }, [bootstrap, busy, error, latest, onScreenChange, runReview]);
  return (
    <div className={embedded ? "agent-app agent-app--embedded" : "risk-app agent-app"}>
      <main className="risk-main agent-main">
        <header className="agent-command-header">
          <div>
            <h1 className="agent-command-title">Agent 工作区</h1>
            <p>盘后复盘、提问、工具调用与证据在同一条时间线上。</p>
          </div>
          <div>
            <button type="button" onClick={() => void refresh()} disabled={loading}>
              {loading ? "读取中" : "刷新"}
            </button>
            <span>{latest ? `最近运行 ${date(latest.updatedAt)}` : "尚无运行记录"}</span>
          </div>
        </header>
        {error && (
          <p className="review-status review-status--warning">{error}</p>
        )}
        {bootstrap === "required" && (
          <section className="agent-bootstrap" aria-label="观察列表启动">
            <div>
              <p>观察范围尚未确认</p>
              <h2>先确认本机 Market Center 的观察列表。</h2>
              <span>
                只同步标的和关注理由，不上传交易账本；定时工作流只读取这次确认的
                revision。
              </span>
            </div>
            <div className="agent-bootstrap__items">
              {localWatchlist.map((item) => (
                <div key={item.instrumentId}>
                  <code>{item.instrumentId}</code>
                  <span>{item.reason ?? "自选标的"}</span>
                </div>
              ))}
            </div>
            <button
              onClick={() => void confirmWatchlist()}
              disabled={syncBusy || !localWatchlist.length}
            >
              {syncBusy
                ? "正在同步"
                : `确认并同步 ${localWatchlist.length} 个标的`}
            </button>
          </section>
        )}
        {setupNote && <p className="agent-setup-note">{setupNote}</p>}
        <section className="agent-conversation" aria-label="Agent 对话与执行记录">
          <LatestReviewThread
            events={events}
            latest={latest}
            activeEvidenceId={activeRun}
            streamingAnswer={streamingAnswer}
            onToggle={toggleEvidence}
          />
          <AskPanel
            runs={runs}
            instruments={askInstruments}
            onRunUpdate={updateRun}
          />
        </section>
        <details className="agent-context">
          <summary>
            <div>
              <strong>上下文与持仓</strong>
              <span>{portfolioState?.snapshot ? "持仓感知" : "仅市场"}</span>
            </div>
            <small>管理观察范围、持仓快照和历史清理</small>
          </summary>
          <section className="agent-portfolio" aria-label="持仓快照">
            <header className="agent-portfolio__header">
              <div>
                <p>持仓快照</p>
                <h2>只把确认后的持仓，用于下一次复盘。</h2>
                <span>
                  原始券商文件、账户名称、备注和交易明细始终保留在本机；服务端只接收结构化持仓、汇总现金和失效时间。
                </span>
              </div>
              <a href="/lab/trading?view=positions&action=holdings">
                打开持仓风险台
              </a>
            </header>
          {portfolioError && (
            <p className="review-status review-status--warning">
              {portfolioError}
            </p>
          )}
          {portfolioNote && (
            <p className="agent-portfolio__note">{portfolioNote}</p>
          )}
          <div className="agent-portfolio__grid">
            <article className="agent-portfolio__local">
              <header>
                <div>
                  <span>本机预览</span>
                  <strong>
                    {portfolioPreview?.upload ? "可同步" : "需要处理"}
                  </strong>
                </div>
                <button
                  type="button"
                  onClick={refreshPortfolioPreview}
                  disabled={portfolioBusy}
                >
                  重新检查
                </button>
              </header>
              {portfolioPreview?.upload ? (
                <>
                  <dl>
                    <div>
                      <dt>确认时间</dt>
                      <dd>{date(portfolioPreview.upload.calculatedAt)}</dd>
                    </div>
                    <div>
                      <dt>持仓数量</dt>
                      <dd>{portfolioPreview.positionCount} 个标的</dd>
                    </div>
                    <div>
                      <dt>汇总现金</dt>
                      <dd>{formatCash(portfolioPreview.cash)}</dd>
                    </div>
                    <div>
                      <dt>失效时间</dt>
                      <dd>{date(portfolioPreview.upload.expiresAt)}</dd>
                    </div>
                  </dl>
                  <button
                    type="button"
                    className="agent-portfolio__primary"
                    onClick={() => void syncLocalPortfolioSnapshot()}
                    disabled={portfolioBusy}
                  >
                    {portfolioBusy ? "正在同步" : "同步这份持仓快照"}
                  </button>
                </>
              ) : (
                <div className="agent-portfolio__issues">
                  {portfolioPreview?.issues.map((issue) => <p key={issue}>{issue}</p>)}
                  {!portfolioPreview && <p>正在检查本机已确认的券商持仓快照。</p>}
                </div>
              )}
            </article>
            <article className="agent-portfolio__server">
              <header>
                <div>
                  <span>Agent 使用状态</span>
                  <strong>
                    {!portfolioStateLoaded
                      ? "读取中"
                      : portfolioError
                        ? "状态不可用"
                        : portfolioState?.snapshot
                          ? "持仓感知"
                          : "仅市场"}
                  </strong>
                </div>
                {portfolioState?.snapshot && (
                  <button
                    type="button"
                    className="agent-portfolio__stop"
                    onClick={() => void stopUsingPortfolioSnapshot()}
                    disabled={portfolioBusy}
                  >
                    停止后续使用
                  </button>
                )}
              </header>
              {portfolioState?.snapshot ? (
                <dl>
                  <div>
                    <dt>已同步标的</dt>
                    <dd>{portfolioState.snapshot.positions.length} 个</dd>
                  </div>
                  <div>
                    <dt>服务端失效时间</dt>
                    <dd>{date(portfolioState.snapshot.expiresAt)}</dd>
                  </div>
                  <div>
                    <dt>字段状态</dt>
                    <dd>{portfolioState.snapshot.reliable ? "完整" : "受限"}</dd>
                  </div>
                  <div>
                    <dt>当前规则</dt>
                    <dd>{portfolioState.snapshot.rulesVersion}</dd>
                  </div>
                </dl>
              ) : (
                <p className="agent-portfolio__empty">
                  {portfolioError
                    ? "暂时无法确认 Agent 是否正在使用持仓快照；请稍后刷新。"
                    : "后续 Run 将只读取市场证据，不会使用本机持仓。"}
                </p>
              )}
              <div className="agent-portfolio__history">
                <span>
                  历史 {portfolioState?.historicalSnapshotCount ?? 0} 份快照 / {portfolioState?.linkedRunCount ?? 0} 条关联 Run
                </span>
                <div>
                  <button
                    type="button"
                    onClick={() => requestPortfolioPurge("expired")}
                    disabled={portfolioBusy || !(portfolioState?.expiredSnapshotCount ?? 0)}
                  >
                    清除已过期
                  </button>
                  <button
                    type="button"
                    onClick={() => requestPortfolioPurge("all")}
                    disabled={portfolioBusy || !(portfolioState?.historicalSnapshotCount ?? 0)}
                  >
                    清除全部历史
                  </button>
                </div>
              </div>
            </article>
          </div>
          {purgeScope && (
            <aside className="agent-portfolio__purge" aria-live="polite">
              <div>
                <strong>确认清除{purgeScope === "expired" ? "已过期" : "全部"}持仓快照历史</strong>
                <p>
                  将删除 {purgeScope === "expired" ? portfolioState?.expiredSnapshotCount ?? 0 : portfolioState?.historicalSnapshotCount ?? 0} 份快照和 {purgeScope === "expired" ? portfolioState?.expiredLinkedRunCount ?? 0 : portfolioState?.linkedRunCount ?? 0} 条关联 Run；此操作不可恢复，审计墓碑会保留。
                </p>
              </div>
              <div>
                <button type="button" onClick={cancelPortfolioPurge} disabled={portfolioBusy}>
                  取消
                </button>
                <button
                  type="button"
                  className="agent-portfolio__purge-confirm"
                  onClick={() => void confirmPortfolioPurge()}
                  disabled={portfolioBusy}
                >
                  {portfolioBusy ? "正在清除" : "确认清除"}
                </button>
              </div>
            </aside>
          )}
          </section>
        </details>
        <details className="agent-runs" id="runs">
          <summary>
            <div>
              <strong>运行记录</strong>
              <span>{latest ? `${statusLabel(latest.status)} · ${runs.length} 条` : "暂无记录"}</span>
            </div>
            <small>查看证据、反馈或导出已封存结果</small>
          </summary>
          <div className="agent-runs__toolbar">
            <button onClick={() => void downloadRuns()} disabled={!runs.length}>
              导出全部记录
            </button>
          </div>
          <div className="agent-run-list">
            {runs.length ? (
              runs.slice(0, 8).map((run) => (
                <RunRow
                  key={run.id}
                  run={run}
                  onFeedback={(value) => saveFeedback(run.id, value)}
                  onDelete={() => void removeRun(run)}
                  deleting={deletingRunId === run.id}
                />
              ))
            ) : (
              <p className="agent-empty">
                还没有 Run。这里不会展示未经 Evidence 支撑的模型正文。
              </p>
            )}
          </div>
        </details>
      </main>
      {!embedded && <footer className="risk-footer">
        <span>zxlab / agent</span>
        <p>Market Agent 只读市场事实，不连接交易执行。</p>
        <a href="/lab/market">Market Center</a>
      </footer>}
    </div>
  );
}

function LatestReviewThread({
  events,
  latest,
  activeEvidenceId,
  streamingAnswer,
  onToggle,
}: {
  events: AgentObservationView[];
  latest: AgentRunView | undefined;
  activeEvidenceId: string | null;
  streamingAnswer: string;
  onToggle: (evidenceId: string) => void;
}) {
  if (!latest || latest.workflow === "ask") return null;
  return (
    <section className="agent-review-thread" aria-label="最近一次盘后复盘">
      <article className="agent-message agent-message--user">
        <header>
          <strong>{latest.workflow === "morning_brief" ? "生成盘前简报" : "执行盘后复盘"}</strong>
          <time>{date(latest.createdAt)}</time>
        </header>
        <p>{modeLabel(latest.result?.mode, latest.portfolioSnapshotId)} · 已确认观察列表</p>
      </article>
      <RunActivity status={latest.status} runId={latest.id} limitations={latest.result?.limitations} />
      <article className="agent-message agent-message--assistant agent-review-result">
        <header>
          <div>
            <span className={`agent-status agent-status--${latest.status}`}>{statusLabel(latest.status)}</span>
            <strong>{latest.result?.headline ?? (streamingAnswer ? "正在流式生成复盘" : "正在收集已批准的市场事实")}</strong>
          </div>
          <code>{latest.id}</code>
        </header>
        <p className={streamingAnswer && !latest.result ? "agent-streamed-answer" : undefined}>
          {(latest.result?.summary ?? streamingAnswer) || "事实收集完成后，复盘结果会出现在这里。"}
          {streamingAnswer && !latest.result ? <span className="agent-stream-cursor" aria-hidden="true" /> : null}
        </p>
        <div className="agent-review-result__evidence">
          {events.map((event) => (
            <details className={activeEvidenceId === event.id ? "is-active" : ""} key={event.id} open={activeEvidenceId === event.id}>
              <summary onClick={(clickEvent) => { clickEvent.preventDefault(); onToggle(event.id); }}>
                <span className={`agent-observation agent-observation--${event.class}`}>{observationLabel(event.class)}</span>
                <strong>{event.title}</strong>
              </summary>
              <p>{event.explanation}</p>
              <div className="agent-evidence-row">
                {event.evidenceIds.map((id) => <code key={id}>{id}</code>)}
              </div>
            </details>
          ))}
          {!events.length && <p className="agent-empty">结论会在运行完成后连同证据引用显示。</p>}
        </div>
        {latest.result?.limitations.length ? (
          <details className="agent-review-result__limitations">
            <summary>数据限制 · {latest.result.limitations.length}</summary>
            <ul>{latest.result.limitations.map((item) => <li key={item}>{item}</li>)}</ul>
          </details>
        ) : null}
      </article>
    </section>
  );
}

function observationLabel(value: AgentObservationView["class"]) {
  return ({ fact: "事实", inference: "推断", unknown: "未知" } as const)[value];
}

function RunRow({
  run,
  onFeedback,
  onDelete,
  deleting,
}: {
  run: AgentRunView;
  onFeedback: (
    value: "helpful" | "fact_error" | "missing_factor",
  ) => Promise<void>;
  onDelete: () => void;
  deleting: boolean;
}) {
  return (
    <article className="agent-run-row">
      <div>
        <span className={`agent-status agent-status--${run.status}`}>
          {statusLabel(run.status)}
        </span>
        <time>{date(run.createdAt)}</time>
        <span className="agent-run-mode">
          {modeLabel(run.result?.mode, run.portfolioSnapshotId)}
        </span>
      </div>
      <div>
        <strong>{run.result?.headline ?? "Deterministic close review"}</strong>
        <p>{run.result?.summary ?? "Evidence 正在收集或等待上游数据。"}</p>
      </div>
      <div className="agent-feedback">
        <button title="有帮助" onClick={() => void onFeedback("helpful")}>
          有帮助
        </button>
        <button title="事实错误" onClick={() => void onFeedback("fact_error")}>
          事实错误
        </button>
        <button
          title="缺少因素"
          onClick={() => void onFeedback("missing_factor")}
        >
          缺少因素
        </button>
        <button title="删除本次记录" onClick={onDelete} disabled={deleting}>
          {deleting ? "删除中" : "删除"}
        </button>
      </div>
    </article>
  );
}
function statusLabel(status: string) {
  return (
    (
      {
        queued: "排队中",
        collecting: "收集事实",
        evidence_sealed: "Evidence 已封存",
        generating: "生成中",
        validating: "校验中",
        success: "完成",
        partial: "部分完成",
        failed: "失败",
        retry_wait: "等待重试",
      } as Record<string, string>
    )[status] ?? status
  );
}

function modeLabel(
  mode?: AgentRunMode,
  portfolioSnapshotId?: string | null,
) {
  if (mode === "portfolio-aware") return "持仓感知";
  if (mode === "market-only") return "仅市场";
  return portfolioSnapshotId ? "待持仓校验" : "待市场校验";
}

function formatCash(value: number | null) {
  return value === null
    ? "—"
    : new Intl.NumberFormat("zh-CN", {
        style: "currency",
        currency: "CNY",
        maximumFractionDigits: 2,
      }).format(value);
}
