import { riskMockData } from "./mock";
import type { RiskDashboardData } from "./types";

const API_BASE = import.meta.env.PUBLIC_RISK_API_URL ?? "http://127.0.0.1:8421";

export async function loadRiskDashboard(): Promise<{ data: RiskDashboardData; mode: "api" | "mock" }> {
  try {
    const response = await fetch(`${API_BASE}/api/risk/dashboard`, { signal: AbortSignal.timeout(1800) });
    if (!response.ok) throw new Error(`Risk API returned ${response.status}`);
    return { data: (await response.json()) as RiskDashboardData, mode: "api" };
  } catch {
    return { data: riskMockData, mode: "mock" };
  }
}
