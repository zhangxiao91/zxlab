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
  if (!current?.feedback) return incoming;
  if (
    incoming.feedback
    && incoming.feedback.updatedAt >= current.feedback.updatedAt
  ) {
    return incoming;
  }
  return { ...incoming, feedback: current.feedback };
}

export function mergeRunPageWithCurrentFeedback(
  current: AgentRunView[],
  incoming: AgentRunView[],
): AgentRunView[] {
  const currentById = new Map(current.map((run) => [run.id, run]));
  return incoming.map((run) => mergeRunWithCurrentFeedback(currentById.get(run.id), run));
}
