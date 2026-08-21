import React, { useEffect, useMemo, useRef, useState } from "react";
import gsap from "gsap";
import { isCancellableRunStatus, type AgentFeedback, type AgentFeedbackValue, type AgentResult, type ResearchReportFactBlock, type ResearchReportFactMetric, type ResearchReportV2, type RunTiming, type SealedEvidenceBundle } from "@zxlab/market-agent-schema";
import { isMarketReference, type MarketReference } from "@zxlab/market-schema";
import type { TradingScreenAction, TradingScreenStatus } from "../trading/screen";
import AgentComposer, { RunActivity } from "./AskPanel";
import { RunFeedbackControl } from "./RunFeedbackControl";
import { RunOutcomeSummary } from "./RunOutcomeSummary";
import {
  marketAgentAccessUrl,
  type AgentAskIntent,
  type AgentObservationView,
  type AgentRunMode,
  type AgentRunView,
} from "./client";
import { buildMarketReviewReport } from "./market-review-report";
import { portfolioActionLabel, runExportLabel } from "./action-state";
import { useMarketAgentWorkspace } from "./useMarketAgentWorkspace";

const date = (value: string) => new Date(value).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
export type InspectorSection = "context" | "evidence" | "outcome";
const inspectorSections: InspectorSection[] = ["context", "evidence", "outcome"];

export function nextInspectorSection(section: InspectorSection, key: string): InspectorSection | null {
  const index = inspectorSections.indexOf(section);
  if (key === "Home") return inspectorSections[0];
  if (key === "End") return inspectorSections.at(-1) ?? null;
  if (key === "ArrowRight" || key === "ArrowDown") return inspectorSections[(index + 1) % inspectorSections.length];
  if (key === "ArrowLeft" || key === "ArrowUp") return inspectorSections[(index - 1 + inspectorSections.length) % inspectorSections.length];
  return null;
}

export interface AgentScreenChrome {
  status: TradingScreenStatus;
  primaryAction: TradingScreenAction;
}

export interface AgentTodayProps {
  embedded?: boolean;
  selectedRunId?: string | null;
  selectedEvidenceId?: string | null;
  onSelectedRunChange?(runId: string): void;
  onSelectedEvidenceChange?(runId: string, evidenceId: string): void;
  onScreenChange?: (chrome: AgentScreenChrome) => void;
}

export async function submitAskAndSelectRun(
  intent: AgentAskIntent,
  submitAsk: (intent: AgentAskIntent) => Promise<string>,
  onSelectedRunChange?: (runId: string) => void,
): Promise<string> {
  const runId = await submitAsk(intent);
  onSelectedRunChange?.(runId);
  return runId;
}

export async function runReviewAndSelectRun(
  runReview: () => Promise<string | null>,
  onSelectedRunChange?: (runId: string) => void,
): Promise<string | null> {
  const runId = await runReview();
  if (runId) onSelectedRunChange?.(runId);
  return runId;
}

export async function restoreRoutedAgentSelection(
  route: {
    routedRunId?: string | null;
    routedEvidenceId?: string | null;
    latestRunId?: string | null;
  },
  selectRun: (runId: string) => Promise<void>,
  selectEvidence: (evidenceId: string | null) => void,
): Promise<void> {
  const runId = route.routedRunId
    ?? (route.routedRunId === null ? route.latestRunId : null);
  if (runId) await selectRun(runId);
  selectEvidence(route.routedEvidenceId ?? null);
}

