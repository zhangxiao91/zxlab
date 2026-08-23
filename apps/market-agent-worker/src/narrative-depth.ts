import type { AgentNarration, AskScope, EvidenceAssessment, MarketAgentCommand } from "@zxlab/market-agent-schema";
import type { NarrationContext } from "./narration-context.ts";

export type LimitationClaim = "stale" | "missing" | "unreliable" | "provider_delay" | "scope" | "generic";

export interface NarrativeDepthPolicy {
  version: "narrative-depth.v1";
  profile: string;
  summary: { minCharacters: number; minSentences: number; maxSentences: number };
  minimums: {
    conclusionEvidenceIds: number;
    basis: number;
    analysis: number;
    portfolioImpacts: number;
    watchNext: number;
  };
  minimumExplanationCharacters: number;
  requiredEvidenceIds: string[];
  allowLimitationClaims: boolean;
  allowedLimitationClaims: LimitationClaim[];
  instructions: string[];
}

interface DepthInput {
  workflow: MarketAgentCommand["workflow"];
  askScope?: AskScope;
  context: NarrationContext;
  evidenceAssessment?: EvidenceAssessment;
}

interface DepthProfile {
  summaryCharacters: number;
  basis: number;
  analysis: number;
  portfolioImpacts: number;
  watchNext: number;
  conclusionEvidenceIds: number;
  explanationCharacters: number;
  evidenceRoles: EvidenceRole[];
}

type EvidenceRole = "research" | "market" | "external" | "portfolio" | "prior" | "quality" | "limitation";

const PROFILES: Record<string, DepthProfile> = {
  morning_brief: profile(140, 3, 1, 0, 2, 2, 48, ["market", "research", "external", "portfolio"]),
  close_review: profile(160, 3, 2, 0, 1, 2, 52, ["market", "research", "external", "portfolio"]),
  today_change: profile(100, 2, 1, 0, 1, 2, 44, ["research", "market"]),
  relative_performance: profile(140, 3, 1, 0, 1, 2, 48, ["research", "market"]),
  news_and_announcements: profile(160, 3, 2, 0, 1, 3, 52, ["external", "research", "market"]),
  data_quality: profile(100, 2, 0, 0, 1, 2, 44, ["quality", "limitation"]),
  portfolio_impact: profile(140, 2, 1, 1, 1, 2, 48, ["portfolio", "market", "research"]),
  compare_previous_run: profile(140, 2, 1, 0, 1, 2, 48, ["prior", "market", "research"]),
};

/**
 * Resolves the one evidence-aware contract shared by generation, repair, and validation.
 * Structural minima are capped by the claimable evidence actually presented to the model,
 * so depth cannot force invention when the sealed Evidence Bundle is sparse.
 */
export function resolveNarrativeDepthPolicy(input: DepthInput): NarrativeDepthPolicy {
  const key = input.workflow === "ask" ? input.askScope ?? input.context.focus.askScope ?? "today_change" : input.workflow;
  const base = PROFILES[key] ?? PROFILES.close_review!;
  const evidence = input.context.evidence;
  const claimable = evidence.filter((item) => item.reliable && evidenceRole(item) !== "limitation" && claimableRole(evidenceRole(item), key));
  const coverageEvidence = [...claimable, ...evidence.filter((item) => item.kind === "limitation" && item.reliable)];
  const roleFirst = new Map<EvidenceRole, string>();
  for (const item of coverageEvidence) {
    const role = evidenceRole(item);
    if (!roleFirst.has(role)) roleFirst.set(role, item.id);
  }
  const requiredEvidenceIds = base.evidenceRoles.flatMap((role) => roleFirst.get(role) ?? []).slice(0, 3);
  const limitationEvidence = evidence.filter((item) => item.kind === "limitation" || !item.reliable);
  const allowedLimitationClaims = limitationClaims(limitationEvidence);
  const availableCount = claimable.length;
  const summaryCharacters = availableCount === 0 ? 48 : availableCount === 1 ? Math.min(base.summaryCharacters, 72) : availableCount === 2 ? Math.min(base.summaryCharacters, 100) : base.summaryCharacters;
  const basis = Math.min(base.basis, claimable.filter((item) => evidenceRole(item) !== "portfolio").length);
  const analysis = availableCount >= 2 ? Math.min(base.analysis, Math.max(1, new Set(claimable.map(evidenceRole)).size - 1)) : 0;
  const portfolioImpacts = Math.min(base.portfolioImpacts, claimable.filter((item) => evidenceRole(item) === "portfolio").length);
  const conclusionEvidenceIds = Math.min(base.conclusionEvidenceIds, Math.max(requiredEvidenceIds.length, limitationEvidence.length ? 1 : 0));
  const watchNext = evidence.length ? base.watchNext : 0;
  const allowLimitationClaims = input.evidenceAssessment
    ? input.evidenceAssessment.coverage !== "sufficient"
    : limitationEvidence.length > 0;

  return {
    version: "narrative-depth.v1",
    profile: String(key),
    summary: { minCharacters: summaryCharacters, minSentences: 2, maxSentences: 4 },
    minimums: { conclusionEvidenceIds, basis, analysis, portfolioImpacts, watchNext },
    minimumExplanationCharacters: base.explanationCharacters,
    requiredEvidenceIds,
    allowLimitationClaims,
    allowedLimitationClaims,
    instructions: [
      "Write a connected research account: conclusion, cited basis, why the evidence matters, uncertainty, and what would change the view.",
      "Cover every required evidence topic in its own observation; do not attach an extra citation to unrelated prose merely to satisfy coverage.",
      "Every observation explanation must state why the cited evidence matters to the conclusion, interpretation, or next verification step.",
      ...(key === "news_and_announcements"
        ? ["Cover announcement facts, financial changes, interpretation, and data boundaries as distinct topics when the corresponding Evidence is available."]
        : []),
      "Meet only the evidence-aware minima in this policy; never invent content to fill a section.",
      "Natural-language prose must contain no quantities. Quantitative facts are rendered separately from sealed deterministic Evidence.",
      allowLimitationClaims
        ? "Every limitation claim must be supported by the presented unreliable or limitation Evidence."
        : "Evidence has no material limitation. Return an empty limitations array and do not claim stale, missing, unreliable, or provider-delayed data.",
    ],
  };
}

