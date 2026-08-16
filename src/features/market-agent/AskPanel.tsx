import React, { useEffect, useMemo, useRef, useState } from "react";
import { isCancellableRunStatus, isRetryableRunStatus, type AskScope, type RunOutcome, type RunTiming, type RunTrace, type RunTraceEvent } from "@zxlab/market-agent-schema";
import type { AgentAskIntent, AgentRunView } from "./client";

interface AskScopeOption {
  id: AskScope;
  label: string;
  description: string;
  requiresInstrument?: boolean;
  requiresPreviousRun?: boolean;
}

const askScopes: AskScopeOption[] = [
  { id: "today_change", label: "当日变化", description: "读取所选标的最近一个有效交易日的确定性行情与变化。", requiresInstrument: true },
  { id: "relative_performance", label: "相对表现", description: "把所选标的与已确认观察范围进行确定性比较。", requiresInstrument: true },
  { id: "news_and_announcements", label: "新闻与公告", description: "只读取已收集的新闻与公告材料。", requiresInstrument: true },
  { id: "data_quality", label: "数据质量", description: "检查所选标的或观察范围的数据可用性。" },
  { id: "portfolio_impact", label: "持仓影响", description: "只使用当前仍有效的持仓快照。" },
  { id: "compare_previous_run", label: "比较历史 Run", description: "固定复用一条已封存 Run 的完整证据范围。", requiresPreviousRun: true },
];

export interface AgentComposerProps {
  runs: AgentRunView[];
  instruments: string[];
  selectedRun?: AgentRunView;
  submitting: boolean;
  onSubmit(intent: AgentAskIntent): Promise<unknown>;
}

export function composerDraftFromRun(run?: AgentRunView) {
  const input = run?.input;
  return {
    scope: (input?.askScope ?? run?.result?.askScope ?? "today_change") as AskScope,
    instrumentId: input?.instrumentId ?? input?.resolvedInstrumentIds?.[0] ?? "",
    question: input?.question ?? "",
    priorRunId: input?.priorRunId ?? "",
  };
}

