import { useCallback, useEffect, useMemo, useState } from "react";
import { createRiskBackup, previewRiskBackup, restoreRiskBackup, type BackupPreview } from "./backup";
import { previewCsv } from "./csv";
import { LocalRiskJournalRepository } from "./journal";
import { LocalPortfolioRepository } from "./ledger";
import { instruments, mockRiskRules, mockTradePlans } from "./mock";
import { ApiReviewError, ApiReviewService, LocalReviewRepository, MockReviewService } from "./review";
import type { CsvFieldMapping, CsvPreview, MarketProviderMode, ReviewItemFeedback, ReviewResult, ReviewRun, RiskDashboardData } from "./types";
import { EVIDENCE_SCHEMA_VERSION, RISK_RULE_VERSION, RiskWorkspaceService } from "./workspace";

const serverValues = new Map<string, string>();
const serverStorage: Storage = {
  get length() { return serverValues.size; }, clear: () => serverValues.clear(), getItem: (key) => serverValues.get(key) ?? null,
  key: (index) => [...serverValues.keys()][index] ?? null, removeItem: (key) => { serverValues.delete(key); }, setItem: (key, value) => { serverValues.set(key, value); },
};

function withReview(data: RiskDashboardData, review: ReviewResult, runs = data.reviewRuns): RiskDashboardData {
  const run = runs.find((item) => item.result?.evidencePackFingerprint === review.evidencePackFingerprint);
  return {
    ...data,
    review,
    reviewRuns: runs,
    memoryCandidates: data.memoryCandidates,
    workflow: data.workflow.map((step) => step.id === "review" ? {
      ...step,
      status: run?.status === "success" ? "success" : run?.status === "partial" ? "warning" : run?.status === "failed" ? "error" : review.mode === "llm" ? "success" : "pending",
      detail: run ? `本日运行 ${run.status}` : review.mode === "llm" ? "真实复盘已生成" : "等待手动生成",
    } : step),
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
  const portfolioRepository = useMemo(() => new LocalPortfolioRepository(storage), [storage]);
  const journal = useMemo(() => new LocalRiskJournalRepository(storage), [storage]);
  const service = useMemo(() => new RiskWorkspaceService(portfolioRepository, journal), [portfolioRepository, journal]);
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
      const currentRun = next.reviewRuns.find((run) => run.reviewDate === next.analysisDate && run.result?.evidencePackFingerprint === next.review.evidencePackFingerprint);
      const cached = currentRun?.result ?? reviewRepository.find(next.review.evidencePackFingerprint);
      setData(withReview(next, cached ?? next.review));
      setReviewError(null); setError(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "工作区加载失败"); }
    finally { setLoading(false); }
  }, [service, reviewRepository]);
  useEffect(() => { void reload(); }, [reload]);

  const generateReview = useCallback(async () => {
    if (!data || reviewLoading) return;
    setReviewLoading(true); setReviewError(null);
    const createdAt = new Date().toISOString();
    const runId = crypto.randomUUID();
    const pending = createRun(data, runId, createdAt);
    journal.saveRun(pending);
    setData((current) => current ? { ...current, reviewRuns: journal.listRuns(), workflow: current.workflow.map((step) => step.id === "review" ? { ...step, status: "running", detail: "正在调用项目 LLM Gateway" } : step) } : current);
    try {
      const execution = await apiReviewService.review(data.evidencePack);
      const run: ReviewRun = { ...pending, status: execution.status, result: execution.result, rawStructuredOutput: execution.rawStructuredOutput, provider: execution.provider, model: execution.model, fallbackPath: execution.fallbackPath, requestDurationMs: execution.requestDurationMs, inputTokens: execution.inputTokens, outputTokens: execution.outputTokens, estimatedCost: execution.estimatedCost, promptVersion: execution.promptVersion, warnings: execution.warnings, errors: execution.errors };
      journal.saveRun(run);
      journal.saveLlm({ provider: execution.provider, model: execution.model, fallbackPath: execution.fallbackPath, promptVersion: execution.promptVersion, requestDurationMs: execution.requestDurationMs, inputTokens: execution.inputTokens, outputTokens: execution.outputTokens, estimatedCost: execution.estimatedCost, schemaValidation: execution.schemaValidation, retryCount: execution.retryCount, finalError: execution.errors.at(-1) ?? null });
      if (execution.result.mode === "llm") reviewRepository.save(execution.result);
      if (execution.status !== "success") setReviewError(`真实复盘为 ${execution.status}：${execution.warnings[0] ?? execution.errors[0] ?? "部分字段未通过校验"}`);
      setData((current) => current ? { ...withReview(current, execution.result, journal.listRuns()), memoryCandidates: journal.listMemoryCandidates(), diagnostics: { ...current.diagnostics, llm: journal.getOperations().llm } } : current);
    } catch (reason) {
      const code = reason instanceof ApiReviewError ? reason.code : reason instanceof Error ? reason.name : "UNKNOWN";
      const fallback = await new MockReviewService(code).review(data.evidencePack);
      const failed: ReviewRun = { ...pending, status: "failed", result: fallback.result, provider: fallback.provider, model: fallback.model, fallbackPath: fallback.fallbackPath, requestDurationMs: fallback.requestDurationMs, inputTokens: null, outputTokens: null, estimatedCost: null, promptVersion: fallback.promptVersion, warnings: fallback.warnings, errors: [code] };
      journal.saveRun(failed);
      journal.saveLlm({ provider: null, model: null, fallbackPath: fallback.fallbackPath, promptVersion: fallback.promptVersion, requestDurationMs: fallback.requestDurationMs, inputTokens: null, outputTokens: null, estimatedCost: null, schemaValidation: "failed", retryCount: null, finalError: code });
      setReviewError(`模型分析失败：${code}。确定性风险结果仍然保留。`);
      setData((current) => current ? { ...withReview(current, fallback.result, journal.listRuns()), diagnostics: { ...current.diagnostics, llm: journal.getOperations().llm } } : current);
    } finally { setReviewLoading(false); }
  }, [apiReviewService, data, journal, reviewLoading, reviewRepository]);

  return {
    data, loading, error, reviewLoading, reviewError, reload, generateReview,
    previewCsv: (text: string, mapping?: CsvFieldMapping): CsvPreview => previewCsv(text, mapping, data?.transactions ?? []),
    importTransactions: async (preview: CsvPreview) => {
      const result = service.importTransactions(preview.valid);
      const current = journal.getOperations().portfolio;
      journal.savePortfolio({ ...current, lastImportAt: new Date().toISOString(), successRows: result.added.length, duplicateRows: preview.duplicates.length + result.duplicates.length, failedRows: preview.invalid.length });
      await reload(); return result;
    },
    clear: async () => { service.clear(); reviewRepository.clear(); journal.clear(); await reload(); },
    restoreMock: async () => { service.restoreMock(); reviewRepository.clear(); await reload(); },
    setMode: async (mode: MarketProviderMode) => { service.setMode(mode); await reload(); },
    saveBrokerQuantity: async (instrumentId: string, quantity: number, averageCost: number | null) => { service.saveBrokerQuantity(instrumentId, quantity, averageCost); await reload(); },
    saveFeedback: async (runId: string, input: { helpful: boolean | null; hasFactErrors: boolean; missingKeyFactors: boolean; note: string; itemFeedback: ReviewItemFeedback[] }) => { journal.saveFeedback(runId, input); await reload(); },
    setMemoryStatus: async (id: string, status: "accepted" | "rejected") => { journal.setMemoryStatus(id, status); await reload(); },
    completeToday: async () => { if (!data) return; journal.completeDate(data.analysisDate); await reload(); },
    exportBackup: () => {
      const backup = createRiskBackup(portfolioRepository, journal, { tradePlans: mockTradePlans, riskRules: mockRiskRules, instruments });
      return { filename: `zxlab-risk-backup-${backup.exportedAt.slice(0, 10)}.json`, content: JSON.stringify(backup, null, 2) };
    },
    previewBackup: (text: string): BackupPreview => previewRiskBackup(JSON.parse(text) as unknown, portfolioRepository, journal),
    restoreBackup: async (preview: BackupPreview, mode: "merge" | "overwrite") => { restoreRiskBackup(preview, mode, portfolioRepository, journal); reviewRepository.clear(); await reload(); },
  };
}

function createRun(data: RiskDashboardData, id: string, createdAt: string): ReviewRun {
  return {
    id, reviewDate: data.analysisDate, createdAt,
    evidencePack: data.evidencePack,
    riskSnapshot: { calculatedAt: data.riskCalculatedAt, portfolio: data.portfolio, positions: data.positions, metrics: data.riskMetrics, events: data.riskEvents, reconciliation: data.reconciliation, warnings: data.dataWarnings },
    marketDataTimestamp: data.diagnostics.market.dataTimestamp,
    riskRuleVersion: RISK_RULE_VERSION,
    evidenceSchemaVersion: EVIDENCE_SCHEMA_VERSION,
    promptVersion: "portfolio-review.v2",
    provider: "pending", model: "pending", fallbackPath: [], requestDurationMs: null, inputTokens: null, outputTokens: null, estimatedCost: null,
    status: "pending", result: null, warnings: [], errors: [],
  };
}
