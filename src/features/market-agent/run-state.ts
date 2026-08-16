import type { AgentFeedback } from "@zxlab/market-agent-schema";
import type { AgentRunView } from "./client";

export function enqueueRunFeedback(
  queue: Map<string, Promise<AgentFeedback>>,
  runId: string,
  operation: () => Promise<AgentFeedback>,
): Promise<AgentFeedback> {
  const previous = queue.get(runId);
  const task = (previous ? previous.catch(() => undefined) : Promise.resolve())
    .then(operation);
  queue.set(runId, task);
  void task.finally(() => {
    if (queue.get(runId) === task) queue.delete(runId);
  }).catch(() => undefined);
  return task;
}

export function mergeRunWithCurrentFeedback(
  current: AgentRunView | undefined,
  incoming: AgentRunView,
): AgentRunView {
  if (incoming.payloadPurgedAt && incoming.feedback == null) return incoming;
  const withInput = current?.input !== undefined && incoming.input === undefined
    ? { ...incoming, input: current.input }
    : incoming;
  if (!current?.feedback) return withInput;
  if (
    withInput.feedback
    && withInput.feedback.updatedAt >= current.feedback.updatedAt
  ) {
    return withInput;
  }
  return { ...withInput, feedback: current.feedback };
}

export function mergeRunPageWithCurrentFeedback(
  current: AgentRunView[],
  incoming: AgentRunView[],
): AgentRunView[] {
  const currentById = new Map(current.map((run) => [run.id, run]));
  return incoming.map((run) => mergeRunWithCurrentFeedback(currentById.get(run.id), run));
}

export function mergeRunPagePreservingSelection(
  current: AgentRunView[],
  incoming: AgentRunView[],
  selectedRunId: string | null,
): AgentRunView[] {
  const merged = mergeRunPageWithCurrentFeedback(current, incoming);
  if (!selectedRunId || merged.some((run) => run.id === selectedRunId)) return merged;
  const selected = current.find((run) => run.id === selectedRunId);
  return selected ? [...merged, selected] : merged;
}

export function resolveSelectedRun(
  runs: AgentRunView[],
  selectedRunId: string | null,
): AgentRunView | undefined {
  return runs.find((run) => run.id === selectedRunId) ?? runs[0];
}

export function evidenceSelectionAfterRunSelection(
  currentRunId: string | null,
  nextRunId: string,
  currentEvidenceId: string | null,
): string | null {
  return currentRunId === nextRunId ? currentEvidenceId : null;
}
