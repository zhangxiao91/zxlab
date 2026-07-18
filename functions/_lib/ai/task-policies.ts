import type { GenerateAIInput } from "../../../src/lib/ai/types.ts";

export interface AITaskPolicy {
  timeoutMs: number;
  totalBudgetMs: number;
  maxOutputTokens: number;
  temperature: number;
}

export const TASK_POLICIES: Record<string, Partial<AITaskPolicy>> = {
  default: { timeoutMs: 30_000, totalBudgetMs: 75_000, maxOutputTokens: 1_500, temperature: 0.5 },
  "notes-summary": { maxOutputTokens: 1_200, temperature: 0.3 },
  "portfolio-review": { maxOutputTokens: 3_000, temperature: 0.2 },
  "signal-editorial-filter": { timeoutMs: 30_000, totalBudgetMs: 75_000, maxOutputTokens: 4_000, temperature: 0 },
  "signal-briefing": { timeoutMs: 30_000, totalBudgetMs: 75_000, maxOutputTokens: 4_000, temperature: 0 },
  "signal-annotation-reply": { timeoutMs: 20_000, totalBudgetMs: 40_000, maxOutputTokens: 1_200, temperature: 0.1 },
  "signal-memory-extraction": { timeoutMs: 20_000, totalBudgetMs: 40_000, maxOutputTokens: 800, temperature: 0 },
  "signal-memory-consolidation": { timeoutMs: 30_000, totalBudgetMs: 60_000, maxOutputTokens: 1_600, temperature: 0 },
};

export function resolveTaskPolicy(input: GenerateAIInput): AITaskPolicy {
  const defaults = TASK_POLICIES.default as AITaskPolicy;
  const task = TASK_POLICIES[input.task] ?? {};
  return {
    ...defaults,
    ...task,
    ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
    ...(input.maxOutputTokens === undefined ? {} : {
      maxOutputTokens: Math.min(input.maxOutputTokens, task.maxOutputTokens ?? defaults.maxOutputTokens),
    }),
  };
}
