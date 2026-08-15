import type {
  AskScope,
  MarketAgentAskCommand,
  PortfolioSnapshot,
  SealedEvidenceBundle,
} from "@zxlab/market-agent-schema";
import type {
  MarketInterval,
  MarketQuoteMode,
  MarketSnapshotInclude,
} from "@zxlab/market-schema";
import type { ResearchPurpose } from "@zxlab/research-fact-schema";
import type { WatchlistItemInput } from "./profile-repository.ts";

export interface AskEvidencePlan {
  scope: AskScope;
  label: string;
  requiresInstrument: boolean;
  requiresWatchlist: boolean;
  requiresPortfolioSnapshot: boolean;
  requiresPreviousRun: boolean;
  instrumentSelection: "selected" | "selected-and-watchlist" | "selected-or-watchlist" | "portfolio" | "previous-run";
  intervals: MarketInterval[];
  include: MarketSnapshotInclude[];
  quoteMode: MarketQuoteMode;
  requiresCorroboratedQuotes: boolean;
  researchPurpose?: ResearchPurpose;
}

export const ASK_PLAN_VERSION = "ask-plan.v1" as const;

const plans: Record<AskScope, AskEvidencePlan> = {
  today_change: {
    scope: "today_change",
    label: "今日变化",
    requiresInstrument: true,
    requiresWatchlist: false,
    requiresPortfolioSnapshot: false,
    requiresPreviousRun: false,
    instrumentSelection: "selected",
    intervals: ["1d", "1m"],
    include: ["quotes", "bars"],
    quoteMode: "corroborated",
    requiresCorroboratedQuotes: true,
    researchPurpose: "price_context",
  },
  relative_performance: {
    scope: "relative_performance",
    label: "相对观察列表表现",
    requiresInstrument: true,
    requiresWatchlist: true,
    requiresPortfolioSnapshot: false,
    requiresPreviousRun: false,
    instrumentSelection: "selected-and-watchlist",
    intervals: ["1d"],
    include: ["quotes", "bars"],
    quoteMode: "corroborated",
    requiresCorroboratedQuotes: true,
    researchPurpose: "relative_performance",
  },
  news_and_announcements: {
    scope: "news_and_announcements",
    label: "新闻与公告",
    requiresInstrument: true,
    requiresWatchlist: false,
    requiresPortfolioSnapshot: false,
    requiresPreviousRun: false,
    instrumentSelection: "selected",
    intervals: ["1d"],
    include: ["quotes", "news", "announcements"],
    quoteMode: "fallback",
    requiresCorroboratedQuotes: false,
  },
  data_quality: {
    scope: "data_quality",
    label: "数据质量",
    requiresInstrument: false,
    requiresWatchlist: false,
    requiresPortfolioSnapshot: false,
    requiresPreviousRun: false,
    instrumentSelection: "selected-or-watchlist",
    intervals: ["1d"],
    include: ["quotes"],
    quoteMode: "corroborated",
    requiresCorroboratedQuotes: true,
  },
  portfolio_impact: {
    scope: "portfolio_impact",
    label: "持仓影响",
    requiresInstrument: false,
    requiresWatchlist: false,
    requiresPortfolioSnapshot: true,
    requiresPreviousRun: false,
    instrumentSelection: "portfolio",
    intervals: ["1d"],
    include: ["quotes", "bars"],
    quoteMode: "corroborated",
    requiresCorroboratedQuotes: true,
  },
  compare_previous_run: {
    scope: "compare_previous_run",
    label: "与上次运行比较",
    requiresInstrument: false,
    requiresWatchlist: false,
    requiresPortfolioSnapshot: false,
    requiresPreviousRun: true,
    instrumentSelection: "previous-run",
    intervals: ["1d"],
    include: ["quotes", "bars"],
    quoteMode: "corroborated",
    requiresCorroboratedQuotes: true,
  },
};

export function askEvidencePlan(scope: AskScope): AskEvidencePlan {
  return plans[scope];
}

export interface AskScopeResolution {
  instrumentIds: string[];
  clarification?: string;
}

export function resolveAskScope(
  command: Pick<MarketAgentAskCommand, "scope" | "instrumentId">,
  watchlist: { items: WatchlistItemInput[] } | null,
  portfolioSnapshot: PortfolioSnapshot | null,
  previousEvidence: Pick<SealedEvidenceBundle, "instrumentIds"> | null,
): AskScopeResolution {
  const plan = askEvidencePlan(command.scope);
  const selected = command.instrumentId?.trim().toUpperCase();
  const watchlistIds = watchlist?.items.map((item) => item.instrumentId) ?? [];
  const portfolioIds = portfolioSnapshot?.positions.map((item) => item.instrumentId) ?? [];
  const previousIds = previousEvidence?.instrumentIds ?? [];

  if (plan.requiresInstrument && !selected) {
    return { instrumentIds: [], clarification: "请选择一个标的后再提交这个问题。" };
  }
  if (plan.requiresWatchlist && !watchlistIds.length) {
    return { instrumentIds: [], clarification: "请先确认观察列表，才能比较相对表现。" };
  }
  if (plan.requiresPortfolioSnapshot && !portfolioSnapshot) {
    return { instrumentIds: [], clarification: "请先同步一份仍在有效期内的持仓快照，才能分析持仓影响。" };
  }
  if (plan.requiresPreviousRun && !previousEvidence) {
    return { instrumentIds: [], clarification: "请选择一条已完成且仍保留 Evidence 的历史运行。" };
  }

  let raw: string[];
  switch (plan.instrumentSelection) {
    case "selected": raw = selected ? [selected] : []; break;
    case "selected-and-watchlist": raw = selected ? [selected, ...watchlistIds] : []; break;
    case "selected-or-watchlist": raw = selected ? [selected] : watchlistIds; break;
    case "portfolio": {
      if (selected && !portfolioIds.includes(selected)) {
        return { instrumentIds: [], clarification: "所选标的不在当前持仓快照中，请改选当前持仓或留空以分析全部持仓。" };
      }
      raw = selected ? [selected] : portfolioIds;
      break;
    }
    case "previous-run": {
      if (selected && (previousIds.length !== 1 || previousIds[0] !== selected)) {
        return { instrumentIds: [], clarification: "历史运行比较会固定使用该次 Evidence 的完整标的范围，不能在这里临时改写范围。" };
      }
      raw = previousIds;
      break;
    }
  }

  const instrumentIds = [...new Set(raw)].sort();
  return instrumentIds.length
    ? { instrumentIds }
    : { instrumentIds: [], clarification: "当前范围没有可用于此问题的标的，请先选择标的或完成相应配置。" };
}
