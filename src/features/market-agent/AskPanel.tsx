import React, { useEffect, useMemo, useState } from "react";
import type { AskScope, RunOutcome } from "@zxlab/market-agent-schema";
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

const terminalStatuses = new Set(["success", "partial", "failed"]);
const runStages = [
  { id: "queued", label: "Run 已建立", detail: "问题范围与幂等身份已经固定" },
  { id: "collecting", label: "事实收集中", detail: "服务端正在读取允许范围内的确定性事实" },
  { id: "evidence_sealed", label: "Evidence 已封存", detail: "引用范围与 fingerprint 已冻结" },
  { id: "generating", label: "报告生成中", detail: "Narrator 只能读取本次封存 Evidence" },
  { id: "validating", label: "结果校验中", detail: "结构、引用、数字边界与限制项正在检查" },
] as const;

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
  const activeRun = runs.some((run) => !terminalStatuses.has(run.status));

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

export function RunActivity({ status, runId, limitations = [], outcome }: { status?: string; runId?: string; limitations?: string[]; outcome?: RunOutcome }) {
  if (!status) return null;
  const activeIndex = runStageIndex(status);
  const finished = status === "success" || status === "partial";
  const failed = status === "failed";
  return (
    <section className="agent-progress" aria-live="polite" aria-label="Run 状态">
      <header><div><span className={`agent-progress__pulse${!terminalStatuses.has(status) ? " is-live" : ""}`} /><strong>{statusLabel(status)}</strong></div><small>{runId ? `Run ${runId.slice(0, 8)}` : "尚未建立 Run"}</small></header>
      <ol>{runStages.map((stage, index) => {
        const state = failed ? "unknown" : index < activeIndex || finished ? "complete" : index === activeIndex ? degradedStage(stage.id, limitations, outcome) ? "degraded" : "active" : "waiting";
        return <li key={stage.id} data-state={state}><span className="agent-progress__node" /><div><strong>{stage.label}</strong><small>{stage.detail}</small></div></li>;
      })}</ol>
      <p>{failed ? "本次 Run 整体未完成；现有记录没有提供具体失败阶段，因此不对任一阶段作失败归因。" : "这里只展示可由 Run status 验证的流程阶段；真实工具调用、逐步耗时与取消事件属于后续能力。"}</p>
    </section>
  );
}

function degradedStage(stage: string, limitations: string[], outcome?: RunOutcome) {
  if (stage === "generating") return degradedTool("Agent Narrator", limitations, outcome);
  if (stage === "collecting") return degradedTool("Market Snapshot", limitations, outcome);
  if (stage === "evidence_sealed") return degradedTool("Evidence Assembler", limitations, outcome);
  return false;
}

export function degradedTool(tool: string, limitations: string[], outcome?: RunOutcome) {
  if (tool === "Agent Narrator") return outcome ? outcome.narration.source === "deterministic_fallback" : limitations.some((item) => item.includes("Gateway"));
  if (tool === "Market Snapshot") return outcome ? outcome.evidence.limitations.some((item) => item.code === "MARKET_SNAPSHOT_UNRELIABLE" || Boolean(item.capability && !item.capability.startsWith("research:"))) : limitations.some((item) => /数据限制|数据能力|行情|报价|市场事实/.test(item));
  if (tool === "Evidence Assembler") return outcome ? outcome.evidence.limitations.some((item) => item.code === "RESEARCH_SCOPE_PARTIAL" || item.capability?.startsWith("research:")) : false;
  return false;
}

function runStageIndex(status: string) {
  if (status === "retry_wait") return 1;
  if (status === "success" || status === "partial") return runStages.length - 1;
  return ({ queued: 0, collecting: 1, evidence_sealed: 2, generating: 3, validating: 4 } as Record<string, number>)[status] ?? 0;
}

function statusLabel(status: string) {
  return ({ queued: "已排队", collecting: "正在收集", evidence_sealed: "Evidence 已封存", generating: "正在生成", validating: "正在校验", retry_wait: "等待重试", success: "完成", partial: "部分完成", failed: "未完成" } as Record<string, string>)[status] ?? status;
}

function formatRunOption(run: AgentRunView) {
  const time = new Date(run.createdAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return `${time} · ${run.workflow === "ask" ? "Ask" : "复盘"} · ${run.result?.headline ?? run.id.slice(0, 8)}`;
}