export default function AgentToday({
  embedded = false,
  selectedRunId: routedRunId,
  selectedEvidenceId: routedEvidenceId,
  onSelectedRunChange,
  onSelectedEvidenceChange,
  onScreenChange,
}: AgentTodayProps = {}) {
  const { agent, watchlist, portfolio, commands } = useMarketAgentWorkspace();
  const [inspectorSection, setInspectorSection] = useState<InspectorSection>(routedEvidenceId ? "evidence" : "context");
  const inspectorRef = useRef<HTMLElement>(null);
  const {
    runs, latest, selectedRun, askInstruments, bootstrap, loading, reviewBusy, askBusy,
    streamingAnswer, error, accessRequired, setupNote, deletingRunId, loadingMoreRuns,
    hasMoreRuns, evidence, evidenceLoading, evidenceError, selectedEvidenceId,
    exportBusy, exportNote, exportError, trace, traceLoading, traceError, runControlBusy,
  } = agent;
  const { items: localWatchlist, syncing: syncBusy } = watchlist;
  const {
    preview: portfolioPreview, state: portfolioState, stateLoaded: portfolioStateLoaded,
    busy: portfolioBusy, action: portfolioAction, error: portfolioError,
    note: portfolioNote, purgeScope,
  } = portfolio;
  const {
    refresh, runReview, submitAsk, selectRun, selectEvidence, confirmWatchlist,
    downloadRuns, removeRun, loadMoreRuns, saveFeedback, refreshPortfolioPreview,
    syncLocalPortfolioSnapshot, stopUsingPortfolioSnapshot, requestPortfolioPurge,
    cancelPortfolioPurge, confirmPortfolioPurge,
    cancelRun, retryRun,
  } = commands;

  useEffect(() => {
    let cancelled = false;
    void restoreRoutedAgentSelection(
      {
        routedRunId,
        routedEvidenceId,
        latestRunId: latest?.id ?? null,
      },
      selectRun,
      (evidenceId) => {
        if (cancelled) return;
        selectEvidence(evidenceId);
        if (evidenceId) setInspectorSection("evidence");
      },
    );
    return () => { cancelled = true; };
  }, [latest?.id, routedEvidenceId, routedRunId, selectEvidence, selectRun]);

  useEffect(() => {
    if (!onScreenChange) return;
    const active = runs.find((run) => isCancellableRunStatus(run.status));
    const run = active ?? selectedRun ?? latest;
    onScreenChange({
      status: {
        tone: error ? "degraded" : active ? "neutral" : run ? "live" : "neutral",
        label: error ? "Agent 降级" : active ? statusLabel(active.status) : run ? "Run 可追溯" : "等待运行",
        detail: run ? `${date(run.updatedAt)} · ${modeLabel(run.result?.mode, run.portfolioSnapshotId)}` : "只读市场事实",
      },
      primaryAction: {
        label: "盘后复盘",
        pendingLabel: "排队中",
        pending: reviewBusy,
        disabled: bootstrap === "required" || Boolean(active),
        invoke: async () => { await runReviewAndSelectRun(runReview, onSelectedRunChange); },
      },
    });
  }, [bootstrap, error, latest, onScreenChange, onSelectedRunChange, reviewBusy, runReview, runs, selectedRun]);

  const openRun = (runId: string) => {
    void selectRun(runId);
    onSelectedRunChange?.(runId);
  };
  const openEvidence = (evidenceId: string) => {
    if (!selectedRun) return;
    selectEvidence(evidenceId);
    setInspectorSection("evidence");
    onSelectedEvidenceChange?.(selectedRun.id, evidenceId);
    requestAnimationFrame(() => {
      inspectorRef.current?.scrollIntoView({ block: "nearest" });
      inspectorRef.current?.focus({ preventScroll: true });
    });
  };

  return (
    <div className={embedded ? "agent-app agent-app--embedded" : "risk-app agent-app"}>
      <main className="risk-main agent-main">
        <header className="agent-command-header">
          <div><h1 className="agent-command-title">Market Agent</h1><p>选择一条 Run，在同一工作区继续提问、核对证据与结果边界。</p></div>
          <div><button type="button" onClick={() => void refresh()} disabled={loading}>{loading ? "读取中" : "刷新"}</button><span>{selectedRun ? `当前 Run ${selectedRun.id.slice(0, 8)}` : "尚无运行记录"}</span></div>
        </header>
        <AgentErrorNotice error={error} accessRequired={accessRequired} />
        {bootstrap === "required" && <BootstrapPanel items={localWatchlist} syncing={syncBusy} onConfirm={confirmWatchlist} />}
        {setupNote && <p className="agent-setup-note">{setupNote}</p>}

        <section className="agent-run-workspace" aria-label="Market Agent Run 工作区">
          <RunNavigator
            runs={runs}
            selectedRunId={selectedRun?.id ?? null}
            onSelect={openRun}
            onExport={downloadRuns}
            onLoadMore={loadMoreRuns}
            exportBusy={exportBusy}
            exportNote={exportError ?? exportNote}
            hasMore={hasMoreRuns}
            loadingMore={loadingMoreRuns}
          />
          <section className="agent-run-canvas" aria-label="当前 Run">
            <SelectedRunView
              run={selectedRun}
              evidence={evidence}
              evidenceLoading={evidenceLoading}
              streamingAnswer={streamingAnswer}
              trace={trace}
              traceLoading={traceLoading}
              traceError={traceError}
              controlBusy={selectedRun && runControlBusy?.runId === selectedRun.id ? runControlBusy.action : null}
              controlsDisabled={Boolean(runControlBusy)}
              onCancel={() => selectedRun ? cancelRun(selectedRun.id) : Promise.resolve()}
              onRetry={selectedRun && !selectedRun.payloadPurgedAt ? async () => {
                if (!selectedRun) return;
                const runId = await retryRun(selectedRun.id);
                onSelectedRunChange?.(runId);
              } : undefined}
              onEvidence={openEvidence}
            />
            <AgentComposer
              runs={runs}
              instruments={askInstruments}
              selectedRun={selectedRun}
              submitting={askBusy}
              onSubmit={(intent) => submitAskAndSelectRun(intent, submitAsk, onSelectedRunChange)}
            />
          </section>
          <RunInspector
            inspectorRef={inspectorRef}
            run={selectedRun}
            evidence={evidence}
            evidenceLoading={evidenceLoading}
            evidenceError={evidenceError}
            selectedEvidenceId={selectedEvidenceId}
            timing={trace?.timing ?? selectedRun?.timing}
            section={inspectorSection}
            onSectionChange={setInspectorSection}
            onEvidence={openEvidence}
            onFeedback={(value) => selectedRun ? saveFeedback(selectedRun.id, value) : Promise.reject(new Error("当前没有可反馈的 Run。"))}
            onDelete={() => selectedRun ? void removeRun(selectedRun) : undefined}
            deleting={Boolean(selectedRun && deletingRunId === selectedRun.id)}
          />
        </section>

        <PortfolioSettings
          preview={portfolioPreview}
          state={portfolioState}
          stateLoaded={portfolioStateLoaded}
          busy={portfolioBusy}
          action={portfolioAction}
          error={portfolioError}
          note={portfolioNote}
          purgeScope={purgeScope}
          onRefresh={refreshPortfolioPreview}
          onSync={syncLocalPortfolioSnapshot}
          onStop={stopUsingPortfolioSnapshot}
          onRequestPurge={requestPortfolioPurge}
          onCancelPurge={cancelPortfolioPurge}
          onConfirmPurge={confirmPortfolioPurge}
        />
      </main>
      {!embedded && <footer className="risk-footer"><span>zxlab / agent</span><p>Market Agent 只读市场事实，不连接交易执行。</p><a href="/lab/market">Market Center</a></footer>}
    </div>
  );
}

