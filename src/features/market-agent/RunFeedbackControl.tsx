import React, { useEffect, useReducer, useRef } from "react";
import type { AgentFeedback, AgentFeedbackValue } from "@zxlab/market-agent-schema";

const options: Array<{ value: AgentFeedbackValue; label: string }> = [
  { value: "helpful", label: "有帮助" },
  { value: "fact_error", label: "事实错误" },
  { value: "missing_factor", label: "遗漏关键因素" },
];

export type RunFeedbackState =
  | { kind: "idle"; feedback: AgentFeedback | null }
  | { kind: "saving"; feedback: AgentFeedback | null; value: AgentFeedbackValue; requestId: number }
  | { kind: "saved"; feedback: AgentFeedback }
  | { kind: "error"; feedback: AgentFeedback | null; message: string };

export type RunFeedbackAction =
  | { type: "sync"; feedback: AgentFeedback | null }
  | { type: "start"; value: AgentFeedbackValue; requestId: number }
  | { type: "saved"; feedback: AgentFeedback; requestId: number }
  | { type: "failed"; message: string; requestId: number };

export function createRunFeedbackState(feedback: AgentFeedback | null): RunFeedbackState {
  return feedback ? { kind: "saved", feedback } : { kind: "idle", feedback: null };
}

export function runFeedbackReducer(
  state: RunFeedbackState,
  action: RunFeedbackAction,
): RunFeedbackState {
  if (action.type === "sync") {
    if (state.kind === "saving") return { ...state, feedback: action.feedback };
    return createRunFeedbackState(action.feedback);
  }
  if (action.type === "start") {
    if (state.kind === "saving") return state;
    return { kind: "saving", feedback: state.feedback, value: action.value, requestId: action.requestId };
  }
  if (state.kind !== "saving" || state.requestId !== action.requestId) return state;
  if (action.type === "saved") return { kind: "saved", feedback: action.feedback };
  return { kind: "error", feedback: state.feedback, message: action.message };
}

export function RunFeedbackControl({
  feedback,
  disabled = false,
  onSubmit,
}: {
  feedback?: AgentFeedback | null;
  disabled?: boolean;
  onSubmit: (value: AgentFeedbackValue) => Promise<AgentFeedback>;
}) {
  const [feedbackState, dispatch] = useReducer(
    runFeedbackReducer,
    feedback ?? null,
    createRunFeedbackState,
  );
  const sequence = useRef(0);

  useEffect(() => {
    dispatch({ type: "sync", feedback: feedback ?? null });
  }, [feedback?.updatedAt, feedback?.value]);

  const saving = feedbackState.kind === "saving";
  const selected = saving ? feedbackState.value : feedbackState.feedback?.value;
  const message = feedbackMessage(feedbackState);

  async function choose(value: AgentFeedbackValue) {
    if (disabled || saving) return;
    const requestId = ++sequence.current;
    dispatch({ type: "start", value, requestId });
    try {
      const saved = await onSubmit(value);
      dispatch({ type: "saved", feedback: saved, requestId });
    } catch (cause) {
      dispatch({
        type: "failed",
        message: cause instanceof Error ? cause.message : "反馈未保存，请重试。",
        requestId,
      });
    }
  }

  return (
    <div className="agent-feedback-control" data-state={feedbackState.kind}>
      <div className="agent-feedback" role="group" aria-label="本次运行是否有帮助">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected === option.value}
            data-state={selected === option.value ? (saving ? "saving" : "selected") : "idle"}
            disabled={disabled || saving}
            onClick={() => void choose(option.value)}
          >
            {saving && selected === option.value ? "保存中" : option.label}
          </button>
        ))}
      </div>
      <span
        className="agent-feedback-status"
        data-tone={feedbackState.kind === "error" ? "error" : feedbackState.feedback ? "success" : "neutral"}
        aria-live="polite"
      >
        {message}
      </span>
    </div>
  );
}

function feedbackMessage(state: RunFeedbackState): string {
  if (state.kind === "saving") return `正在保存“${feedbackLabel(state.value)}”…`;
  if (state.kind === "error") return `反馈未保存：${state.message}`;
  if (state.feedback) return `已记录“${feedbackLabel(state.feedback.value)}”，可以随时修改。`;
  return "反馈只用于改进后续运行，不会改写本次记录。";
}

function feedbackLabel(value: AgentFeedbackValue): string {
  return options.find((option) => option.value === value)?.label ?? value;
}
