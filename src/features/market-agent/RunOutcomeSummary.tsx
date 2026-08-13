import type { RunOutcome } from "@zxlab/market-agent-schema";

export function RunOutcomeSummary({ outcome }: { outcome?: RunOutcome }) {
  if (!outcome) return null;
  const items = [
    { key: "execution", label: "执行", value: "已完成", tone: "complete" },
    { key: "narration", label: "叙事", value: narrationLabel(outcome.narration.source), tone: outcome.narration.source === "deterministic_fallback" ? "limited" : "complete" },
    { key: "evidence", label: "证据", value: evidenceLabel(outcome.evidence.coverage, outcome.evidence.delivery), tone: outcome.evidence.coverage === "sufficient" ? "complete" : "limited" },
    { key: "mode", label: "模式", value: outcome.mode === "portfolio-aware" ? "持仓感知" : "仅市场", tone: outcome.mode === "portfolio-aware" ? "complete" : "neutral" },
  ];
  return <dl className="agent-outcome" aria-label="本次运行结果">{items.map((item) => <div key={item.key} data-tone={item.tone}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>;
}

function narrationLabel(source: RunOutcome["narration"]["source"]) {
  return ({ model: "模型生成", model_repaired: "模型修复后通过", deterministic_fallback: "确定性摘要", unknown: "历史记录" } as const)[source];
}

function evidenceLabel(coverage: RunOutcome["evidence"]["coverage"], delivery: RunOutcome["evidence"]["delivery"]) {
  if (coverage === "insufficient") return "不足";
  if (coverage === "limited") return "受限";
  return delivery === "fallback" ? "完整 · 备用源" : "完整";
}
