import {
  parseResearchFactBundle,
  parseResearchFactRequest,
  verifyResearchFactBundleFingerprint,
  type ResearchFactBundle,
  type ResearchFactRequest,
} from "@zxlab/research-fact-schema";
import type { MarketSnapshot } from "@zxlab/market-schema";

export interface ResearchFactReader {
  materialize(input: ResearchFactRequest): Promise<ResearchFactBundle>;
}

export class ResearchFactError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, retryable: boolean, options?: ErrorOptions) {
    super(code, options);
    this.name = "ResearchFactError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function researchFactFailure(cause: unknown): { code: string; retryable: boolean } | null {
  return cause instanceof ResearchFactError ? { code: cause.code, retryable: cause.retryable } : null;
}

export interface ResearchInstrumentScope {
  instrumentIds: string[];
  omittedInstrumentIds: string[];
}

export function researchExpectedLatestSessionDate(snapshot: Pick<MarketSnapshot, "reference">): string | undefined {
  return snapshot.reference?.semantics === "last_effective_session"
    ? snapshot.reference.effectiveTradingDate ?? undefined
    : undefined;
}

export async function assertResearchFactScope(input: {
  research: ResearchFactBundle;
  purpose: ResearchFactBundle["purpose"] | undefined;
  instrumentIds: string[];
  observationCutoff: string;
  expectedLatestSessionDate: string | undefined;
  allowLegacyExpectedSession: boolean;
}): Promise<void> {
  const legacyExpectedSession = input.allowLegacyExpectedSession && input.research.expectedLatestSessionDate === undefined;
  if (
    !input.purpose
    || input.research.purpose !== input.purpose
    || input.research.observationCutoff !== input.observationCutoff
    || (!legacyExpectedSession && input.research.expectedLatestSessionDate !== input.expectedLatestSessionDate)
    || !sameValues(input.research.instrumentIds, input.instrumentIds)
    || !await verifyResearchFactBundleFingerprint(input.research)
  ) throw new ResearchFactError("RESEARCH_FACT_SCOPE_MISMATCH", false);
}

export function selectResearchInstrumentScope(instrumentIds: string[], selectedInstrumentId?: string, maximum = 20): ResearchInstrumentScope {
  const canonical = [...new Set(instrumentIds)].sort();
  const prioritized = selectedInstrumentId && canonical.includes(selectedInstrumentId)
    ? [selectedInstrumentId, ...canonical.filter((instrumentId) => instrumentId !== selectedInstrumentId)]
    : canonical;
  const selected = new Set(prioritized.slice(0, maximum));
  return {
    instrumentIds: canonical.filter((instrumentId) => selected.has(instrumentId)),
    omittedInstrumentIds: canonical.filter((instrumentId) => !selected.has(instrumentId)),
  };
}

export class ResearchFactAdapter implements ResearchFactReader {
  private readonly options: { service?: Fetcher; baseUrl?: string; token?: string; timeoutMs?: number };

  constructor(options: { service?: Fetcher; baseUrl?: string; token?: string; timeoutMs?: number }) {
    this.options = options;
  }

  async materialize(input: ResearchFactRequest): Promise<ResearchFactBundle> {
    const token = this.options.token?.trim();
    if (!token) throw new ResearchFactError("RESEARCH_FACT_CONFIGURATION_MISSING", false);
    let requestBody: ResearchFactRequest;
    try { requestBody = parseResearchFactRequest(input); }
    catch (cause) { throw new ResearchFactError("RESEARCH_FACT_REQUEST_INVALID", false, { cause }); }
    const base = this.options.baseUrl?.trim() || "https://market-api.zx-dx.xyz";
    const url = new URL("/api/market/research/facts", base);
    const headers = new Headers({ accept: "application/json", "content-type": "application/json" });
    headers.set("authorization", `Bearer ${token}`);
    const timeoutMs = Math.min(60_000, Math.max(1, this.options.timeoutMs ?? 20_000));
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      const request = new Request(url, { method: "POST", headers, body: JSON.stringify(requestBody), signal });
      response = this.options.service ? await this.options.service.fetch(request) : await fetch(request);
    } catch (cause) {
      if (signal.aborted) throw new ResearchFactError("RESEARCH_FACT_TIMEOUT", true, { cause });
      throw new ResearchFactError("RESEARCH_FACT_TRANSPORT_FAILED", true, { cause });
    }
    const safeUpstreamError = await readWhitelistedRiskError(response);
    if (safeUpstreamError) throw safeUpstreamError;
    if (response.status === 401 || response.status === 403) throw new ResearchFactError("RESEARCH_FACT_UNAUTHORIZED", false);
    if (response.status === 429) throw new ResearchFactError("RESEARCH_FACT_RATE_LIMITED", true);
    if (response.status >= 500) throw new ResearchFactError("RESEARCH_FACT_UPSTREAM_UNAVAILABLE", true);
    if (!response.ok) throw new ResearchFactError("RESEARCH_FACT_REQUEST_REJECTED", false);
    let payload: { data?: unknown };
    try { payload = await response.json() as { data?: unknown }; }
    catch (cause) { throw new ResearchFactError("RESEARCH_FACT_SCHEMA_MISMATCH", false, { cause }); }
    let bundle: ResearchFactBundle;
    try { bundle = parseResearchFactBundle(payload.data ?? payload); }
    catch (cause) { throw new ResearchFactError("RESEARCH_FACT_SCHEMA_MISMATCH", false, { cause }); }
    if (!await verifyResearchFactBundleFingerprint(bundle)) throw new ResearchFactError("RESEARCH_FACT_INTEGRITY_MISMATCH", false);
    if (
      bundle.purpose !== requestBody.purpose
      || bundle.observationCutoff !== requestBody.observationCutoff
      || bundle.expectedLatestSessionDate !== requestBody.expectedLatestSessionDate
      || !sameValues(bundle.instrumentIds, requestBody.instrumentIds)
    ) throw new ResearchFactError("RESEARCH_FACT_SCOPE_MISMATCH", false);
    return bundle;
  }
}

const WHITELISTED_RISK_ERRORS: Record<string, number> = {
  OBSERVATION_CUTOFF_OUT_OF_RANGE: 400,
  RESEARCH_HISTORY_INTEGRITY_FAILURE: 502,
};

async function readWhitelistedRiskError(response: Response): Promise<ResearchFactError | null> {
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) return null;
  let payload: unknown;
  try { payload = await response.clone().json(); }
  catch { return null; }
  if (!isRecord(payload) || !isRecord(payload.error)) return null;
  const code = payload.error.code;
  if (typeof code !== "string" || WHITELISTED_RISK_ERRORS[code] !== response.status || payload.error.retryable !== false) return null;
  return new ResearchFactError(code, false);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = [...right].sort();
  return [...left].sort().every((value, index) => value === expected[index]);
}
