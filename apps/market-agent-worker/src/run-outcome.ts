import { createResearchReportV2, type AgentNarration, type AgentResult, type AskScope, type EvidenceAssessment, type NarrationProvenance, type SealedEvidenceBundle } from "@zxlab/market-agent-schema";

export function finalizeAgentResult(input: {
  narration: AgentNarration;
  provenance: NarrationProvenance;
  evidence: EvidenceAssessment;
  sealedEvidence: SealedEvidenceBundle;
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
    report: createResearchReportV2(input.narration, input.sealedEvidence),
    outcome: {
      execution: "completed",
      narration: input.provenance,
      evidence: input.evidence,
      mode: input.mode,
    },
  };
}
