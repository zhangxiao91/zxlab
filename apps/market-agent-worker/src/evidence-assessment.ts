import type { AgentWorkflow, AskScope, EvidenceAssessment, EvidenceLimitation } from "@zxlab/market-agent-schema";
import type { MarketCapabilityHealth, MarketSnapshot } from "@zxlab/market-schema";
import type { ResearchCapabilityOutcome, ResearchFactBundle } from "@zxlab/research-fact-schema";

export type EvidencePurpose = AgentWorkflow | AskScope;

export function assessEvidence(purpose: EvidencePurpose, snapshot: MarketSnapshot, hasPortfolioSnapshot: boolean, research?: ResearchFactBundle, researchOmittedInstrumentCount = 0): EvidenceAssessment {
  const fallbackCapabilities = snapshot.capabilities
    .filter(usedFallbackSuccessfully)
    .map((capability) => capability.id)
    .sort();
  const limitations = [
    ...snapshot.capabilities.flatMap((capability) => limitationFor(purpose, capability)),
    ...(research?.capabilities.flatMap(researchLimitationFor) ?? []),
  ];
  if (researchOmittedInstrumentCount > 0) limitations.push({
    code: "RESEARCH_SCOPE_PARTIAL",
    capability: "research:scope",
    severity: "material",
    message: `Research Facts 仅覆盖前 20 个确定性选择的标的，另有 ${researchOmittedInstrumentCount} 个标的未纳入研究基线。`,
  });

  if (purpose === "portfolio_impact" && !hasPortfolioSnapshot) {
    limitations.unshift({
      code: "PORTFOLIO_SNAPSHOT_REQUIRED",
      severity: "blocking",
      message: "持仓影响需要当前有效的 Portfolio Snapshot。",
    });
  }

  if (!snapshot.quality.reliable && !limitations.some((item) => item.severity !== "advisory")) {
    limitations.push({
      code: "MARKET_SNAPSHOT_UNRELIABLE",
      severity: "material",
      message: "Market Snapshot 未达到可靠性要求。",
    });
  }

  const coverage = limitations.some((item) => item.severity === "blocking")
    ? "insufficient"
    : limitations.some((item) => item.severity === "material")
      ? "limited"
      : "sufficient";

  return {
    coverage,
    delivery: fallbackCapabilities.length ? "fallback" : "primary",
    fallbackCapabilities,
    limitations,
  };
}

function researchLimitationFor(capability: ResearchCapabilityOutcome): EvidenceLimitation[] {
  if (capability.status === "operational" && capability.warnings.length === 0) return [];
  const severity: EvidenceLimitation["severity"] = capability.required
    ? capability.status === "unavailable" ? "blocking" : "material"
    : "advisory";
  if (capability.limitations.length) return capability.limitations.map((limitation) => ({
    code: limitation.code,
    capability: `research:${capability.id}`,
    severity,
    message: researchLimitationMessage(limitation),
  }));
  return [{ code: capability.error?.code ?? "RESEARCH_CAPABILITY_UNAVAILABLE", capability: `research:${capability.id}`, severity, message: `Research capability ${capability.id} 当前不可完整使用。` }];
}

function researchLimitationMessage(limitation: ResearchCapabilityOutcome["limitations"][number]): string {
  const subject = limitation.subjectId ? `${limitation.subjectId} ` : "";
  const baseline = limitation.baselineType && limitation.window ? `${limitation.baselineType}:${limitation.window}` : limitation.baselineType ?? "";
  const financial = limitation.metric
    ? `${limitation.metric}${limitation.comparisonKind ? `:${limitation.comparisonKind}` : ""}`
    : "";
  const coverage = typeof limitation.actual === "number" && typeof limitation.required === "number" ? ` 样本 ${limitation.actual}/${limitation.required}` : "";
  const period = limitation.periodEnd ? ` period=${limitation.periodEnd}` : "";
  const latestSession = limitation.code === "LATEST_SESSION_MISSING"
    ? ` expected=${limitation.expectedSessionDate ?? "unknown"} actual=${limitation.actualSessionDate ?? "unknown"}`
    : "";
  return `${subject}${financial || baseline || "Research Fact"}${period} ${limitation.code}${coverage}${latestSession}`.trim();
}

function usedFallbackSuccessfully(capability: MarketCapabilityHealth): boolean {
  const firstSuccess = capability.attempts.findIndex((attempt) => attempt.ok);
  return firstSuccess > 0 || (firstSuccess >= 0 && capability.attempts.slice(0, firstSuccess).some((attempt) => !attempt.ok));
}

function limitationFor(purpose: EvidencePurpose, capability: MarketCapabilityHealth): EvidenceLimitation[] {
  if (!capability.required) return [];
  const unavailable = capability.status === "unavailable";
  const stale = capability.freshness === "stale" || capability.freshness === "unknown";
  const warning = capability.warnings.length > 0;
  if (!unavailable && !stale && !warning) return [];

  const core = coreCapability(purpose, capability.id);
  const severity: EvidenceLimitation["severity"] = unavailable && core ? "blocking" : "material";
  return [{
    code: unavailable ? "CAPABILITY_UNAVAILABLE" : stale ? "CAPABILITY_NOT_FRESH" : "CAPABILITY_WARNING",
    capability: capability.id,
    severity,
    message: capability.warnings[0] ?? `${capability.id} 当前不可完整使用。`,
  }];
}

function coreCapability(purpose: EvidencePurpose, capabilityId: string): boolean {
  if (purpose === "news_and_announcements") return capabilityId === "news" || capabilityId.startsWith("announcements:");
  if (purpose === "portfolio_impact") return capabilityId === "quotes";
  if (purpose === "data_quality") return false;
  if (purpose === "compare_previous_run") return capabilityId === "quotes";
  return capabilityId === "quotes" || capabilityId.startsWith("status:");
}
