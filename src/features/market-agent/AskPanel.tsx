import { useEffect, useMemo, useRef, useState } from "react";
import gsap from "gsap";
import type { AskScope, SealedEvidenceBundle } from "@zxlab/market-agent-schema";
import {
  getAgentRun,
  getAgentRunEvidence,
  sendRunFeedback,
  startAgentAsk,
  type AgentObservationView,
  type AgentRunView,
} from "./client";

interface AskScopeOption {
  id: AskScope;
  label: string;
  description: string;
  requiresInstrument?: boolean;
  requiresPreviousRun?: boolean;
}

const askScopes: AskScopeOption[] = [
  {
    id: "today_change",
    label: "今日变化",
    description: "单一标的的当日行情与变化。",
    requiresInstrument: true,
  },
  {
    id: "relative_performance",
    label: "相对表现",
    description: "与已确认观察列表进行比较。",
    requiresInstrument: true,
  },
  {
    id: "news_and_announcements",
    label: "新闻与公告",
    description: "单一标的的已收集新闻和公告元数据。",
    requiresInstrument: true,
  },
  {
    id: "data_quality",
    label: "数据质量",
    description: "所选标的或观察列表的数据可用性。",
  },
  {
    id: "portfolio_impact",
    label: "持仓影响",
    description: "仅使用当前有效的持仓快照。",
  },
  {
    id: "compare_previous_run",
    label: "比较历史运行",
    description: "固定使用一条已封存 Evidence 的完整范围。",
    requiresPreviousRun: true,
  },
];

const terminalStatuses = new Set(["success", "partial", "failed"]);

const runStages = [
  { id: "queued", label: "建立 Run", tool: "Run Orchestrator", detail: "固定问题范围与幂等键" },
  { id: "collecting", label: "收集事实", tool: "Market Snapshot", detail: "读取允许范围内的行情与公告" },
  { id: "evidence_sealed", label: "封存证据", tool: "Evidence Assembler", detail: "冻结引用范围并计算指纹" },
  { id: "generating", label: "形成回答", tool: "Agent Narrator", detail: "只读取本次 Evidence" },
  { id: "validating", label: "校验输出", tool: "Result Validator", detail: "检查引用、结构与限制项" },
] as const;

interface AskPanelProps {
  runs: AgentRunView[];
  instruments: string[];
  onRunUpdate: (run: AgentRunView) => void;
}

