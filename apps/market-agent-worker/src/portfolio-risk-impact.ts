import type { MarketSnapshot } from "@zxlab/market-schema";
import type { PortfolioSnapshot } from "@zxlab/market-agent-schema";
import { calculateRiskImpact, type RiskImpact } from "@zxlab/risk-domain";

export interface PortfolioRiskImpactEvaluation {
  snapshot: PortfolioSnapshot;
  impact: RiskImpact | null;
  reliable: boolean;
  limitations: string[];
}

export function evaluatePortfolioRiskImpact(snapshot: PortfolioSnapshot, market: MarketSnapshot, now = Date.now()): PortfolioRiskImpactEvaluation {
  if (snapshot.stoppedAt) {
    return {
      snapshot,
      impact: null,
      reliable: false,
      limitations: ["持仓快照已停止用于后续运行；本次仅保留市场模式。"],
    };
  }
  if (Date.parse(snapshot.expiresAt) <= now) {
    return {
      snapshot,
      impact: null,
      reliable: false,
      limitations: ["持仓快照已过期；本次不会产生可靠估值或持仓影响结论。"],
    };
  }
  if (!snapshot.reliable) {
    return {
      snapshot,
      impact: null,
      reliable: false,
      limitations: ["持仓快照未通过字段完整性检查；本次仅保留市场模式。"],
    };
  }

  const quotes = new Map(market.data.quotes.map((quote) => [quote.instrumentId, quote]));
  const unavailable = snapshot.positions.flatMap((position) => {
    const quote = quotes.get(position.instrumentId);
    const trusted = quote
      && quote.price !== null
      && Number.isFinite(quote.price)
      && quote.quality === "live"
      && !quote.stale
      && quote.corroboration.status === "corroborated";
    return trusted ? [] : [position.instrumentId];
  });
  const impact = calculateRiskImpact(
    snapshot.positions.map((position) => {
      const quote = quotes.get(position.instrumentId);
      const trusted = quote
        && quote.price !== null
        && Number.isFinite(quote.price)
        && quote.quality === "live"
        && !quote.stale
        && quote.corroboration.status === "corroborated";
      return { instrumentId: position.instrumentId, quantity: position.quantity, averageCost: position.averageCost, lastPrice: trusted ? quote.price : null };
    }),
    snapshot.rulesVersion,
  );
  const limitations = [
    ...(market.quality.reliable ? [] : ["当前 Market Snapshot 不可靠；本次不会声称可靠持仓影响。"]),
    ...(unavailable.length ? [`以下持仓缺少可用于服务端估值的已校验行情：${unavailable.join(", ")}。`] : []),
    ...impact.warnings,
  ];
  return { snapshot, impact, reliable: market.quality.reliable && unavailable.length === 0 && impact.reliable, limitations };
}
