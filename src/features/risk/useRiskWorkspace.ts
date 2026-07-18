import { useCallback, useEffect, useMemo, useState } from "react";
import { previewCsv } from "./csv";
import { LocalPortfolioRepository } from "./ledger";
import type { CsvFieldMapping, CsvPreview, MarketProviderMode, RiskDashboardData } from "./types";
import { RiskWorkspaceService } from "./workspace";

const serverValues = new Map<string, string>();
const serverStorage: Storage = {
  get length() { return serverValues.size; },
  clear: () => serverValues.clear(),
  getItem: (key) => serverValues.get(key) ?? null,
  key: (index) => [...serverValues.keys()][index] ?? null,
  removeItem: (key) => { serverValues.delete(key); },
  setItem: (key, value) => { serverValues.set(key, value); },
};

export function useRiskWorkspace() {
  const service = useMemo(() => new RiskWorkspaceService(new LocalPortfolioRepository(typeof window === "undefined" ? serverStorage : window.localStorage)), []);
  const [data, setData] = useState<RiskDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => { setLoading(true); try { setData(await service.load()); setError(null); } catch (reason) { setError(reason instanceof Error ? reason.message : "工作区加载失败"); } finally { setLoading(false); } }, [service]);
  useEffect(() => { void reload(); }, [reload]);
  return {
    data, loading, error, reload,
    previewCsv: (text: string, mapping?: CsvFieldMapping): CsvPreview => previewCsv(text, mapping, data?.transactions ?? []),
    importTransactions: async (preview: CsvPreview) => { const result = service.importTransactions(preview.valid); await reload(); return result; },
    clear: async () => { service.clear(); await reload(); },
    restoreMock: async () => { service.restoreMock(); await reload(); },
    setMode: async (mode: MarketProviderMode) => { service.setMode(mode); await reload(); },
    saveBrokerQuantity: async (instrumentId: string, quantity: number, averageCost: number | null) => { service.saveBrokerQuantity(instrumentId, quantity, averageCost); await reload(); },
  };
}
