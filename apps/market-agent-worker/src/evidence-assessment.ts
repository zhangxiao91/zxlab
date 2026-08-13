import type { AgentWorkflow, AskScope, EvidenceAssessment, EvidenceLimitation } from "@zxlab/market-agent-schema";
import type { MarketCapabilityHealth, MarketSnapshot } from "@zxlab/market-schema";

export type EvidencePurpose = AgentWorkflow | AskScope;

export function assessEvidence(purpose: EvidencePurpose, snapshot: MarketSnapshot, hasPortfolioSnapshot: boolean): EvidenceAssessment {
  const fallbackCapabilities = snapshot.capabilities
    .filter(usedFallbackSuccessfully)
    .map((capability) => capability.id)
    .sort();
  const limitations = snapshot.capabilities.flatMap((capability) => limitationFor(purpose, capability));

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
