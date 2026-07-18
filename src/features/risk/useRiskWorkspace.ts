import { useCallback, useEffect, useMemo, useState } from "react";
import { previewCsv } from "./csv";
import { LocalPortfolioRepository } from "./ledger";
import { ApiReviewError, ApiReviewService, LocalReviewRepository, MockReviewService } from "./review";
import type { CsvFieldMapping, CsvPreview, MarketProviderMode, ReviewResult, RiskDashboardData } from "./types";
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

function withReview(data: RiskDashboardData, review: ReviewResult): RiskDashboardData {
  return {
    ...data,
    review,
    sourceHealth: data.sourceHealth.map((source) => source.name === "Review Service" ? {
      ...source,
      status: review.mode === "llm" ? "healthy" : review.fallbackReason ? "degraded" : "healthy",
      latency: review.mode === "llm" ? "项目网关" : "本地",
      freshness: review.mode === "llm" ? `${review.provider}/${review.model}${review.fallbackIndex ? ` · 第 ${review.fallbackIndex + 1} 候选` : ""}` : review.fallbackReason ? `Mock 降级 · ${review.fallbackReason}` : "Mock / Evidence Pack",
    } : source),
  };
}

export function useRiskWorkspace() {
  const storage = typeof window === "undefined" ? serverStorage : window.localStorage;
  const service = useMemo(() => new RiskWorkspaceService(new LocalPortfolioRepository(storage)), [storage]);
  const reviewRepository = useMemo(() => new LocalReviewRepository(storage), [storage]);
  const apiReviewService = useMemo(() => new ApiReviewService(), []);
  const [data, setData] = useState<RiskDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const next = await service.load();
      const cached = reviewRepository.find(next.review.evidencePackFingerprint);
      setData(withReview(next, cached ?? next.review));
      setReviewError(null);
      setError(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "工作区加载失败"); }
    finally { setLoading(false); }
  }, [service, reviewRepository]);
  useEffect(() => { void reload(); }, [reload]);

  const generateReview = useCallback(async () => {
    if (!data || reviewLoading) return;
    setReviewLoading(true); setReviewError(null);
    try {
      const review = await apiReviewService.review(data.evidencePack);
      if (review.mode === "llm") reviewRepository.save(review);
      else setReviewError(`真实复盘已降级：${review.fallbackReason ?? "上游结果未通过校验"}`);
      setData((current) => current ? withReview(current, review) : current);
    } catch (reason) {
      const code = reason instanceof ApiReviewError ? reason.code : reason instanceof Error ? reason.name : "UNKNOWN";
      const review = await new MockReviewService(code).review(data.evidencePack);
      setReviewError(`真实复盘请求失败：${code}`);
      setData((current) => current ? withReview(current, review) : current);
    } finally { setReviewLoading(false); }
  }, [apiReviewService, data, reviewLoading, reviewRepository]);

  return {
    data, loading, error, reviewLoading, reviewError, reload, generateReview,
    previewCsv: (text: string, mapping?: CsvFieldMapping): CsvPreview => previewCsv(text, mapping, data?.transactions ?? []),
    importTransactions: async (preview: CsvPreview) => { const result = service.importTransactions(preview.valid); await reload(); return result; },
    clear: async () => { service.clear(); reviewRepository.clear(); await reload(); },
    restoreMock: async () => { service.restoreMock(); reviewRepository.clear(); await reload(); },
    setMode: async (mode: MarketProviderMode) => { service.setMode(mode); await reload(); },
    saveBrokerQuantity: async (instrumentId: string, quantity: number, averageCost: number | null) => { service.saveBrokerQuantity(instrumentId, quantity, averageCost); await reload(); },
  };
}