export function AgentErrorNotice({ error, accessRequired }: { error: string | null; accessRequired: boolean }) {
  if (!error) return null;
  return <div className="review-status review-status--warning agent-access-warning" role="status"><span>{error}</span>{accessRequired && <a href={marketAgentAccessUrl} target="_blank" rel="noreferrer">重新授权</a>}</div>;
}

function BootstrapPanel({ items, syncing, onConfirm }: { items: Array<{ instrumentId: string; reason?: string }>; syncing: boolean; onConfirm(): Promise<void> }) {
  return <section className="agent-bootstrap" aria-label="观察列表启动"><div><p>观察范围尚未确认</p><h2>先确认本机 Market Center 的观察列表。</h2><span>只同步标的和关注理由，不上传交易账本。</span></div><div className="agent-bootstrap__items">{items.map((item) => <div key={item.instrumentId}><code>{item.instrumentId}</code><span>{item.reason ?? "自选标的"}</span></div>)}</div><button onClick={() => void onConfirm()} disabled={syncing || !items.length}>{syncing ? "正在同步" : `确认 ${items.length} 个标的`}</button></section>;
}

export function RunNavigator({ runs, selectedRunId, onSelect, onExport, onLoadMore, exportBusy, exportNote, hasMore, loadingMore }: {
  runs: AgentRunView[]; selectedRunId: string | null; onSelect(id: string): void; onExport(): Promise<void>; onLoadMore(): Promise<void>;
  exportBusy: boolean; exportNote: string | null; hasMore: boolean; loadingMore: boolean;
}) {
  return <aside className="agent-run-navigator" aria-label="运行记录"><header><div><h2>运行记录</h2><span>{runs.length}</span></div><button type="button" onClick={() => void onExport()} disabled={!runs.length || exportBusy}>{runExportLabel(exportBusy)}</button></header><div className="agent-run-navigator__list">{runs.length ? runs.map((run) => <button type="button" key={run.id} className="agent-run-nav-item" aria-current={selectedRunId === run.id ? "true" : undefined} onClick={() => onSelect(run.id)}><span><i className={`agent-run-nav-item__status agent-status--${run.status}`}>{statusLabel(run.status)}</i><time dateTime={run.createdAt}>{date(run.createdAt)}</time></span><strong>{run.payloadPurgedAt ? "正文已清除" : run.result?.headline ?? runLabel(run)}</strong><small>{run.input?.question ?? modeLabel(run.result?.mode, run.portfolioSnapshotId)}{run.timing ? ` · ${compactDuration(run.timing.durationMs ?? run.timing.elapsedMs)}` : ""}</small></button>) : <div className="agent-run-navigator__empty"><strong>还没有 Run</strong><p>开始一次盘后复盘或受限问答后，记录会出现在这里。</p></div>}</div>{hasMore && <button type="button" className="agent-run-navigator__more" onClick={() => void onLoadMore()} disabled={loadingMore}>{loadingMore ? "读取中" : "加载更早记录"}</button>}<p className="agent-run-navigator__note" aria-live="polite">{exportNote ?? "历史选择不会创建第二套回答状态。"}</p></aside>;
}

function SelectedRunView({ run, evidence, evidenceLoading, streamingAnswer, trace, traceLoading, traceError, controlBusy, controlsDisabled, onCancel, onRetry, onEvidence }: {
  run?: AgentRunView;
  evidence: SealedEvidenceBundle | null;
  evidenceLoading: boolean;
  streamingAnswer: string;
  trace: ReturnType<typeof useMarketAgentWorkspace>["agent"]["trace"];
  traceLoading: boolean;
  traceError: string | null;
  controlBusy: "cancel" | "retry" | null;
  controlsDisabled: boolean;
  onCancel(): Promise<unknown>;
  onRetry?(): Promise<unknown>;
  onEvidence(id: string): void;
}) {
  if (!run) return <section className="agent-selected-empty"><strong>选择或建立一条 Run</strong><p>报告、输入上下文、Evidence 与 Outcome 将围绕同一个 Run 展示。</p></section>;
  const report = run.result ? buildMarketReviewReport(run.result) : null;
  return <article className="agent-selected-run">
    <header className="agent-selected-run__header"><div><span className={`agent-status agent-status--${run.status}`}>{statusLabel(run.status)}</span><h2>{report?.conclusion.headline ?? (streamingAnswer ? "正在形成研究报告" : runLabel(run))}</h2><p>{runPrompt(run)}</p>{run.revisionOfRunId && <p className="agent-selected-run__revision">重试自 Run <span title={run.revisionOfRunId}>{run.revisionOfRunId.slice(0, 8)}</span></p>}</div><dl><div><dt>时间</dt><dd>{date(run.createdAt)}</dd></div><div><dt>模式</dt><dd>{modeLabel(run.result?.mode, run.portfolioSnapshotId)}</dd></div></dl></header>
    <RunActivity status={run.status} runId={run.id} trace={trace} timing={run.timing} limitations={run.result?.limitations} outcome={run.result?.outcome} traceLoading={traceLoading} traceError={traceError} controlBusy={controlBusy} controlsDisabled={controlsDisabled} onCancel={onCancel} onRetry={onRetry} />
    {!run.payloadPurgedAt && run.result && <MarketReferenceSummary evidence={evidence} loading={evidenceLoading} outcome={run.result.outcome} retrying={controlBusy === "retry"} disabled={controlsDisabled} onRetry={onRetry} />}
    {run.payloadPurgedAt ? <div className="agent-selected-run__state"><strong>正文与 Evidence 已清除</strong><p>审计 fingerprint 仍保留：{run.evidenceFingerprint ?? "未形成"}</p></div> : report ? <ResearchReport report={report} onEvidence={onEvidence} /> : streamingAnswer ? <p className="agent-streamed-answer agent-selected-run__stream">{streamingAnswer}<span className="agent-stream-cursor" aria-hidden="true" /></p> : <div className="agent-selected-run__state"><strong>{run.status === "failed" ? "本次 Run 未能完成" : run.status === "cancelled" ? "本次 Run 已取消" : "确定性事实正在处理"}</strong><p>{run.status === "failed" ? `失败代码：${run.failure?.code ?? "未提供"}` : run.status === "cancelled" ? "原始记录与取消事件已保留；可以从这条 Run 发起一次可追溯的重试。" : "结果只有在 Evidence 封存并通过校验后才会显示。"}</p></div>}
  </article>;
}