export function validateNarrativeDepth(value: unknown, policy: NarrativeDepthPolicy): string[] {
  const candidate = record(value);
  if (!candidate) return [];
  const issues: string[] = [];
  const summary = typeof candidate.summary === "string" ? candidate.summary : "";
  const summaryCharacters = substantiveCharacters(summary);
  if (summaryCharacters < policy.summary.minCharacters) issues.push(`NARRATIVE_DEPTH_SUMMARY_TOO_SHORT expected=${policy.summary.minCharacters} actual=${summaryCharacters}`);

  const observations = arrayRecords(candidate.observations);
  const portfolioImpacts = arrayRecords(candidate.portfolioImpacts);
  const watchNext = arrayRecords(candidate.watchNext);
  const basis = observations.filter((item) => item.class === "fact");
  const analysis = observations.filter((item) => item.class === "inference");
  if (basis.length < policy.minimums.basis) issues.push(`NARRATIVE_DEPTH_BASIS_TOO_SHALLOW expected=${policy.minimums.basis} actual=${basis.length}`);
  if (analysis.length < policy.minimums.analysis) issues.push(`NARRATIVE_DEPTH_ANALYSIS_TOO_SHALLOW expected=${policy.minimums.analysis} actual=${analysis.length}`);
  if (portfolioImpacts.length < policy.minimums.portfolioImpacts) issues.push(`NARRATIVE_DEPTH_PORTFOLIO_TOO_SHALLOW expected=${policy.minimums.portfolioImpacts} actual=${portfolioImpacts.length}`);
  if (watchNext.length < policy.minimums.watchNext) issues.push(`NARRATIVE_DEPTH_WATCH_NEXT_MISSING expected=${policy.minimums.watchNext} actual=${watchNext.length}`);

  const conclusionIds = stringArray(candidate.conclusionEvidenceIds);
  if (conclusionIds.length < policy.minimums.conclusionEvidenceIds) issues.push(`NARRATIVE_DEPTH_CONCLUSION_EVIDENCE_TOO_SHALLOW expected=${policy.minimums.conclusionEvidenceIds} actual=${conclusionIds.length}`);
  const citedIds = new Set([
    ...conclusionIds,
    ...observations.flatMap((item) => stringArray(item.evidenceIds)),
    ...portfolioImpacts.flatMap((item) => stringArray(item.evidenceIds)),
    ...watchNext.flatMap((item) => stringArray(item.evidenceIds)),
  ]);
  const uncovered = policy.requiredEvidenceIds.filter((id) => !citedIds.has(id));
  if (uncovered.length) issues.push(`NARRATIVE_DEPTH_REQUIRED_EVIDENCE_UNCOVERED ids=${uncovered.join(",")}`);
  const uncoveredTopics = uncoveredEvidenceTopics(observations, policy.requiredEvidenceIds);
  if (uncoveredTopics.length) issues.push(`NARRATIVE_DEPTH_REQUIRED_TOPIC_UNCOVERED ids=${uncoveredTopics.join(",")}`);

  for (const [section, items] of [["observations", observations], ["portfolioImpacts", portfolioImpacts]] as const) {
    for (const [index, item] of items.entries()) {
      const explanation = typeof item.explanation === "string" ? item.explanation : "";
      const actual = substantiveCharacters(explanation);
      if (actual < policy.minimumExplanationCharacters) issues.push(`NARRATIVE_DEPTH_EXPLANATION_TOO_SHORT section=${section} index=${index} expected=${policy.minimumExplanationCharacters} actual=${actual}`);
      if (!explainsSignificance(explanation)) issues.push(`NARRATIVE_DEPTH_EXPLANATION_MISSING_SIGNIFICANCE section=${section} index=${index}`);
    }
  }

  const limitations = Array.isArray(candidate.limitations) ? candidate.limitations.filter((item): item is string => typeof item === "string") : [];
  for (const [index, limitation] of limitations.entries()) {
    const claims = claimsInText(limitation);
    if (!policy.allowLimitationClaims || claims.some((claim) => !policy.allowedLimitationClaims.includes(claim))) {
      issues.push(`NARRATION_LIMITATION_UNSUPPORTED index=${index}`);
    }
  }
  return [...new Set(issues)];
}

