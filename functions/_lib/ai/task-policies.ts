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