export function ResearchReport({ report, onEvidence }: { report: ResearchReportV2; onEvidence(id: string): void }) {
  const sourceIndex = useMemo(() => new Map(report.sources.map((source, index) => [source.evidenceId, index + 1])), [report.sources]);
  const reportRef = useRef<HTMLElement>(null);
  useAgentRevealMotion(reportRef, `${report.conclusion.headline}:${report.factBlocks?.length ?? "legacy"}:${report.sources.length}`, ":scope > section, :scope > .research-report-v2__sources");
  return <article ref={reportRef} className="research-report-v2" aria-label="Research Report v2">
    <section className="research-report-v2__lead"><span>{report.version}</span><h3>结论</h3><p>{report.conclusion.summary}</p><CitationButtons ids={report.conclusion.evidenceIds} sourceIndex={sourceIndex} onEvidence={onEvidence} /></section>
    <FactBlockSection blocks={report.factBlocks} sourceIndex={sourceIndex} onEvidence={onEvidence} />
    <ReportObservationSection title="依据" description="可由封存事实直接支持的内容" items={report.basis} sourceIndex={sourceIndex} onEvidence={onEvidence} />
    <ReportObservationSection title="推演" description="事实与持仓含义之间的解释；推断保留不确定性" items={report.analysis} sourceIndex={sourceIndex} onEvidence={onEvidence} />
    <section className="research-report-v2__section"><header><div><h3>风险与数据边界</h3><p>未知项和缺失能力不会由模型补齐</p></div><span>{report.risks.length}</span></header>{report.risks.length ? <div className="research-report-v2__items">{report.risks.map((item) => <article key={item.id} data-kind={item.kind}><strong>{item.title}</strong><p>{item.explanation}</p><CitationButtons ids={item.evidenceIds} sourceIndex={sourceIndex} onEvidence={onEvidence} /></article>)}</div> : <p className="research-report-v2__empty">本次没有额外风险项。</p>}</section>
    <section className="research-report-v2__section"><header><div><h3>后续观察</h3><p>条件发生时再重新运行，不把观察条件写成交易指令</p></div><span>{report.watchNext.length}</span></header>{report.watchNext.length ? <ol className="research-report-v2__watch">{report.watchNext.map((item, index) => <li key={`${item.condition}-${index}`}><strong>{item.condition}</strong><p>{item.reason}</p><CitationButtons ids={item.evidenceIds} sourceIndex={sourceIndex} onEvidence={onEvidence} /></li>)}</ol> : <p className="research-report-v2__empty">本次没有形成新的观察条件。</p>}</section>
    <section className="research-report-v2__sources"><header><h3>来源引用</h3><span>{report.sources.length}</span></header>{report.sources.length ? <ol>{report.sources.map((source, index) => <li key={source.evidenceId}><button type="button" onClick={() => onEvidence(source.evidenceId)}><span>{index + 1}</span><strong>{source.providers?.join("、") || source.kind || "sealed evidence"}</strong><small>{source.asOf ? date(source.asOf) : source.reliable === false ? "可靠性受限" : "已封存"}</small></button></li>)}</ol> : <p className="research-report-v2__empty">历史结果没有可恢复的来源元数据。</p>}</section>
  </article>;
}

export function MarketReferenceSummary({ evidence, loading = false, outcome, retrying = false, disabled = false, onRetry }: {
  evidence: SealedEvidenceBundle | null;
  loading?: boolean;
  outcome?: AgentResult["outcome"];
  retrying?: boolean;
  disabled?: boolean;
  onRetry?(): Promise<unknown>;
}) {
  const referenceRef = useRef<HTMLElement>(null);
  const context = marketReferenceContext(evidence);
  const motionKey = context.reference ? `${context.reference.requestedCalendarDate}:${context.reference.effectiveTradingDate ?? "unresolved"}` : evidence ? "legacy" : "loading";
  useAgentRevealMotion(referenceRef, motionKey, ":scope > *");
  if (loading && !evidence) return <section ref={referenceRef} className="agent-market-reference" aria-label="数据口径"><p>正在读取本次 Run 的数据口径。</p></section>;
  if (evidence && !context.reference) return <section ref={referenceRef} className="agent-market-reference agent-market-reference--legacy" aria-label="数据口径"><div><strong>旧版口径</strong><p>这条历史 Run 没有封存 MarketReference，无法证明“当日”对应的有效交易日。历史结果不会被改写。</p></div><dl><ReferenceField label="Freshness" value={context.freshness ?? "未固化"} /><ReferenceField label="Evidence coverage" value={outcome?.evidence.coverage ?? "未形成"} /><ReferenceField label="Delivery" value={outcome?.evidence.delivery ?? "未形成"} /></dl>{onRetry && <button type="button" onClick={() => void onRetry()} disabled={disabled || retrying}>{retrying ? "正在按当前口径重试" : "按当前口径重试"}</button>}</section>;
  if (!context.reference) return null;
  const reference = context.reference;
  const equivalent = Boolean(reference.effectiveTradingDate && reference.requestedCalendarDate !== reference.effectiveTradingDate);
  return <section ref={referenceRef} className="agent-market-reference" aria-label="数据口径"><div><strong>本次数据口径</strong><p>{equivalent && reference.effectiveTradingDate ? `系统按最近有效交易日 ${dateOnly(reference.effectiveTradingDate)} 解释“当日”；休市不等于数据降级。` : reference.effectiveTradingDate ? "请求日期与有效交易日一致。" : "有效交易日未解析，不作当日行情断言。"}</p></div><dl><ReferenceField label="数据日期" value={reference.effectiveTradingDate ? dateOnly(reference.effectiveTradingDate) : "未解析"} /><ReferenceField label="周末等效" value={equivalent && reference.effectiveTradingDate ? `${dateOnly(reference.requestedCalendarDate)} → ${dateOnly(reference.effectiveTradingDate)}` : "不适用"} /><ReferenceField label="Session" value={reference.session} /><ReferenceField label="Freshness" value={context.freshness ?? "未提供"} /><ReferenceField label="Evidence coverage" value={outcome?.evidence.coverage ?? "未形成"} /><ReferenceField label="Delivery" value={outcome?.evidence.delivery ?? "未形成"} /></dl><small>{reference.semantics}</small></section>;
}

