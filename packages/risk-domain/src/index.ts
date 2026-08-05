export interface Position { instrumentId: string; quantity: number; averageCost: number; lastPrice: number | null; }
export interface RiskImpact { marketValue: number; costBasis: number; unrealizedPnl: number; concentration: Array<{ instrumentId: string; weight: number }>; reliable: boolean; warnings: string[]; rulesVersion: string; }

export function calculateRiskImpact(positions: readonly Position[], rulesVersion = "risk.v1"): RiskImpact {
  const priced = positions.filter((p) => Number.isFinite(p.quantity) && p.quantity >= 0 && p.lastPrice !== null && Number.isFinite(p.lastPrice));
  const marketValue = priced.reduce((sum, p) => sum + p.quantity * (p.lastPrice ?? 0), 0);
  const costBasis = positions.reduce((sum, p) => sum + (Number.isFinite(p.quantity) ? p.quantity : 0) * (Number.isFinite(p.averageCost) ? p.averageCost : 0), 0);
  const concentration = priced.map((p) => ({ instrumentId: p.instrumentId, weight: marketValue > 0 ? (p.quantity * (p.lastPrice ?? 0)) / marketValue : 0 })).sort((a, b) => b.weight - a.weight);
  const warnings = positions.length !== priced.length ? ["some positions lack reliable prices"] : [];
  return { marketValue, costBasis, unrealizedPnl: marketValue - costBasis, concentration, reliable: positions.length > 0 && warnings.length === 0, warnings, rulesVersion };
}

export function canonicalRiskFingerprint(impact: RiskImpact): string {
  return JSON.stringify({ marketValue: impact.marketValue, costBasis: impact.costBasis, unrealizedPnl: impact.unrealizedPnl, concentration: impact.concentration, reliable: impact.reliable, rulesVersion: impact.rulesVersion });
}