function uncoveredEvidenceTopics(observations: Record<string, unknown>[], requiredEvidenceIds: string[]): string[] {
  const unused = new Set(observations.map((_, index) => index));
  return requiredEvidenceIds.filter((evidenceId) => {
    const matchingIndex = observations.findIndex((observation, index) => {
      const cited = stringArray(observation.evidenceIds);
      return unused.has(index)
        && cited.includes(evidenceId)
        && cited.filter((id) => requiredEvidenceIds.includes(id)).length === 1;
    });
    if (matchingIndex < 0) return true;
    unused.delete(matchingIndex);
    return false;
  });
}

function explainsSignificance(value: string): boolean {
  return /重要|值得|意味|因此|所以|表明|说明|依据|基线|语境|支持|用于|使得|影响|关系|反映|复核|能够|有助|起点|持续|风险|确认|验证|matters?|means?|supports?|because|therefore/i.test(value);
}

function profile(summaryCharacters: number, basis: number, analysis: number, portfolioImpacts: number, watchNext: number, conclusionEvidenceIds: number, explanationCharacters: number, evidenceRoles: EvidenceRole[]): DepthProfile {
  return { summaryCharacters, basis, analysis, portfolioImpacts, watchNext, conclusionEvidenceIds, explanationCharacters, evidenceRoles };
}

function evidenceRole(item: NarrationContext["evidence"][number]): EvidenceRole {
  const type = typeof item.value.type === "string" ? item.value.type : "";
  const evidenceType = typeof item.value.evidenceType === "string" ? item.value.evidenceType : "";
  if (item.kind === "limitation") return "limitation";
  if (item.kind === "portfolio_impact" || type === "portfolio_snapshot" || type === "risk_impact") return "portfolio";
  if (item.kind === "prior_run" || type === "previous_run") return "prior";
  if (type === "snapshot_context" || type === "market_status") return "quality";
  if (type === "research_fact") return "research";
  if (evidenceType === "news" || evidenceType === "announcement") return "external";
  return "market";
}

function claimableRole(role: EvidenceRole, key: string): boolean {
  if (role === "limitation" || role === "quality") return key === "data_quality";
  return true;
}

function limitationClaims(items: NarrationContext["evidence"]): LimitationClaim[] {
  if (!items.length) return [];
  const text = JSON.stringify(items).toLowerCase();
  const claims: LimitationClaim[] = ["generic"];
  if (/stale|freshness[^,]*(?:unknown|stale)|过期|陈旧/.test(text)) claims.push("stale");
  if (/unavailable|missing|not[_ -]?available|缺失|缺少|不可用/.test(text)) claims.push("missing");
  if (/unreliable|conflict|degraded|不可靠|冲突|降级/.test(text) || items.some((item) => !item.reliable)) claims.push("unreliable");
  if (/provider[^,]*(?:delay|timeout|late)|latency|供应商[^，。]*(?:延迟|超时)|传输延迟/.test(text)) claims.push("provider_delay");
  if (/scope|omitted|范围|未纳入/.test(text)) claims.push("scope");
  return [...new Set(claims)];
}

function claimsInText(value: string): LimitationClaim[] {
  const claims: LimitationClaim[] = [];
  const text = value.toLowerCase();
  if (/stale|not fresh|过期|陈旧|非最新/.test(text)) claims.push("stale");
  if (/unavailable|missing|缺失|缺少|不可用|没有.*数据/.test(text)) claims.push("missing");
  if (/unreliable|conflict|degraded|不可靠|冲突|降级/.test(text)) claims.push("unreliable");
  if (/provider.*(?:delay|timeout|late)|供应商.*(?:延迟|超时)|传输延迟/.test(text)) claims.push("provider_delay");
  if (/scope|omitted|范围.*(?:不足|受限)|未纳入/.test(text)) claims.push("scope");
  return claims.length ? [...new Set(claims)] : ["generic"];
}

function substantiveCharacters(value: string): number {
  return Array.from(value.normalize("NFKC")).filter((character) => /[\p{L}\p{N}]/u.test(character)).length;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => record(item) !== null) : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