function useAgentRevealMotion(ref: React.RefObject<HTMLElement | null>, key: string, selector: string) {
  useEffect(() => {
    const root = ref.current;
    if (!root || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const context = gsap.context(() => {
      gsap.fromTo(root.querySelectorAll(selector), { autoAlpha: 0, y: 12 }, { autoAlpha: 1, y: 0, duration: 0.42, stagger: 0.035, ease: "power3.out", overwrite: "auto" });
    }, root);
    return () => context.revert();
  }, [key, ref, selector]);
}

function FactBlockSection({ blocks, sourceIndex, onEvidence }: { blocks: ResearchReportV2["factBlocks"]; sourceIndex: Map<string, number>; onEvidence(id: string): void }) {
  if (blocks === undefined) return <section className="research-report-v2__section research-report-v2__facts" data-legacy="true"><header><div><h3>确定性 Fact Blocks</h3><p>这条旧 Run 尚未固化结构化事实块；原始 Evidence 仍按历史记录保留。</p></div><span>旧版</span></header></section>;
  return <section className="research-report-v2__section research-report-v2__facts"><header><div><h3>确定性 Fact Blocks</h3><p>数字直接来自封存的 Research Fact Plane；模型不计算、不补齐。</p></div><span>{blocks.length}</span></header>{blocks.length ? <div className="research-report-v2__fact-grid">{blocks.map((block) => <FactBlock key={block.id} block={block} sourceIndex={sourceIndex} onEvidence={onEvidence} />)}</div> : <p className="research-report-v2__empty">本次 scope 没有形成可展示的确定性数值事实。</p>}</section>;
}

function FactBlock({ block, sourceIndex, onEvidence }: { block: ResearchReportFactBlock; sourceIndex: Map<string, number>; onEvidence(id: string): void }) {
  return <article className="research-report-v2__fact" data-reliable={block.quality.reliable}><header><div><span>{factKindLabel(block.kind)}</span><strong>{block.title}</strong></div><small>{block.quality.reliable ? "可靠" : "受限"}</small></header><div className="research-report-v2__metrics">{block.metrics.map((metric) => <FactMetric key={`${block.id}:${metric.key}`} metric={metric} />)}</div>{block.context.length > 0 && <dl className="research-report-v2__fact-context">{block.context.map((item) => <ReferenceField key={`${item.label}:${item.value}`} label={item.label} value={factContextValue(item.value)} />)}</dl>}<div className="research-report-v2__fact-meta"><span>as-of {date(block.provenance.sourceAsOf)}</span><span>{block.provenance.providers.join("、")}</span></div><details><summary>公式与 provenance</summary><dl><ReferenceField label="Fact ID" value={block.factId} /><ReferenceField label="Plan" value={block.provenance.planVersion} /><ReferenceField label="as-of" value={block.provenance.sourceAsOf} /><ReferenceField label="retrieved" value={block.provenance.retrievedAt} /><ReferenceField label="Provider" value={block.provenance.providers.join("、")} /><ReferenceField label="Source artifacts" value={block.provenance.sourceArtifactIds.join("、")} /><ReferenceField label="Research fingerprint" value={block.provenance.researchFingerprint} /><ReferenceField label="Coverage" value={`${block.quality.coverage.actual}/${block.quality.coverage.required}`} /></dl>{block.metrics.map((metric) => metric.formula ? <article key={`${block.id}:${metric.key}:formula`}><strong>{metric.label} · {metric.formula.id}@{metric.formula.version}</strong><code>{metric.formula.expression}</code><small>{Object.entries(metric.formula.parameters).map(([key, value]) => `${key}=${value}`).join(" · ")} · rounding={metric.formula.rounding}</small></article> : <p key={`${block.id}:${metric.key}:formula`}>{metric.label}为来源原值，无确定性派生公式。</p>)}</details><CitationButtons ids={[block.evidenceId]} sourceIndex={sourceIndex} onEvidence={onEvidence} /></article>;
}

function FactMetric({ metric }: { metric: ResearchReportFactMetric }) { return <div><span>{metric.label}</span><strong>{metric.decimal}</strong><small>{factUnitLabel(metric.unit)}</small></div>; }

function ReferenceField({ label, value }: { label: string; value: string }) { return <div><dt>{label}</dt><dd>{value}</dd></div>; }

function ReportObservationSection({ title, description, items, sourceIndex, onEvidence }: { title: string; description: string; items: AgentObservationView[]; sourceIndex: Map<string, number>; onEvidence(id: string): void }) {
  return <section className="research-report-v2__section"><header><div><h3>{title}</h3><p>{description}</p></div><span>{items.length}</span></header>{items.length ? <div className="research-report-v2__items">{items.map((item) => <article key={item.id} data-kind={item.class}><div><span>{observationLabel(item.class)}</span><strong>{item.title}</strong></div><p>{item.explanation}</p><CitationButtons ids={item.evidenceIds} sourceIndex={sourceIndex} onEvidence={onEvidence} /></article>)}</div> : <p className="research-report-v2__empty">本次没有可确认的{title}。</p>}</section>;
}

function CitationButtons({ ids, sourceIndex, onEvidence }: { ids: string[]; sourceIndex: Map<string, number>; onEvidence(id: string): void }) {
  if (!ids.length) return null;
  return <div className="research-report-v2__citations" aria-label="来源引用">{ids.map((id) => <button type="button" key={id} title={id} onClick={() => onEvidence(id)}>来源 {sourceIndex.get(id) ?? "—"}</button>)}</div>;
}

function RunInspector({ inspectorRef, run, evidence, evidenceLoading, evidenceError, selectedEvidenceId, timing, section, onSectionChange, onEvidence, onFeedback, onDelete, deleting }: {
  inspectorRef: React.Ref<HTMLElement>;
  run?: AgentRunView; evidence: SealedEvidenceBundle | null; evidenceLoading: boolean; evidenceError: string | null; selectedEvidenceId: string | null; section: InspectorSection;
  timing?: RunTiming; onSectionChange(section: InspectorSection): void; onEvidence(id: string): void; onFeedback(value: AgentFeedbackValue): Promise<AgentFeedback>; onDelete(): void; deleting: boolean;
}) {
  const selectedEvidence = evidence?.items.find((item) => item.id === selectedEvidenceId) ?? null;
  return <aside ref={inspectorRef} tabIndex={-1} className="agent-run-inspector" aria-label="Run Inspector"><header><div><h2>Inspector</h2><span>{run ? run.id.slice(0, 8) : "未选择"}</span></div><div role="tablist" aria-label="检查器内容">{inspectorSections.map((tab) => <button type="button" role="tab" id={`agent-inspector-tab-${tab}`} aria-controls="agent-inspector-panel" tabIndex={section === tab ? 0 : -1} key={tab} aria-selected={section === tab} onClick={() => onSectionChange(tab)} onKeyDown={(event) => {
      const next = nextInspectorSection(section, event.key);
      if (!next) return;
      event.preventDefault();
      onSectionChange(next);
      requestAnimationFrame(() => document.getElementById(`agent-inspector-tab-${next}`)?.focus());
    }}>{({ context: "Context", evidence: "Evidence", outcome: "Outcome" } as const)[tab]}</button>)}</div></header>
    <div className="agent-run-inspector__body" role="tabpanel" id="agent-inspector-panel" aria-labelledby={`agent-inspector-tab-${section}`} tabIndex={0}>
      {!run ? <p className="agent-inspector-empty">选择一条 Run 后查看输入、证据与结果。</p> : section === "context" ? <ContextPanel run={run} evidence={evidence} /> : section === "evidence" ? <EvidencePanel evidence={evidence} loading={evidenceLoading} error={evidenceError} selected={selectedEvidence} onSelect={onEvidence} /> : <OutcomePanel run={run} timing={timing} onFeedback={onFeedback} onDelete={onDelete} deleting={deleting} />}
    </div>
  </aside>;
}

function ContextPanel({ run, evidence }: { run: AgentRunView; evidence: SealedEvidenceBundle | null }) {
  const input = run.input;
  return <section className="agent-inspector-panel"><h3>本次输入上下文</h3>{run.payloadPurgedAt ? <p className="agent-inspector-empty">输入正文已按保留策略清除。</p> : <dl><InspectorField label="Workflow" value={run.workflow} /><InspectorField label="Trigger" value={run.trigger ?? "未提供"} /><InspectorField label="重试来源" value={run.revisionOfRunId ?? "原始 Run"} /><InspectorField label="Ask scope" value={input?.askScope ?? run.result?.askScope ?? "不适用"} /><InspectorField label="标的" value={input?.instrumentId ?? evidence?.instrumentIds.join("、") ?? "未恢复"} /><InspectorField label="问题" value={input?.question ?? "未提供自定义问题"} /><InspectorField label="历史 Run" value={input?.priorRunId ?? evidence?.ask?.priorRunId ?? "不适用"} /><InspectorField label="持仓快照" value={run.portfolioSnapshotId ?? "未使用"} /><InspectorField label="观察列表 revision" value={evidence?.watchlistRevision ?? "Evidence 尚未读取"} /><InspectorField label="确认上下文" value={evidence ? `${evidence.contextUses.length} 条引用` : "Evidence 尚未读取"} /><InspectorField label="封存时间" value={evidence?.sealedAt ? date(evidence.sealedAt) : "尚未封存"} /></dl>}</section>;
}

function EvidencePanel({ evidence, loading, error, selected, onSelect }: { evidence: SealedEvidenceBundle | null; loading: boolean; error: string | null; selected: SealedEvidenceBundle["items"][number] | null; onSelect(id: string): void }) {
  if (loading) return <p className="agent-inspector-empty" aria-live="polite">正在读取这条 Run 的封存 Evidence。</p>;
  if (error) return <p className="agent-inspector-error" role="status">{error}</p>;
  if (!evidence) return <p className="agent-inspector-empty">这条 Run 尚无可读取的 Evidence。</p>;
  return <section className="agent-inspector-panel"><h3>封存证据</h3><dl><InspectorField label="Fingerprint" value={evidence.fingerprint} /><InspectorField label="范围" value={evidence.instrumentIds.join("、") || "未提供"} /><InspectorField label="条目" value={`${evidence.items.length} 条`} /></dl><div className="agent-inspector-evidence-list">{evidence.items.map((item, index) => <button type="button" key={item.id} aria-pressed={selected?.id === item.id} onClick={() => onSelect(item.id)}><span>{index + 1}</span><strong>{evidenceKindLabel(item.kind)}</strong><small>{item.reliable ? "可靠" : "受限"}</small></button>)}</div>{selected && <article className="agent-inspector-evidence-detail"><header><strong>{selected.id}</strong><span>{selected.origin} · {selected.reliable ? "可靠" : "受限"}</span></header><pre>{formatEvidenceValue(selected.value)}</pre></article>}</section>;
}

function OutcomePanel({ run, timing, onFeedback, onDelete, deleting }: { run: AgentRunView; timing?: RunTiming; onFeedback(value: AgentFeedbackValue): Promise<AgentFeedback>; onDelete(): void; deleting: boolean }) {
  const outcome = run.result?.outcome;
  return <section className="agent-inspector-panel"><h3>运行结果</h3><RunOutcomeSummary outcome={outcome} /><dl><InspectorField label="Status" value={statusLabel(run.status)} /><InspectorField label="Attempt" value={String(run.attempt ?? "未提供")} /><InspectorField label="Recovery" value={String(run.recoveryGeneration ?? "未提供")} /><InspectorField label="总耗时" value={timing ? compactDuration(timing.durationMs ?? timing.elapsedMs) : "未提供"} /><InspectorField label="Narration" value={outcome?.narration.source ?? "未形成"} /><InspectorField label="Provider" value={outcome?.narration.provider ?? "未提供"} /><InspectorField label="Model" value={outcome?.narration.model ?? "未提供"} /><InspectorField label="Evidence coverage" value={outcome?.evidence.coverage ?? "未形成"} /><InspectorField label="Failure" value={run.failure?.code ?? outcome?.narration.failure?.code ?? "无"} /></dl>{run.result && !run.payloadPurgedAt && <div className="agent-inspector-feedback"><h4>这条报告是否有帮助</h4><RunFeedbackControl key={run.id} runId={run.id} feedback={run.feedback} onSubmit={onFeedback} /></div>}<p className="agent-inspector-boundary">主栏仅展示服务端持久化的 RunTraceEvent、阶段耗时和可验证的重试/取消事件；不会展示或模拟私密思考过程。</p><button type="button" className="agent-inspector-delete" onClick={onDelete} disabled={deleting || Boolean(run.payloadPurgedAt)}>{run.payloadPurgedAt ? "正文已清除" : deleting ? "正在清除" : "清除正文与 Evidence"}</button></section>;
}

function InspectorField({ label, value }: { label: string; value: string }) { return <div><dt>{label}</dt><dd>{value}</dd></div>; }

function PortfolioSettings({ preview, state, stateLoaded, busy, action, error, note, purgeScope, onRefresh, onSync, onStop, onRequestPurge, onCancelPurge, onConfirmPurge }: {
  preview: ReturnType<ReturnType<typeof useMarketAgentWorkspace>["commands"]["refreshPortfolioPreview"]> | null;
  state: ReturnType<typeof useMarketAgentWorkspace>["portfolio"]["state"];
  stateLoaded: boolean; busy: boolean; action: ReturnType<typeof useMarketAgentWorkspace>["portfolio"]["action"]; error: string | null; note: string | null;
  purgeScope: "all" | "expired" | null; onRefresh(): unknown; onSync(): Promise<void>; onStop(): Promise<void>; onRequestPurge(scope: "all" | "expired"): void; onCancelPurge(): void; onConfirmPurge(): Promise<void>;
}) {
  return <details className="agent-context"><summary><div><strong>下一次 Run 的环境设置</strong><span>{state?.snapshot ? "持仓感知" : "仅市场"}</span></div><small>当前配置不会替代历史 Run 的真实 Context</small></summary><section className="agent-portfolio" aria-label="持仓快照设置">{error && <p className="review-status review-status--warning">{error}</p>}{note && <p className="agent-portfolio__note" aria-live="polite">{note}</p>}<div className="agent-portfolio__grid"><article className="agent-portfolio__local"><header><div><span>本机预览</span><strong>{preview?.upload ? "可同步" : "需要处理"}</strong></div><button type="button" onClick={onRefresh} disabled={busy}>重新检查</button></header>{preview?.upload ? <><dl><div><dt>确认时间</dt><dd>{date(preview.upload.calculatedAt)}</dd></div><div><dt>持仓数量</dt><dd>{preview.positionCount} 个标的</dd></div><div><dt>汇总现金</dt><dd>{formatCash(preview.cash)}</dd></div><div><dt>失效时间</dt><dd>{date(preview.upload.expiresAt)}</dd></div></dl><button type="button" className="agent-portfolio__primary" onClick={() => void onSync()} disabled={busy}>{portfolioActionLabel(action, "sync")}</button></> : <div className="agent-portfolio__issues">{preview?.issues.map((issue) => <p key={issue}>{issue}</p>) ?? <p>正在检查本机快照。</p>}</div>}</article><article className="agent-portfolio__server"><header><div><span>Agent 使用状态</span><strong>{!stateLoaded ? "读取中" : error ? "状态不可用" : state?.snapshot ? "持仓感知" : "仅市场"}</strong></div>{state?.snapshot && <button type="button" className="agent-portfolio__stop" onClick={() => void onStop()} disabled={busy}>{portfolioActionLabel(action, "stop")}</button>}</header>{state?.snapshot ? <dl><div><dt>已同步标的</dt><dd>{state.snapshot.positions.length} 个</dd></div><div><dt>服务端失效时间</dt><dd>{date(state.snapshot.expiresAt)}</dd></div><div><dt>字段状态</dt><dd>{state.snapshot.reliable ? "完整" : "受限"}</dd></div><div><dt>当前规则</dt><dd>{state.snapshot.rulesVersion}</dd></div></dl> : <p className="agent-portfolio__empty">后续 Run 将只读取市场证据。</p>}<div className="agent-portfolio__history"><span>历史 {state?.historicalSnapshotCount ?? 0} 份快照 / {state?.linkedRunCount ?? 0} 条关联 Run</span><div><button type="button" onClick={() => onRequestPurge("expired")} disabled={busy || !(state?.expiredSnapshotCount ?? 0)}>清除已过期</button><button type="button" onClick={() => onRequestPurge("all")} disabled={busy || !(state?.historicalSnapshotCount ?? 0)}>清除全部历史</button></div></div></article></div>{purgeScope && <aside className="agent-portfolio__purge"><div><strong>确认清除{purgeScope === "expired" ? "已过期" : "全部"}持仓快照历史</strong><p>此操作不可恢复，审计墓碑会保留。</p></div><div><button type="button" onClick={onCancelPurge} disabled={busy}>取消</button><button type="button" className="agent-portfolio__purge-confirm" onClick={() => void onConfirmPurge()} disabled={busy}>{portfolioActionLabel(action, "purge")}</button></div></aside>}</section></details>;
}

function runPrompt(run: AgentRunView) { if (run.workflow !== "ask") return run.workflow === "morning_brief" ? "生成盘前简报" : "执行盘后市场复盘"; return run.input?.question ?? scopeLabel(run.input?.askScope ?? run.result?.askScope); }
function runLabel(run: AgentRunView) { return run.workflow === "ask" ? `受限问答：${scopeLabel(run.input?.askScope ?? run.result?.askScope)}` : run.workflow === "morning_brief" ? "盘前市场简报" : "盘后市场复盘"; }
function scopeLabel(scope?: string) { return ({ today_change: "当日变化", relative_performance: "相对表现", news_and_announcements: "新闻与公告", data_quality: "数据质量", portfolio_impact: "持仓影响", compare_previous_run: "比较历史 Run" } as Record<string, string>)[scope ?? ""] ?? "固定证据范围"; }
function statusLabel(status: string) { return ({ queued: "排队中", collecting: "收集事实", evidence_sealed: "Evidence 已封存", generating: "生成中", validating: "校验中", success: "完成", partial: "部分完成", failed: "失败", retry_wait: "等待重试", cancelled: "已取消" } as Record<string, string>)[status] ?? status; }
function modeLabel(mode?: AgentRunMode, portfolioSnapshotId?: string | null) { if (mode === "portfolio-aware") return "持仓感知"; if (mode === "market-only") return "仅市场"; return portfolioSnapshotId ? "待持仓校验" : "待市场校验"; }
function observationLabel(value: AgentObservationView["class"]) { return ({ fact: "事实", inference: "推断", unknown: "未知" } as const)[value]; }
function evidenceKindLabel(kind: string) { return ({ market_fact: "市场事实", market_event: "市场事件", snapshot_diff: "快照差分", portfolio_impact: "持仓影响", confirmed_context: "确认上下文", limitation: "数据边界", execution_plan: "执行计划", prior_run: "历史 Run" } as Record<string, string>)[kind] ?? kind; }
function factKindLabel(kind: ResearchReportFactBlock["kind"]) { return ({ instrument_mapping: "标的映射", market_baseline: "市场基线", financial_metric: "财务指标", valuation: "估值" } as const)[kind]; }
function factUnitLabel(unit: ResearchReportFactMetric["unit"]) { return ({ CNY: "人民币", ratio: "比率", shares: "股" } as const)[unit]; }
function factContextValue(value: string) { return value.replace(/T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, (timestamp) => date(timestamp)); }
function dateOnly(value: string) { const parsed = new Date(value); return Number.isFinite(parsed.getTime()) ? parsed.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }) : value; }
function marketReferenceContext(evidence: SealedEvidenceBundle | null): { reference: MarketReference | null; freshness: string | null } {
  if (!evidence) return { reference: null, freshness: null };
  for (const item of evidence.items) {
    const value = uiRecord(item.value);
    if (value?.type !== "snapshot_context") continue;
    const quality = uiRecord(value.quality);
    const freshness = typeof quality?.freshness === "string" ? quality.freshness : null;
    return { reference: isMarketReference(value.reference) ? { ...value.reference } : null, freshness };
  }
  return { reference: null, freshness: null };
}
function uiRecord(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function formatEvidenceValue(value: unknown) { const text = JSON.stringify(value, null, 2) ?? String(value); return text.length > 4_000 ? `${text.slice(0, 4_000)}\n[truncated]` : text; }
function formatCash(value: number | null) { return value === null ? "—" : new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", maximumFractionDigits: 2 }).format(value); }
function compactDuration(milliseconds: number) { if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`; if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)}s`; return `${Math.floor(milliseconds / 60_000)}m ${Math.floor((milliseconds % 60_000) / 1_000)}s`; }
