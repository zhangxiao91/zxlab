import { researchFactFailure } from "./research-fact-reader.ts";

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
  const research = researchFactFailure(cause);
  if (research && !research.retryable) {
    await runs.fail(runId, leaseToken, research.code);
    return "ack";
  }
  await runs.defer(runId, leaseToken, research?.code ?? fallbackCode);
  return "retry";
}
