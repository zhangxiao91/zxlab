import type {
  MarketCapabilityHealth,
  MarketCapabilityStatus,
  MarketDataQuality,
  MarketProviderAttempt,
  MarketResponse,
} from "./types";

interface CapabilityInput<T> {
  id: string;
  response?: MarketResponse<T>;
  error?: unknown;
  emptyIsUnavailable?: boolean;
  itemQualities?: Array<"live" | "cached" | "stale" | "unavailable">;
  extraWarnings?: string[];
}

export class LatestMarketRequest {
  private sequence = 0;

  begin(): number {
    this.sequence += 1;
    return this.sequence;
  }

  isCurrent(token: number): boolean {
    return token === this.sequence;
  }
}

export function capabilityHealth<T>({
  id,
  response,
  error,
  emptyIsUnavailable = false,
  itemQualities = [],
  extraWarnings = [],
}: CapabilityInput<T>): MarketCapabilityHealth {
  const meta = response?.meta;
  const attempts = attemptsOf(meta?.attempts ?? errorAttempts(error));
  const warnings = unique([
    ...stringsOf(meta?.warnings),
    ...extraWarnings,
    ...(error ? [errorMessage(error)] : []),
  ]);
  const data = response?.data;
  const isEmpty = Array.isArray(data) && data.length === 0;
  const explicit = isCapabilityStatus(meta?.capabilityStatus) ? meta.capabilityStatus : null;
  const allItemsUnavailable = itemQualities.length > 0 && itemQualities.every((quality) => quality === "unavailable");
  const hasWeakItem = itemQualities.some((quality) => quality !== "live");
  const hasFailedAttempt = attempts.some((attempt) => !attempt.ok);
  const status: MarketCapabilityStatus = error || (emptyIsUnavailable && isEmpty) || allItemsUnavailable
    ? "unavailable"
    : explicit ?? (hasWeakItem || hasFailedAttempt || warnings.length > 0 || meta?.fallbackUsed === true ? "degraded" : "operational");

  return {
    id,
    status,
    asOf: stringOf(meta?.asOf),
    receivedAt: stringOf(meta?.receivedAt),
    warnings,
    attempts,
  };
}

export function summarizeMarketDataQuality(capabilities: MarketCapabilityHealth[], receivedAt = new Date().toISOString()): MarketDataQuality {
  const statuses = capabilities.map((item) => item.status);
  const status: MarketCapabilityStatus = statuses.length > 0 && statuses.every((item) => item === "unavailable")
    ? "unavailable"
    : statuses.some((item) => item !== "operational")
      ? "degraded"
      : "operational";
  const asOf = capabilities.map((item) => item.asOf).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
  return {
    status,
    asOf,
    receivedAt,
    freshness: status === "operational" ? "fresh" : statuses.some((item) => item === "operational") ? "mixed" : "unknown",
    capabilities,
    warnings: unique(capabilities.flatMap((item) => item.warnings)),
    attempts: capabilities.flatMap((item) => item.attempts),
    unavailableCapabilities: capabilities.filter((item) => item.status === "unavailable").map((item) => item.id),
  };
}

function errorAttempts(error: unknown): unknown {
  if (!error || typeof error !== "object" || !("details" in error)) return undefined;
  const details = (error as { details?: unknown }).details;
  return details && typeof details === "object" && "attempts" in details ? (details as { attempts?: unknown }).attempts : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "capability unavailable";
}

function attemptsOf(value: unknown): MarketProviderAttempt[] {
  return Array.isArray(value)
    ? value.filter((item): item is MarketProviderAttempt => Boolean(item) && typeof item === "object" && typeof (item as MarketProviderAttempt).provider === "string")
    : [];
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isCapabilityStatus(value: unknown): value is MarketCapabilityStatus {
  return value === "operational" || value === "degraded" || value === "unavailable";
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
