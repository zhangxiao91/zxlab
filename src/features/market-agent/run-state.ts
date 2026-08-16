import type { AgentFeedback, RunTraceEvent } from "@zxlab/market-agent-schema";
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

export function mergeRunTraceEvents(
  persisted: RunTraceEvent[],
  streamed: RunTraceEvent[],
): RunTraceEvent[] {
  const byId = new Map<string, RunTraceEvent>();
  const bySequence = new Map<number, string>();
  for (const event of [...persisted, ...streamed]) {
    const existingAtSequence = bySequence.get(event.sequence);
    if (existingAtSequence && existingAtSequence !== event.id) throw new Error("RUN_TRACE_SEQUENCE_CONFLICT");
    const existingById = byId.get(event.id);
    if (existingById && existingById.sequence !== event.sequence) throw new Error("RUN_TRACE_ID_CONFLICT");
    bySequence.set(event.sequence, event.id);
    byId.set(event.id, event);
  }
  return [...byId.values()].sort((left, right) => (
    left.sequence - right.sequence || left.id.localeCompare(right.id)
  ));
}

export function retryKeyForRun(
  keys: Map<string, string>,
  sourceRunId: string,
  create: () => string = () => `retry:${sourceRunId}:${crypto.randomUUID()}`,
  storage?: Pick<Storage, "getItem" | "setItem">,
): string {
  const existing = keys.get(sourceRunId);
  if (existing) return existing;
  const persisted = readRetryKey(storage, sourceRunId);
  if (persisted) {
    keys.set(sourceRunId, persisted);
    return persisted;
  }
  const created = create();
  keys.set(sourceRunId, created);
  try { storage?.setItem(retryStorageKey(sourceRunId), created); } catch { /* storage unavailable */ }
  return created;
}

export function clearRetryKeyForRun(
  keys: Map<string, string>,
  sourceRunId: string,
  storage?: Pick<Storage, "removeItem">,
): void {
  keys.delete(sourceRunId);
  try { storage?.removeItem(retryStorageKey(sourceRunId)); } catch { /* storage unavailable */ }
}

function readRetryKey(storage: Pick<Storage, "getItem"> | undefined, sourceRunId: string): string | null {
  try {
    const value = storage?.getItem(retryStorageKey(sourceRunId));
    return typeof value === "string" && /^[A-Za-z0-9._:-]{8,180}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

function retryStorageKey(sourceRunId: string): string { return `zxlab:market-agent:retry:${sourceRunId}`; }
