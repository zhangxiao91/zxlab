import { researchFactFailure } from "./research-fact-reader.ts";
import { financialToolRuntimeFailure } from "./financial-tool-runtime.ts";

export interface RunFailureRepository {
  fail(runId: string, leaseToken: string, code: string): Promise<boolean>;
  defer(runId: string, leaseToken: string, code: string): Promise<boolean>;
}

export async function settleRunFailure(
  runs: RunFailureRepository,
  runId: string,
  leaseToken: string,
  cause: unknown,
  fallbackCode: string,
): Promise<"ack" | "retry"> {
  const classified = financialToolRuntimeFailure(cause) ?? researchFactFailure(cause);
  if (classified && !classified.retryable) {
    await runs.fail(runId, leaseToken, classified.code);
    return "ack";
  }
  return await runs.defer(runId, leaseToken, classified?.code ?? fallbackCode) ? "retry" : "ack";
}
