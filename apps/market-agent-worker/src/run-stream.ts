import { isTerminalRunStatus, type AgentRun, type RunTraceEvent, type ToolTraceEvent } from "@zxlab/market-agent-schema";
import { MARKET_AGENT_RUN_STREAM_TIMEOUT_MS } from "./runtime-budget.ts";

export interface RunStreamRepository {
  get(runId: string): Promise<AgentRun | null>;
  listTraceAfter(runId: string, profileId: string, afterSequence: number): Promise<RunTraceEvent[]>;
  listToolTraceAfter?(runId: string, profileId: string, afterSequence: number): Promise<ToolTraceEvent[]>;
}

export interface RunStreamOptions {
  initialRun?: AgentRun;
  pollMs?: number;
  timeoutMs?: number;
  deltaDelayMs?: number;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

export function createRunEventStream(
  request: Request,
  repository: RunStreamRepository,
  runId: string,
  profileId: string,
  options: RunStreamOptions = {},
): Response {
  const encoder = new TextEncoder();
  const pollMs = options.pollMs ?? 500;
  const timeoutMs = options.timeoutMs ?? MARKET_AGENT_RUN_STREAM_TIMEOUT_MS;
  const deltaDelayMs = options.deltaDelayMs ?? 18;
  const wait = options.wait ?? abortableWait;
  const now = options.now ?? Date.now;
  let cancelled = false;

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, value: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`));
      };
      const close = () => {
        try { controller.close(); } catch { /* stream already closed */ }
      };

      void (async () => {
        const startedAt = now();
        let current = options.initialRun;
        let lastStatus = "";
        let lastTraceSequence = 0;
        let lastToolTraceSequence = 0;
        let lastHeartbeatAt = startedAt;

        while (!cancelled && !request.signal.aborted) {
          current ??= await repository.get(runId) ?? undefined;
          if (!current || current.profileId !== profileId) {
            send("error", { code: "RUN_NOT_FOUND" });
            close();
            return;
          }

          const traceEvents = await repository.listTraceAfter(runId, profileId, lastTraceSequence);
          for (const event of traceEvents) {
            if (event.sequence <= lastTraceSequence) continue;
            send("trace", { event });
            lastTraceSequence = event.sequence;
          }
          if (repository.listToolTraceAfter) {
            const toolTraceEvents = await repository.listToolTraceAfter(runId, profileId, lastToolTraceSequence);
            for (const event of toolTraceEvents) {
              if (event.sequence <= lastToolTraceSequence) continue;
              send("tool_trace", { event });
              lastToolTraceSequence = event.sequence;
            }
          }

          if (isTerminalRunStatus(current.status)) {
            if (current.result) {
              for (const delta of answerDeltas(current)) {
                if (cancelled || request.signal.aborted) return close();
                send("answer_delta", { delta });
                if (deltaDelayMs > 0) await wait(deltaDelayMs, request.signal);
              }
            }
            send("done", { run: current });
            close();
            return;
          }

          if (current.status !== lastStatus) {
            lastStatus = current.status;
            send("status", { run: current });
          }

          if (now() - startedAt >= timeoutMs) {
            send("error", { code: "RUN_STREAM_TIMEOUT" });
            close();
            return;
          }

          if (now() - lastHeartbeatAt >= 10_000) {
            controller.enqueue(encoder.encode(": keep-alive\n\n"));
            lastHeartbeatAt = now();
          }

          await wait(pollMs, request.signal);
          current = await repository.get(runId) ?? undefined;
        }
        close();
      })().catch((cause) => {
        if (!cancelled && !request.signal.aborted) {
          const code = cause instanceof DOMException && cause.name === "AbortError"
            ? "RUN_STREAM_ABORTED"
            : "RUN_STREAM_UNAVAILABLE";
          try { send("error", { code }); } catch { /* stream already closed */ }
        }
        close();
      });
    },
    cancel() {
      cancelled = true;
    },
  });

  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "private, no-store, no-transform",
      connection: "keep-alive",
      "x-content-type-options": "nosniff",
    },
  });
}

function answerDeltas(run: AgentRun): string[] {
  const text = [run.result?.headline, run.result?.summary]
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n\n");
  if (!text) return [];
  const deltas: string[] = [];
  let current = "";
  for (const character of text) {
    current += character;
    if (current.length >= 4 || /[，。！？；\n]/.test(character)) {
      deltas.push(current);
      current = "";
    }
  }
  if (current) deltas.push(current);
  return deltas;
}

function abortableWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
