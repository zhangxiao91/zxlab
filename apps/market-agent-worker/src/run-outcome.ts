import type { AgentNarration, AgentResult, AskScope, EvidenceAssessment, NarrationProvenance } from "@zxlab/market-agent-schema";

export function finalizeAgentResult(input: {
  narration: AgentNarration;
  provenance: NarrationProvenance;
  evidence: EvidenceAssessment;
  mode: AgentResult["mode"];
  askScope?: AskScope;
}): AgentResult {
  const status = input.provenance.source === "deterministic_fallback" || input.evidence.coverage !== "sufficient"
    ? "partial"
    : "success";
  return {
    ...input.narration,
    status,
    mode: input.mode,
    ...(input.askScope ? { askScope: input.askScope } : {}),
    outcome: {
      execution: "completed",
      narration: input.provenance,
      evidence: input.evidence,
      mode: input.mode,
    },
  };
}
