import gsap from "gsap";
import { useEffect, useRef } from "react";
import type { AgentFeedback, AgentFeedbackValue } from "@zxlab/market-agent-schema";
import type { TradingScreenAction, TradingScreenStatus } from "../trading/screen";
import AskPanel, { RunActivity } from "./AskPanel";
import { RunOutcomeSummary } from "./RunOutcomeSummary";
import { RunFeedbackControl } from "./RunFeedbackControl";
import {
  type AgentObservationView,
  type AgentRunMode,
  type AgentRunView,
} from "./client";
import { buildMarketReviewReport } from "./market-review-report";
import { portfolioActionLabel, runExportLabel } from "./action-state";
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
    askInstruments,
    bootstrap,
    loading,
    reviewBusy: busy,
    streamingAnswer,
    error,
    setupNote,
    deletingRunId,
    loadingMoreRuns,
    hasMoreRuns,
    activeEvidenceId: activeRun,
    exportBusy,
    exportNote,
    exportError,
  } = agent;
  const { items: localWatchlist, syncing: syncBusy } = watchlist;
  const {
    preview: portfolioPreview,
    state: portfolioState,
    stateLoaded: portfolioStateLoaded,
    busy: portfolioBusy,
    action: portfolioAction,
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
    loadMoreRuns,
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
            latest={latest}
            activeEvidenceId={activeRun}
            streamingAnswer={streamingAnswer}
            onToggle={toggleEvidence}
          />
          <AskPanel
            runs={runs}
            instruments={askInstruments}
            onRunUpdate={updateRun}
            onSaveFeedback={saveFeedback}
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
            <p className="agent-portfolio__note" aria-live="polite">{portfolioNote}</p>
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
                    {portfolioActionLabel(portfolioAction, "sync")}
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
                    {portfolioActionLabel(portfolioAction, "stop")}
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
                  {portfolioActionLabel(portfolioAction, "purge")}
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
            <span data-tone={exportError ? "error" : exportNote ? "success" : "neutral"} aria-live="polite">
              {exportError ?? exportNote ?? "导出包含完整结构化 Run 与审计信息。"}
            </span>
            <button onClick={() => void downloadRuns()} disabled={!runs.length || exportBusy}>
              {runExportLabel(exportBusy)}
            </button>
            {hasMoreRuns && (
              <button onClick={() => void loadMoreRuns()} disabled={loadingMoreRuns}>
                {loadingMoreRuns ? "读取中" : "加载更早记录"}
              </button>
            )}
          </div>
          <div className="agent-run-list">
            {runs.length ? (
              runs.map((run) => (
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
  latest,
  activeEvidenceId,
  streamingAnswer,
  onToggle,
}: {
  latest: AgentRunView | undefined;
  activeEvidenceId: string | null;
  streamingAnswer: string;
  onToggle: (evidenceId: string) => void;
}) {
  const reportElement = useRef<HTMLElement>(null);
  const report = latest && latest.workflow !== "ask" && latest.result ? buildMarketReviewReport(latest.result) : null;
  useEffect(() => {
    if (!report || !reportElement.current || !latest) return;
    let cancelled = false;
    let context: gsap.Context | undefined;
    void import("gsap/ScrollTrigger").then(({ ScrollTrigger }) => {
      if (cancelled || !reportElement.current) return;
      gsap.registerPlugin(ScrollTrigger);
      context = gsap.context(() => {
        gsap.fromTo(".market-review-report__summary span", { opacity: 0.18 }, {
          opacity: 1,
          stagger: 0.018,
          ease: "none",
          scrollTrigger: { trigger: ".market-review-report__summary", start: "top 88%", end: "bottom 56%", scrub: true },
        });
        gsap.fromTo(".market-review-report__chapter", { opacity: 0.25, y: 28 }, {
          opacity: 1,
          y: 0,
          stagger: 0.08,
          ease: "power2.out",
          scrollTrigger: { trigger: ".market-review-report__body", start: "top 84%", end: "bottom 74%", scrub: 0.7 },
        });
      }, reportElement);
    });
    return () => { cancelled = true; context?.revert(); };
  }, [latest?.id, report?.title]);
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
      <RunActivity status={latest.status} runId={latest.id} limitations={latest.result?.limitations} outcome={latest.result?.outcome} />
      <article className="agent-message agent-message--assistant agent-review-result market-review-report" ref={reportElement}>
        <header className="market-review-report__masthead">
          <div>
            <span className={`agent-status agent-status--${latest.status}`}>{statusLabel(latest.status)} · {date(latest.createdAt)}</span>
            <strong>{report?.title ?? (streamingAnswer ? "正在生成盘后复盘" : "正在收集已批准的市场事实")}</strong>
          </div>
          <span>{modeLabel(latest.result?.mode, latest.portfolioSnapshotId)}</span>
        </header>
        <section className="market-review-report__summary" aria-label="执行摘要">
          <h2>执行摘要</h2>
          <p className={streamingAnswer && !report ? "agent-streamed-answer" : undefined}>
            {((report?.executiveSummary ?? streamingAnswer) || "事实收集完成后，复盘报告会出现在这里。").split("").map((character, index) => <span key={`${character}-${index}`}>{character}</span>)}
            {streamingAnswer && !report ? <span className="agent-stream-cursor" aria-hidden="true" /> : null}
          </p>
        </section>
        {report ? <div className="market-review-report__body">
          <ReportObservationChapter title="关键发现" items={report.findings} activeEvidenceId={activeEvidenceId} onToggle={onToggle} className="market-review-report__chapter--wide" />
          <ReportObservationChapter title="持仓影响" items={report.portfolioImpacts} activeEvidenceId={activeEvidenceId} onToggle={onToggle} />
          <section className="market-review-report__chapter market-review-report__chapter--wide">
            <header><h2>后续观察</h2><span>{report.watchNext.length}</span></header>
            {report.watchNext.length ? <ol className="market-review-report__watchlist">{report.watchNext.map((item, index) => <li key={`${item.condition}-${index}`}><strong>{item.condition}</strong><p>{item.reason}</p><EvidenceReferences ids={item.evidenceIds} /></li>)}</ol> : <p className="agent-empty">本次没有形成新的后续观察条件。</p>}
          </section>
          <section className="market-review-report__chapter market-review-report__limitations">
            <header><h2>数据边界</h2><span>{report.limitations.length}</span></header>
            {report.limitations.length ? <ul>{report.limitations.map((item) => <li key={item}>{item}</li>)}</ul> : <p>本次没有额外的数据质量限制。</p>}
          </section>
        </div> : null}
        <details className="market-review-report__technical">
          <summary>运行与模型信息</summary>
          <code>{latest.id}</code>
          <RunOutcomeSummary outcome={latest.result?.outcome} />
        </details>
      </article>
    </section>
  );
}

function ReportObservationChapter({ title, items, activeEvidenceId, onToggle, className = "" }: { title: string; items: AgentObservationView[]; activeEvidenceId: string | null; onToggle: (evidenceId: string) => void; className?: string }) {
  return <section className={`market-review-report__chapter ${className}`}>
    <header><h2>{title}</h2><span>{items.length}</span></header>
    {items.length ? <div className="market-review-report__findings">{items.map((item) => <article key={item.id} className={`market-review-report__finding market-review-report__finding--${item.class}`}>
      <div><span>{observationLabel(item.class)}</span><strong>{item.title}</strong></div>
      <p>{item.explanation}</p>
      <details open={activeEvidenceId === item.id}><summary onClick={(event) => { event.preventDefault(); onToggle(item.id); }}>查看证据 · {item.evidenceIds.length}</summary><EvidenceReferences ids={item.evidenceIds} /></details>
    </article>)}</div> : <p className="agent-empty">本次没有可确认的{title}。</p>}
  </section>;
}

function EvidenceReferences({ ids }: { ids: string[] }) {
  return <div className="agent-evidence-row">{ids.map((id) => <code key={id}>{id}</code>)}</div>;
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
    value: AgentFeedbackValue,
  ) => Promise<AgentFeedback>;
  onDelete: () => void;
  deleting: boolean;
}) {
  const purged = Boolean(run.payloadPurgedAt);
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
        <strong>{purged ? "正文已按保留策略清除" : run.result?.headline ?? "Deterministic close review"}</strong>
        <p>{purged ? `审计 fingerprint 保留${run.evidenceFingerprint ? `：${run.evidenceFingerprint}` : ""}` : run.result?.summary ?? "Evidence 正在收集或等待上游数据。"}</p>
      </div>
      <div className="agent-run-actions">
        <RunFeedbackControl feedback={run.feedback} disabled={purged} onSubmit={onFeedback} />
        <button
          className="agent-run-delete"
          title="删除本次记录"
          onClick={onDelete}
          disabled={deleting || purged}
        >
          {purged ? "已清除" : deleting ? "删除中" : "删除"}
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