export default function AgentComposer({ runs, instruments, selectedRun, submitting, onSubmit }: AgentComposerProps) {
  const initialDraft = composerDraftFromRun(selectedRun);
  const [scope, setScope] = useState<AskScope>(initialDraft.scope);
  const [instrumentId, setInstrumentId] = useState(initialDraft.instrumentId);
  const [question, setQuestion] = useState(initialDraft.question);
  const [priorRunId, setPriorRunId] = useState(initialDraft.priorRunId);
  const [error, setError] = useState<string | null>(null);
  const selectedScope = askScopes.find((item) => item.id === scope) ?? askScopes[0];
  const historicalRuns = useMemo(
    () => runs.filter((run) => (run.status === "success" || run.status === "partial") && Boolean(run.evidenceFingerprint) && !run.payloadPurgedAt),
    [runs],
  );
  const activeRun = runs.some((run) => isCancellableRunStatus(run.status));

  useEffect(() => {
    if (!selectedRun) return;
    const restored = composerDraftFromRun(selectedRun);
    setScope(restored.scope);
    setInstrumentId(restored.instrumentId);
    setQuestion(restored.question);
    setPriorRunId(restored.priorRunId);
    setError(null);
  }, [selectedRun?.id]);

  const compareSelectedRun = () => {
    if (!selectedRun?.evidenceFingerprint || selectedRun.payloadPurgedAt) return;
    setScope("compare_previous_run");
    setInstrumentId("");
    setPriorRunId(selectedRun.id);
    setQuestion("");
    setError(null);
  };

  const submit = async () => {
    if (selectedScope.requiresInstrument && !instrumentId.trim()) {
      setError("没有选择标的。请选择一个标的后再开始回答。");
      return;
    }
    if (selectedScope.requiresPreviousRun && !priorRunId) {
      setError("没有选择历史 Run。请选择一条仍保留 Evidence 的记录。");
      return;
    }
    setError(null);
    try {
      await onSubmit({
        scope,
        ...(instrumentId.trim() ? { instrumentId: instrumentId.trim().toUpperCase() } : {}),
        ...(question.trim() ? { question: question.trim() } : {}),
        ...(priorRunId ? { priorRunId } : {}),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "受限问答未能启动，请稍后重试。");
    }
  };

  return (
    <section className="agent-composer" aria-labelledby="agent-composer-title">
      <header className="agent-composer__header">
        <div>
          <h2 id="agent-composer-title">继续研究</h2>
          <p>{selectedRun ? `Composer 已恢复 Run ${selectedRun.id.slice(0, 8)} 的可用输入上下文。` : "选择范围后开始第一条受限问答。"}</p>
        </div>
        {selectedRun?.evidenceFingerprint && !selectedRun.payloadPurgedAt && (
          <button type="button" className="agent-composer__compare" onClick={compareSelectedRun} disabled={submitting || activeRun}>与此 Run 比较</button>
        )}
      </header>
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <label>
          <span>研究范围</span>
          <select value={scope} onChange={(event) => { setScope(event.target.value as AskScope); setError(null); }} disabled={submitting || activeRun}>
            {askScopes.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>
        {!selectedScope.requiresPreviousRun ? (
          <label>
            <span>标的</span>
            <input list="agent-composer-instruments" value={instrumentId} placeholder={selectedScope.requiresInstrument ? "SSE:600000" : "可选：SSE:600000"} maxLength={16} autoCapitalize="characters" onChange={(event) => { setInstrumentId(event.target.value.toUpperCase()); setError(null); }} disabled={submitting || activeRun} />
            <datalist id="agent-composer-instruments">{instruments.map((id) => <option key={id} value={id} />)}</datalist>
          </label>
        ) : (
          <label>
            <span>历史 Run</span>
            <select value={priorRunId} onChange={(event) => { setPriorRunId(event.target.value); setError(null); }} disabled={submitting || activeRun}>
              <option value="">选择仍保留 Evidence 的 Run</option>
              {historicalRuns.map((run) => <option key={run.id} value={run.id}>{formatRunOption(run)}</option>)}
            </select>
          </label>
        )}
        <label className="agent-composer__question">
          <span>问题说明</span>
          <textarea value={question} placeholder="可选：说明你希望重点解释的因素；它不会扩大事实范围。" maxLength={800} onChange={(event) => { setQuestion(event.target.value); setError(null); }} disabled={submitting || activeRun} />
        </label>
        <footer>
          <div><strong>{selectedScope.label}</strong><span>{selectedScope.description}</span></div>
          <button type="submit" disabled={submitting || activeRun} data-state={submitting ? "loading" : error ? "error" : "default"}>{submitting ? "正在建立 Run" : activeRun ? "等待当前 Run" : "开始回答"}</button>
        </footer>
      </form>
      <p className="agent-composer__status" data-tone={error ? "error" : "neutral"} aria-live="polite">{error ?? "数字只能来自已封存的确定性 Fact Plane；缺少数据时报告会明确留空。"}</p>
    </section>
  );
}

export interface RunActivityProps {
  status?: string;
  runId?: string;
  trace?: RunTrace | null;
  timing?: RunTiming;
  limitations?: string[];
  outcome?: RunOutcome;
  controlBusy?: "cancel" | "retry" | null;
  traceLoading?: boolean;
  traceError?: string | null;
  controlsDisabled?: boolean;
  onCancel?(): Promise<unknown>;
  onRetry?(): Promise<unknown>;
}

export function RunActivity({
  status,
  runId,
  trace,
  timing,
  controlBusy = null,
  traceLoading = false,
  traceError = null,
  controlsDisabled = false,
  onCancel,
  onRetry,
}: RunActivityProps) {
  const terminal = Boolean(status && !isCancellableRunStatus(status));
  const effectiveTiming = trace?.timing ?? timing;
  const elapsed = useServerElapsed(effectiveTiming, terminal);
  if (!status) return null;
  const events = [...(trace?.events ?? [])].sort((left, right) => left.sequence - right.sequence);
  const canCancel = isCancellableRunStatus(status) && Boolean(onCancel);
  const canRetry = isRetryableRunStatus(status) && Boolean(onRetry);
  return (
    <section className="agent-progress agent-trace" aria-label="真实 Run 活动" aria-live="polite">
      <header>
        <div><span className={`agent-progress__pulse${!terminal ? " is-live" : ""}`} /><div><strong>真实运行记录</strong><small>{statusLabel(status)} · {elapsed === null ? "等待计时" : `${terminal ? "总耗时" : "运行耗时"} ${formatDuration(elapsed)}`}</small></div></div>
        <div className="agent-trace__controls">
          {canCancel && <button type="button" data-action="cancel" onClick={() => { void onCancel?.().catch(() => undefined); }} disabled={controlsDisabled || controlBusy !== null}>{controlBusy === "cancel" ? "正在取消" : "取消运行"}</button>}
          {canRetry && <button type="button" data-action="retry" onClick={() => { void onRetry?.().catch(() => undefined); }} disabled={controlsDisabled || controlBusy !== null}>{controlBusy === "retry" ? "正在重试" : "重试"}</button>}
          <code>{runId ? runId.slice(0, 8) : "pending"}</code>
        </div>
      </header>
      {events.length ? <ol>{events.map((event) => <RunTraceRow key={event.id} event={event} />)}</ol> : <p>{traceLoading ? "正在读取服务器运行事件。" : "尚未读取到服务器运行事件；不会根据当前 status 补造中间步骤。"}</p>}
      {traceError && <p className="agent-trace__error" role="status">运行事件读取失败：{traceError}</p>}
      <p className="agent-trace__boundary">仅显示服务端持久化的阶段、重试、取消与耗时；不展示或模拟私密思考过程。</p>
    </section>
  );
}

function RunTraceRow({ event }: { event: RunTraceEvent }) {
  const tone = traceTone(event);
  return <li data-state={tone}>
    <span className="agent-progress__node" />
    <div><strong>{traceEventLabel(event)}</strong><small>{traceEventMeta(event)}</small></div>
    <time dateTime={event.occurredAt}>{traceTime(event.occurredAt)}</time>
  </li>;
}

function useServerElapsed(timing: RunTiming | undefined, terminal: boolean): number | null {
  const [now, setNow] = useState(monotonicNow);
  const baseline = useRef({ key: "", at: now });
  const key = timing ? `${timing.serverNow}:${timing.elapsedMs}:${timing.durationMs ?? "active"}` : "";
  if (baseline.current.key !== key) baseline.current = { key, at: now };
  useEffect(() => {
    if (!timing || terminal) return;
    setNow(monotonicNow());
    const interval = window.setInterval(() => setNow(monotonicNow()), 1_000);
    return () => window.clearInterval(interval);
  }, [terminal, timing?.serverNow]);
  return projectRunElapsed(timing, terminal, Math.max(0, now - baseline.current.at));
}

export function projectRunElapsed(timing: RunTiming | undefined, terminal: boolean, elapsedSinceSnapshotMs: number): number | null {
  if (!timing) return null;
  if (terminal) return nonNegativeNumber(timing.durationMs) ?? nonNegativeNumber(timing.elapsedMs);
  const base = nonNegativeNumber(timing.elapsedMs);
  if (!timing.startedAt) return base;
  if (base === null || !Number.isFinite(elapsedSinceSnapshotMs)) return null;
  return base + Math.max(0, elapsedSinceSnapshotMs);
}

function monotonicNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function traceEventLabel(event: RunTraceEvent): string {
  if (event.type === "run_created") return "Run 已建立";
  if (event.type === "stage_started") return `${traceStageLabel(event.stage)}开始`;
  if (event.type === "stage_completed") return `${traceStageLabel(event.stage)}完成`;
  if (event.type === "retry_scheduled") return "已安排恢复重试";
  if (event.type === "cancel_requested") return "已请求取消";
  if (event.type === "run_cancelled") return "Run 已取消";
  if (event.type === "run_completed") return "Run 已完成";
  return "Run 未完成";
}

function traceStageLabel(stage?: string): string {
  return ({
    queued: "排队",
    collecting: "事实收集",
    evidence_sealed: "Evidence 封存",
    generating: "报告生成",
    validating: "结果校验",
    retry_wait: "恢复等待",
    success: "完成",
    partial: "部分完成",
    failed: "失败",
    cancelled: "取消",
  } as Record<string, string>)[stage ?? ""] ?? "运行阶段";
}

function traceEventMeta(event: RunTraceEvent): string {
  const parts = [traceOperationLabel(event.provenance.operation), event.attempt > 0 ? `第 ${event.attempt} 次执行` : "准备阶段"];
  if (event.recoveryGeneration > 0) parts.push(`恢复代次 ${event.recoveryGeneration}`);
  const duration = nonNegativeNumber(event.durationMs);
  if (duration !== null) parts.push(formatDuration(duration));
  if (event.code) parts.push(event.code);
  return parts.join(" · ");
}

function traceOperationLabel(operation: RunTraceEvent["provenance"]["operation"]): string {
  return ({
    "run.create": "Run Controller",
    "run.claim": "Queue Consumer",
    "run.collect": "Fact Collector",
    "evidence.seal": "Evidence Assembler",
    "narration.generate": "Agent Narrator",
    "result.validate": "Result Validator",
    "run.retry": "Recovery Controller",
    "run.cancel": "Run Controller",
    "run.complete": "Run Controller",
    "run.fail": "Run Controller",
  } as const)[operation];
}

function traceTone(event: RunTraceEvent): string {
  if (event.type === "run_failed") return "failed";
  if (event.type === "run_cancelled" || event.type === "cancel_requested") return "cancelled";
  if (event.type === "retry_scheduled") return "retry";
  if (event.type === "stage_started") return "active";
  return "complete";
}

function traceTime(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "时间未知";
  return parsed.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function nonNegativeNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : null;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} 毫秒`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)} 秒`;
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  return `${minutes} 分 ${seconds} 秒`;
}

export function degradedTool(tool: string, limitations: string[], outcome?: RunOutcome) {
  if (tool === "Agent Narrator") return outcome ? outcome.narration.source === "deterministic_fallback" : limitations.some((item) => item.includes("Gateway"));
  if (tool === "Market Snapshot") return outcome ? outcome.evidence.limitations.some((item) => item.code === "MARKET_SNAPSHOT_UNRELIABLE" || Boolean(item.capability && !item.capability.startsWith("research:"))) : limitations.some((item) => /数据限制|数据能力|行情|报价|市场事实/.test(item));
  if (tool === "Evidence Assembler") return outcome ? outcome.evidence.limitations.some((item) => item.code === "RESEARCH_SCOPE_PARTIAL" || item.capability?.startsWith("research:")) : false;
  return false;
}

function statusLabel(status: string) {
  return ({ queued: "已排队", collecting: "正在收集", evidence_sealed: "Evidence 已封存", generating: "正在生成", validating: "正在校验", retry_wait: "等待重试", success: "完成", partial: "部分完成", failed: "未完成", cancelled: "已取消" } as Record<string, string>)[status] ?? status;
}

function formatRunOption(run: AgentRunView) {
  const time = new Date(run.createdAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return `${time} · ${run.workflow === "ask" ? "Ask" : "复盘"} · ${run.result?.headline ?? run.id.slice(0, 8)}`;
}
