import type {
  LlmDiagnostics,
  MarketDiagnostics,
  MemoryCandidate,
  PortfolioDiagnostics,
  ReviewFeedback,
  ReviewItemFeedback,
  ReviewRun,
} from "./types";

const RUNS_KEY = "zxlab.risk.review-runs.v1";
const FEEDBACK_KEY = "zxlab.risk.review-feedback.v1";
const MEMORY_KEY = "zxlab.risk.memory-candidates.v1";
const OPERATIONS_KEY = "zxlab.risk.operations.v1";
const MAX_REVIEW_RUNS = 120;

export interface OperationalState {
  completedDates: string[];
  market: MarketDiagnostics;
  portfolio: PortfolioDiagnostics;
  llm: LlmDiagnostics;
}

export interface RiskJournalSnapshot {
  reviews: ReviewRun[];
  reviewFeedback: ReviewFeedback[];
  memoryCandidates: MemoryCandidate[];
  operations: OperationalState;
}

const emptyMarket = (): MarketDiagnostics => ({ provider: "尚未执行", lastSuccessAt: null, lastFailureAt: null, requestDurationMs: null, dataTimestamp: null, stale: true, snapshotStatus: "unavailable", warnings: [], errors: [] });
const emptyPortfolio = (): PortfolioDiagnostics => ({ lastImportAt: null, successRows: 0, duplicateRows: 0, failedRows: 0, unknownInstruments: [], reconciliationDifferences: 0 });
const emptyLlm = (): LlmDiagnostics => ({ provider: null, model: null, fallbackPath: [], promptVersion: "portfolio-review.v2", requestDurationMs: null, inputTokens: null, outputTokens: null, estimatedCost: null, schemaValidation: "not-run", retryCount: null, finalError: null });
const emptyOperations = (): OperationalState => ({ completedDates: [], market: emptyMarket(), portfolio: emptyPortfolio(), llm: emptyLlm() });