export default function AskPanel({
  runs,
  instruments,
  onRunUpdate,
}: AskPanelProps) {
  const [scope, setScope] = useState<AskScope>("today_change");
  const [instrumentId, setInstrumentId] = useState("");
  const [question, setQuestion] = useState("");
  const [priorRunId, setPriorRunId] = useState("");
  const [answer, setAnswer] = useState<AgentRunView | null>(null);
  const [evidence, setEvidence] = useState<SealedEvidenceBundle | null>(null);
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const [feedbackNote, setFeedbackNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestKey = useRef(crypto.randomUUID());
  const panel = useRef<HTMLElement>(null);

  const selectedScope = askScopes.find((item) => item.id === scope) ?? askScopes[0];
  const historicalRuns = useMemo(
    () => runs.filter((run) => (
      (run.status === "success" || run.status === "partial")
      && Boolean(run.evidenceFingerprint)
    )),
    [runs],
  );
  const pending = Boolean(answer && !terminalStatuses.has(answer.status));
  const selectedEvidence = useMemo(
    () => evidence?.items.find((item) => item.id === selectedEvidenceId) ?? null,
    [evidence, selectedEvidenceId],
  );

  useEffect(() => {
    if (!answer?.result || !panel.current) return;
    const context = gsap.context(() => {
      gsap.fromTo(
        ".agent-ask__answer",
        { opacity: 0, y: 18, scale: 0.985 },
        { opacity: 1, y: 0, scale: 1, duration: 0.48, ease: "power3.out" },
      );
    }, panel);
    return () => context.revert();
  }, [answer?.id, answer?.result?.headline]);

  useEffect(() => {
    if (!answer || terminalStatuses.has(answer.status)) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const next = await getAgentRun(answer.id);
        if (cancelled) return;
        setAnswer(next);
        onRunUpdate(next);
        setError(null);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "无法读取 Ask 运行状态");
        }
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1_600);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [answer?.id, answer?.status, onRunUpdate]);

  useEffect(() => {
    if (!answer || !terminalStatuses.has(answer.status) || !answer.evidenceFingerprint) return;
    let cancelled = false;
    void getAgentRunEvidence(answer.id)
      .then((nextEvidence) => {
        if (!cancelled) {
          setEvidence(nextEvidence);
          setSelectedEvidenceId(null);
        }
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "无法读取已封存 Evidence");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [answer?.evidenceFingerprint, answer?.id, answer?.status]);

  function resetDraft(clearAnswer = false) {
    requestKey.current = crypto.randomUUID();
    setError(null);
    setFeedbackNote(null);
    if (clearAnswer) {
      setAnswer(null);
      setEvidence(null);
      setSelectedEvidenceId(null);
    }
  }

  function chooseScope(nextScope: AskScope) {
    setScope(nextScope);
    setInstrumentId("");
    setPriorRunId("");
    resetDraft(true);
  }

  async function submit() {
    if (selectedScope.requiresInstrument && !instrumentId.trim()) {
      setError("请选择一个标的后再提交这个问题。");
      return;
    }
    if (selectedScope.requiresPreviousRun && !priorRunId) {
      setError("请选择一条已完成且仍保留 Evidence 的历史运行。");
      return;
    }
    setSubmitting(true);
    try {
      const started = await startAgentAsk({
        scope,
        ...(instrumentId.trim() ? { instrumentId } : {}),
        ...(question.trim() ? { question } : {}),
        ...(priorRunId ? { priorRunId } : {}),
      }, requestKey.current);
      const now = new Date().toISOString();
      setAnswer({
        id: started.runId,
        workflow: "ask",
        status: started.status,
        createdAt: now,
        updatedAt: now,
        evidenceFingerprint: null,
      });
      setEvidence(null);
      setSelectedEvidenceId(null);
      setFeedbackNote(null);
      setError(null);
      requestKey.current = crypto.randomUUID();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "受限问答启动失败");
    } finally {
      setSubmitting(false);
    }
  }

  async function sendFeedback(value: "helpful" | "fact_error" | "missing_factor") {
    if (!answer) return;
    setFeedbackBusy(true);
    try {
      await sendRunFeedback(answer.id, value);
      setFeedbackNote(
        value === "helpful"
          ? "已记录为有帮助。"
          : value === "fact_error"
            ? "已记录为事实错误。"
            : "已记录为遗漏关键因素。",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "反馈未保存");
    } finally {
      setFeedbackBusy(false);
    }
  }

  return (
    <section className="agent-ask" aria-labelledby="agent-ask-title" ref={panel}>
      <header className="agent-ask__header">
        <div>
          <span>只读问答</span>
          <h2 id="agent-ask-title">问一个可由证据回答的问题。</h2>
        </div>
        <span>服务端封存范围</span>
      </header>
      <RunActivity status={answer?.status} runId={answer?.id} />
      <div className="agent-ask__grid">
        <form
          className="agent-ask__form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="agent-ask__scope">
            <span>问题范围</span>
            <select
              value={scope}
              disabled={submitting || pending}
              onChange={(event) => chooseScope(event.target.value as AskScope)}
            >
              {askScopes.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
            <small>{selectedScope.description}</small>
          </label>
          <div className="agent-ask__fields">
            {!selectedScope.requiresPreviousRun && (
              <label>
                <span>标的</span>
                <input
                  list="agent-ask-instruments"
                  value={instrumentId}
                  placeholder={selectedScope.requiresInstrument ? "SSE:600000" : "可选：SSE:600000"}
                  maxLength={16}
                  autoCapitalize="characters"
                  disabled={submitting || pending}
                  onChange={(event) => {
                    setInstrumentId(event.target.value.toUpperCase());
                    resetDraft(false);
                  }}
                />
                <datalist id="agent-ask-instruments">
                  {instruments.map((id) => <option key={id} value={id} />)}
                </datalist>
              </label>
            )}
            {selectedScope.requiresPreviousRun && (
              <label>
                <span>历史运行</span>
                <select
                  value={priorRunId}
                  disabled={submitting || pending}
                  onChange={(event) => {
                    setPriorRunId(event.target.value);
                    resetDraft(false);
                  }}
                >
                  <option value="">选择已封存的运行</option>
                  {historicalRuns.map((run) => (
                    <option key={run.id} value={run.id}>
                      {formatRunOption(run)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="agent-ask__question">
              <span>问题说明</span>
              <textarea
                value={question}
                placeholder="可选，仅影响答案表述"
                maxLength={800}
                disabled={submitting || pending}
                onChange={(event) => {
                  setQuestion(event.target.value);
                  resetDraft(false);
                }}
              />
            </label>
          </div>
          <footer>
            <span>{selectedScope.description}</span>
            <button type="submit" disabled={submitting || pending}>
              {submitting ? "正在提交" : pending ? statusLabel(answer?.status) : "开始回答"}
            </button>
          </footer>
        </form>
      </div>
      {error && <p className="review-status review-status--warning">{error}</p>}
      {answer && (
        <section className="agent-ask__answer" aria-live="polite">
          <header>
            <div>
              <span>{statusLabel(answer.status)}</span>
              <strong>{answer.result?.headline ?? "正在收集已批准的市场事实"}</strong>
            </div>
            <code>{answer.id}</code>
          </header>
          {answer.result ? (
            <>
              <p className="agent-ask__summary">{answer.result.summary}</p>
              <div className="agent-ask__answer-grid">
                <ObservationGroup
                  title="事实"
                  observations={answer.result.observations.filter((item) => item.class === "fact")}
                  onEvidence={setSelectedEvidenceId}
                />
                <ObservationGroup
                  title="推断"
                  observations={answer.result.observations.filter((item) => item.class === "inference")}
                  onEvidence={setSelectedEvidenceId}
                />
                <ObservationGroup
                  title="未知"
                  observations={answer.result.observations.filter((item) => item.class === "unknown")}
                  onEvidence={setSelectedEvidenceId}
                />
                <section className="agent-ask__answer-group agent-ask__answer-group--limitations">
                  <h3>局限</h3>
                  {answer.result.limitations.length ? (
                    <ul>
                      {answer.result.limitations.map((item) => <li key={item}>{item}</li>)}
                    </ul>
                  ) : <p>本次没有额外的数据质量限制。</p>}
                </section>
              </div>
              {answer.result.portfolioImpacts.length > 0 && (
                <ObservationGroup
                  title="持仓影响"
                  observations={answer.result.portfolioImpacts}
                  onEvidence={setSelectedEvidenceId}
                />
              )}
              <EvidencePanel evidence={evidence} selected={selectedEvidence} />
              <footer className="agent-ask__feedback">
                <span>{feedbackNote ?? "反馈只用于改进后续运行，不会改写本次记录。"}</span>
                <div>
                  <button type="button" disabled={feedbackBusy} onClick={() => void sendFeedback("helpful")}>有帮助</button>
                  <button type="button" disabled={feedbackBusy} onClick={() => void sendFeedback("fact_error")}>事实错误</button>
                  <button type="button" disabled={feedbackBusy} onClick={() => void sendFeedback("missing_factor")}>遗漏关键因素</button>
                </div>
              </footer>
            </>
          ) : (
            <p className="agent-ask__waiting">
              {answer.status === "failed"
                ? "本次运行未能完成；没有可展示的模型正文。"
                : "正在按固定计划收集事实、封存 Evidence 并生成回答。"}
            </p>
          )}
        </section>
      )}
    </section>
  );
}

function RunActivity({ status, runId }: { status?: string; runId?: string }) {
  if (!status || terminalStatuses.has(status)) return null;
  const activeIndex = runStageIndex(status);
  const finished = status === "success" || status === "partial";
  const failed = status === "failed";
  return (
    <section className="agent-activity" aria-live="polite" aria-label="Agent 执行过程">
      <header>
        <div>
          <span className={`agent-activity__pulse${status && !terminalStatuses.has(status) ? " is-live" : ""}`} />
          <strong>{status ? statusLabel(status) : "等待任务"}</strong>
          <small>{runId ? `Run ${runId.slice(0, 8)}` : "提交后将在这里显示实时阶段"}</small>
        </div>
        <p>展示可验证的执行阶段，不展示或伪造模型私密思维。</p>
      </header>
      <ol>
        {runStages.map((stage, index) => {
          const state = failed && index === activeIndex
            ? "failed"
            : finished || index < activeIndex
              ? "complete"
              : index === activeIndex && status
                ? "active"
                : "waiting";
          return (
            <li key={stage.id} data-state={state}>
              <span className="agent-activity__node" aria-hidden="true" />
              <div>
                <span>{stage.label}</span>
                <strong>{stage.tool}</strong>
                <small>{stage.detail}</small>
              </div>
              <em>{activityStateLabel(state)}</em>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function runStageIndex(status?: string) {
  if (!status) return -1;
  if (status === "retry_wait") return 1;
  if (status === "success" || status === "partial") return runStages.length - 1;
  if (status === "failed") return 0;
  const index = runStages.findIndex((stage) => stage.id === status);
  return index < 0 ? 0 : index;
}

function activityStateLabel(state: "complete" | "active" | "failed" | "waiting") {
  return ({ complete: "完成", active: "进行中", failed: "中止", waiting: "等待" } as const)[state];
}

function ObservationGroup({
  title,
  observations,
  onEvidence,
}: {
  title: string;
  observations: AgentObservationView[];
  onEvidence: (id: string) => void;
}) {
  return (
    <section className="agent-ask__answer-group">
      <h3>{title}</h3>
      {observations.length ? (
        <div>
          {observations.map((observation) => (
            <article key={observation.id}>
              <strong>{observation.title}</strong>
              <p>{observation.explanation}</p>
              <div>
                {observation.evidenceIds.map((id) => (
                  <button type="button" key={id} onClick={() => onEvidence(id)}>
                    {id}
                  </button>
                ))}
              </div>
            </article>
          ))}
        </div>
      ) : <p>本次没有可归入此类的结论。</p>}
    </section>
  );
}

function EvidencePanel({
  evidence,
  selected,
}: {
  evidence: SealedEvidenceBundle | null;
  selected: SealedEvidenceBundle["items"][number] | null;
}) {
  if (!evidence) return <p className="agent-ask__evidence-note">Evidence 将在封存后显示。</p>;
  return (
    <details className="agent-ask__evidence">
      <summary>
        <span>Evidence</span>
        <code>{evidence.fingerprint.slice(0, 20)}</code>
      </summary>
      <p>本次封存 {evidence.items.length} 条条目，范围为 {evidence.instrumentIds.join("、")}。</p>
      {selected ? (
        <article>
          <header>
            <strong>{selected.id}</strong>
            <span>{selected.kind} / {selected.reliable ? "可靠" : "受限"}</span>
          </header>
          <pre>{formatEvidenceValue(selected.value)}</pre>
        </article>
      ) : <p>选择上方任一引用，查看对应封存条目。</p>}
    </details>
  );
}

function statusLabel(status: string | undefined) {
  return ({
    queued: "已排队",
    collecting: "正在收集",
    evidence_sealed: "Evidence 已封存",
    generating: "正在生成",
    validating: "正在校验",
    retry_wait: "等待重试",
    success: "完成",
    partial: "部分完成",
    failed: "未完成",
  } as Record<string, string>)[status ?? ""] ?? "处理中";
}

function scopeBoundary(
  scope: AskScopeOption,
  instrumentId: string,
  priorRunId: string,
) {
  if (scope.requiresPreviousRun) {
    return priorRunId ? "将固定使用该历史运行的完整 Evidence 范围。" : "需先选择一条可读取的历史运行。";
  }
  if (scope.requiresInstrument) {
    return instrumentId.trim() ? `将固定使用 ${instrumentId.trim().toUpperCase()}。` : "需先选择一个标的。";
  }
  return instrumentId.trim()
    ? `将固定使用 ${instrumentId.trim().toUpperCase()}。`
    : "将由已确认的服务端范围决定。";
}

function formatRunOption(run: AgentRunView) {
  const time = new Date(run.createdAt).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${time} · ${run.workflow === "ask" ? "Ask" : "复盘"}`;
}

function formatEvidenceValue(value: unknown) {
  const text = JSON.stringify(value, null, 2) ?? String(value);
  return text.length > 3_000 ? `${text.slice(0, 3_000)}\n[truncated]` : text;
}