function isObject(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function isRun(value: unknown): value is ReviewRun { return isObject(value) && typeof value.id === "string" && typeof value.reviewDate === "string" && typeof value.createdAt === "string" && isObject(value.evidencePack) && isObject(value.riskSnapshot) && ["pending", "success", "partial", "failed"].includes(String(value.status)); }
function isFeedback(value: unknown): value is ReviewFeedback { return isObject(value) && typeof value.id === "string" && typeof value.reviewRunId === "string" && Array.isArray(value.itemFeedback); }
function isMemory(value: unknown): value is MemoryCandidate { return isObject(value) && typeof value.id === "string" && typeof value.sourceReviewId === "string" && typeof value.content === "string" && ["pending", "accepted", "rejected"].includes(String(value.status)); }

export class LocalRiskJournalRepository {
  constructor(private readonly storage: Storage) {}

  listRuns(): ReviewRun[] { return this.readArray(RUNS_KEY, isRun).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  findRun(id: string): ReviewRun | null { return this.listRuns().find((run) => run.id === id) ?? null; }
  saveRun(run: ReviewRun): void {
    const runs = [run, ...this.listRuns().filter((item) => item.id !== run.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, MAX_REVIEW_RUNS);
    this.storage.setItem(RUNS_KEY, JSON.stringify(runs));
  }

  listFeedback(): ReviewFeedback[] { return this.readArray(FEEDBACK_KEY, isFeedback); }
  saveFeedback(runId: string, input: Omit<ReviewFeedback, "id" | "reviewRunId" | "createdAt" | "updatedAt">): ReviewFeedback {
    const existing = this.listFeedback().find((item) => item.reviewRunId === runId);
    const now = new Date().toISOString();
    const feedback: ReviewFeedback = { ...input, id: existing?.id ?? crypto.randomUUID(), reviewRunId: runId, createdAt: existing?.createdAt ?? now, updatedAt: now };
    this.storage.setItem(FEEDBACK_KEY, JSON.stringify([feedback, ...this.listFeedback().filter((item) => item.reviewRunId !== runId)]));
    const run = this.findRun(runId);
    if (run) this.saveRun({ ...run, userFeedback: feedback });
    this.syncMemoryCandidates(runId, feedback);
    return feedback;
  }

  listMemoryCandidates(): MemoryCandidate[] { return this.readArray(MEMORY_KEY, isMemory).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  setMemoryStatus(id: string, status: MemoryCandidate["status"]): void {
    this.storage.setItem(MEMORY_KEY, JSON.stringify(this.listMemoryCandidates().map((item) => item.id === id ? { ...item, status } : item)));
  }

  getOperations(): OperationalState {
    const parsed = this.readObject(OPERATIONS_KEY);
    if (!parsed) return emptyOperations();
    return {
      completedDates: Array.isArray(parsed.completedDates) ? parsed.completedDates.filter((item): item is string => typeof item === "string") : [],
      market: isObject(parsed.market) ? { ...emptyMarket(), ...parsed.market } as MarketDiagnostics : emptyMarket(),
      portfolio: isObject(parsed.portfolio) ? { ...emptyPortfolio(), ...parsed.portfolio } as PortfolioDiagnostics : emptyPortfolio(),
      llm: isObject(parsed.llm) ? { ...emptyLlm(), ...parsed.llm } as LlmDiagnostics : emptyLlm(),
    };
  }
  saveMarket(diagnostics: MarketDiagnostics): void { this.saveOperations({ ...this.getOperations(), market: diagnostics }); }
  savePortfolio(diagnostics: PortfolioDiagnostics): void { this.saveOperations({ ...this.getOperations(), portfolio: diagnostics }); }
  saveLlm(diagnostics: LlmDiagnostics): void { this.saveOperations({ ...this.getOperations(), llm: diagnostics }); }
  completeDate(date: string): void { const state = this.getOperations(); this.saveOperations({ ...state, completedDates: [...new Set([date, ...state.completedDates])].slice(0, 365) }); }
  isDateComplete(date: string): boolean { return this.getOperations().completedDates.includes(date); }

  snapshot(): RiskJournalSnapshot { return { reviews: this.listRuns(), reviewFeedback: this.listFeedback(), memoryCandidates: this.listMemoryCandidates(), operations: this.getOperations() }; }
  restore(snapshot: RiskJournalSnapshot, mode: "merge" | "overwrite"): void {
    if (mode === "overwrite") {
      this.storage.setItem(RUNS_KEY, JSON.stringify(snapshot.reviews.slice(0, MAX_REVIEW_RUNS)));
      this.storage.setItem(FEEDBACK_KEY, JSON.stringify(snapshot.reviewFeedback));
      this.storage.setItem(MEMORY_KEY, JSON.stringify(snapshot.memoryCandidates));
      this.saveOperations(snapshot.operations);
      return;
    }
    this.storage.setItem(RUNS_KEY, JSON.stringify(mergeById(this.listRuns(), snapshot.reviews).slice(0, MAX_REVIEW_RUNS)));
    this.storage.setItem(FEEDBACK_KEY, JSON.stringify(mergeById(this.listFeedback(), snapshot.reviewFeedback)));
    this.storage.setItem(MEMORY_KEY, JSON.stringify(mergeById(this.listMemoryCandidates(), snapshot.memoryCandidates)));
    const current = this.getOperations();
    this.saveOperations({
      completedDates: [...new Set([...current.completedDates, ...snapshot.operations.completedDates])],
      market: newerDiagnostics(current.market, snapshot.operations.market),
      portfolio: newerDiagnostics(current.portfolio, snapshot.operations.portfolio),
      llm: newerDiagnostics(current.llm, snapshot.operations.llm),
    });
  }
  clear(): void { [RUNS_KEY, FEEDBACK_KEY, MEMORY_KEY, OPERATIONS_KEY].forEach((key) => this.storage.removeItem(key)); }

  private syncMemoryCandidates(runId: string, feedback: ReviewFeedback): void {
    const existing = this.listMemoryCandidates();
    const additions: MemoryCandidate[] = [];
    const add = (source: string, content: string, category: MemoryCandidate["category"]) => {
      const trimmed = content.trim();
      if (!trimmed) return;
      const id = `memory:${feedback.id}:${source}`;
      const previous = existing.find((item) => item.id === id);
      additions.push({ id, sourceReviewId: runId, sourceFeedbackId: feedback.id, category, content: trimmed.slice(0, 2_000), status: previous?.status ?? "pending", createdAt: previous?.createdAt ?? new Date().toISOString() });
    };
    add("overall", feedback.note, "one-off-context");
    feedback.itemFeedback.forEach((item: ReviewItemFeedback) => add(item.reviewItemId, item.correction, item.rating === "missing-context" ? "strategy-context" : "one-off-context"));
    const additionIds = new Set(additions.map((item) => item.id));
    const next = [...additions, ...existing.filter((item) => item.sourceFeedbackId !== feedback.id || !additionIds.has(item.id))];
    this.storage.setItem(MEMORY_KEY, JSON.stringify(next));
  }
  private saveOperations(state: OperationalState): void { this.storage.setItem(OPERATIONS_KEY, JSON.stringify(state)); }
  private readObject(key: string): Record<string, unknown> | null { try { const value = JSON.parse(this.storage.getItem(key) ?? "null") as unknown; return isObject(value) ? value : null; } catch { return null; } }
  private readArray<T>(key: string, guard: (value: unknown) => value is T): T[] { try { const value = JSON.parse(this.storage.getItem(key) ?? "[]") as unknown; return Array.isArray(value) ? value.filter(guard) : []; } catch { return []; } }
}

function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] { const ids = new Set(current.map((item) => item.id)); return [...current, ...incoming.filter((item) => !ids.has(item.id))]; }
function newerDiagnostics<T>(current: T, incoming: T): T { return JSON.stringify(incoming).length > JSON.stringify(current).length ? incoming : current; }
