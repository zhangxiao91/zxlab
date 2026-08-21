export const MARKET_SNAPSHOT_SCHEMA_VERSION = "market-snapshot.v1" as const;
export const DEFAULT_QUOTE_CONFLICT_THRESHOLD_BPS = 50;

export type MarketExchange = "SSE" | "SZSE";
export type MarketInterval = "1d" | "1m";
export type MarketQuoteMode = "fallback" | "corroborated";
export type MarketSnapshotInclude = "quotes" | "bars" | "news" | "announcements" | "comparisons";
export type MarketFactQuality = "live" | "cached" | "stale" | "conflicted" | "unavailable";
export type MarketCapabilityStatus = "operational" | "degraded" | "unavailable";
export type MarketFreshness = "fresh" | "mixed" | "stale" | "unknown";
export type MarketSession = "preopen" | "open" | "break" | "closed" | "holiday" | "unknown";
export type MarketReferenceSemantics = "live_session" | "last_effective_session" | "unresolved";
export type CorroborationStatus = "not_requested" | "corroborated" | "limited" | "conflicted";

export interface MarketReference {
  requestedCalendarDate: string;
  effectiveTradingDate: string | null;
  session: MarketSession;
  semantics: MarketReferenceSemantics;
}

export interface MarketProviderAttempt {
  provider: string;
  ok: boolean;
  latencyMs: number;
  errorCode: string | null;
  message: string | null;
}

export interface QuoteObservation {
  provider: string;
  price: number;
  marketTimestamp: string | null;
  receivedAt: string;
}

export interface QuoteCorroboration {
  mode: MarketQuoteMode;
  status: CorroborationStatus;
  thresholdBps: number;
  maxDeviationBps: number | null;
  observations: QuoteObservation[];
}

export interface MarketQuote {
  instrumentId: string;
  price: number | null;
  previousClose: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  turnover: number | null;
  marketTimestamp: string | null;
  receivedAt: string;
  source: string;
  quality: MarketFactQuality;
  stale: boolean;
  warnings: string[];
  fallbackUsed?: boolean;
  providerAttempts?: MarketProviderAttempt[];
  corroboration?: QuoteCorroboration;
}

export interface MarketSnapshotQuote extends MarketQuote {
  corroboration: QuoteCorroboration;
}

export interface MarketBar {
  instrumentId: string;
  timestamp: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  turnover: number | null;
  source?: string;
}

export interface MarketBarSeries {
  instrumentId: string;
  interval: MarketInterval;
  bars: MarketBar[];
}

export interface MarketNewsItem {
  id: string;
  type: "stock-news" | "market-news" | "announcement";
  title: string;
  url: string;
  summary: string | null;
  content: string | null;
  source: string;
  publishedAt: string | null;
  receivedAt: string;
  instrumentId: string | null;
  symbol: string | null;
  warnings: string[];
}

export interface MarketStatus {
  exchange: MarketExchange;
  open: boolean | null;
  session: MarketSession;
  calendarDate: string;
  marketTimestamp: string;
  asOf: string;
  receivedAt: string;
  freshness: MarketFreshness;
  quality: MarketCapabilityStatus;
  reliable: boolean;
  source: string;
  warnings: string[];
  /** Present on current snapshots. Optional only so immutable legacy snapshots remain replayable. */
  reference?: MarketReference;
}

export interface MarketCapabilityHealth {
  id: string;
  status: MarketCapabilityStatus;
  required: boolean;
  asOf: string | null;
  receivedAt: string;
  freshness: MarketFreshness;
  warnings: string[];
  attempts: MarketProviderAttempt[];
}

export interface MarketSnapshotQuality {
  status: MarketCapabilityStatus;
  reliable: boolean;
  freshness: MarketFreshness;
  warnings: string[];
  attempts: MarketProviderAttempt[];
  unavailableCapabilities: string[];
}

export interface MarketSnapshotRequest {
  instrumentIds: string[];
  intervals: MarketInterval[];
  include: MarketSnapshotInclude[];
  quoteMode: MarketQuoteMode;
}

export interface MarketSnapshot {
  schemaVersion: typeof MARKET_SNAPSHOT_SCHEMA_VERSION;
  asOf: string;
  receivedAt: string;
  marketTimestamp: string | null;
  /** Authoritative market-date semantics for this request. Missing only on legacy snapshots. */
  reference?: MarketReference;
  request: MarketSnapshotRequest;
  data: {
    quotes: MarketSnapshotQuote[];
    bars: MarketBarSeries[];
    news: MarketNewsItem[];
    announcements: MarketNewsItem[];
    status: MarketStatus[];
  };
  capabilities: MarketCapabilityHealth[];
  quality: MarketSnapshotQuality;
}

export interface MarketSnapshotValidation {
  ok: boolean;
  issues: string[];
}

export interface MarketDay {
  status: "trading_day" | "holiday" | "unknown";
  source: string;
  reliable: boolean;
  warnings: string[];
}

export interface TradingCalendar {
  getMarketDay(market: "CN", date: string): Promise<MarketDay>;
}

export function validateMarketSnapshot(value: unknown): MarketSnapshotValidation {
  const issues: string[] = [];
  if (!isRecord(value)) return { ok: false, issues: ["snapshot must be an object"] };
  if (value.schemaVersion !== MARKET_SNAPSHOT_SCHEMA_VERSION) issues.push("schemaVersion must be market-snapshot.v1");
  requireIso(value.asOf, "asOf", issues);
  requireIso(value.receivedAt, "receivedAt", issues);
  if (value.marketTimestamp !== null) requireIso(value.marketTimestamp, "marketTimestamp", issues);
  if (value.reference !== undefined) validateReference(value.reference, "reference", issues);
  if (!isRecord(value.request)) issues.push("request must be an object");
  else validateRequest(value.request, issues);
  if (!isRecord(value.data)) issues.push("data must be an object");
  else {
    validateArray(value.data.quotes, "data.quotes", issues, (quote, path, quoteIssues) => validateQuote(quote, path, quoteIssues, isRecord(value.request) ? value.request.quoteMode : undefined));
    validateArray(value.data.bars, "data.bars", issues, validateBarSeries);
    validateArray(value.data.news, "data.news", issues, validateNews);
    validateArray(value.data.announcements, "data.announcements", issues, validateNews);
    validateArray(value.data.status, "data.status", issues, validateStatus);
  }
  validateArray(value.capabilities, "capabilities", issues, validateCapability);
  if (!isRecord(value.quality)) issues.push("quality must be an object");
  else validateQuality(value.quality, issues);
  validateRequestedCapabilities(value, issues);
  validateAggregateQuality(value, issues);
  return { ok: issues.length === 0, issues };
}

export function parseMarketSnapshot(value: unknown): MarketSnapshot {
  const result = validateMarketSnapshot(value);
  if (!result.ok) throw new Error(`Invalid MarketSnapshot: ${result.issues.join("; ")}`);
  return value as MarketSnapshot;
}

export function isMarketReference(value: unknown): value is MarketReference {
  const issues: string[] = [];
  validateReference(value, "reference", issues);
  return issues.length === 0;
}

function validateRequest(value: Record<string, unknown>, issues: string[]) {
  stringArray(value.instrumentIds, "request.instrumentIds", issues);
  enumArray(value.intervals, ["1d", "1m"], "request.intervals", issues);
  enumArray(value.include, ["quotes", "bars", "news", "announcements", "comparisons"], "request.include", issues);
  oneOf(value.quoteMode, ["fallback", "corroborated"], "request.quoteMode", issues);
}

function validateQuote(value: unknown, path: string, issues: string[], requestedMode: unknown) {
  if (!isRecord(value)) return issues.push(`${path} must be an object`);
  requireString(value.instrumentId, `${path}.instrumentId`, issues);
  nullableNumber(value.price, `${path}.price`, issues);
  requireIso(value.receivedAt, `${path}.receivedAt`, issues);
  nullableIso(value.marketTimestamp, `${path}.marketTimestamp`, issues);
  requireString(value.source, `${path}.source`, issues);
  oneOf(value.quality, ["live", "cached", "stale", "conflicted", "unavailable"], `${path}.quality`, issues);
  if (typeof value.stale !== "boolean") issues.push(`${path}.stale must be boolean`);
  if (value.quality === "live" && value.stale === true) issues.push(`${path}.live quality cannot be stale`);
  stringArray(value.warnings, `${path}.warnings`, issues);
  if (value.corroboration === undefined) issues.push(`${path}.corroboration is required`);
  else {
    validateCorroboration(value.corroboration, `${path}.corroboration`, issues);
    if (isRecord(value.corroboration)) {
      if (value.corroboration.mode !== requestedMode) issues.push(`${path}.corroboration.mode must match request.quoteMode`);
      if (value.corroboration.mode === "fallback" && value.corroboration.status !== "not_requested") issues.push(`${path}.fallback corroboration must be not_requested`);
      if (value.corroboration.mode === "corroborated" && value.corroboration.status === "not_requested") issues.push(`${path}.corroborated mode cannot be not_requested`);
      if (value.quality === "conflicted" && value.corroboration.status !== "conflicted") issues.push(`${path}.conflicted quality requires conflicted corroboration`);
      if (value.corroboration.status === "conflicted" && value.quality !== "conflicted") issues.push(`${path}.conflicted corroboration requires conflicted quality`);
    }
  }
}

function validateCorroboration(value: unknown, path: string, issues: string[]) {
  if (!isRecord(value)) return issues.push(`${path} must be an object`);
  oneOf(value.mode, ["fallback", "corroborated"], `${path}.mode`, issues);
  oneOf(value.status, ["not_requested", "corroborated", "limited", "conflicted"], `${path}.status`, issues);
  if (typeof value.thresholdBps !== "number" || !Number.isFinite(value.thresholdBps) || value.thresholdBps <= 0) issues.push(`${path}.thresholdBps must be a positive finite number`);
  nullableNumber(value.maxDeviationBps, `${path}.maxDeviationBps`, issues);
  validateArray(value.observations, `${path}.observations`, issues, (item, itemPath, itemIssues) => {
    if (!isRecord(item)) return itemIssues.push(`${itemPath} must be an object`);
    requireString(item.provider, `${itemPath}.provider`, itemIssues);
    if (typeof item.price !== "number") itemIssues.push(`${itemPath}.price must be number`);
    nullableIso(item.marketTimestamp, `${itemPath}.marketTimestamp`, itemIssues);
    requireIso(item.receivedAt, `${itemPath}.receivedAt`, itemIssues);
  });
  if (Array.isArray(value.observations) && (value.status === "corroborated" || value.status === "conflicted")) {
    const providers = new Set(value.observations.flatMap((item) => isRecord(item) && typeof item.provider === "string" && item.provider ? [item.provider] : []));
    if (providers.size < 2) issues.push(`${path}.${value.status} status requires observations from at least two providers`);
  }
  if (value.status === "not_requested") {
    if (Array.isArray(value.observations) && value.observations.length > 0) issues.push(`${path}.not_requested status requires no observations`);
    if (value.maxDeviationBps !== null) issues.push(`${path}.not_requested status requires maxDeviationBps null`);
  }
  if (value.status === "limited") {
    if (Array.isArray(value.observations)) {
      const providers = new Set(value.observations.flatMap((item) => isRecord(item) && typeof item.provider === "string" && item.provider ? [item.provider] : []));
      if (providers.size >= 2) issues.push(`${path}.limited status requires observations from fewer than two providers`);
    }
    if (value.maxDeviationBps !== null) issues.push(`${path}.limited status requires maxDeviationBps null`);
  }
  if (value.status === "corroborated" && (
    typeof value.maxDeviationBps !== "number"
    || !Number.isFinite(value.maxDeviationBps)
    || typeof value.thresholdBps !== "number"
    || value.maxDeviationBps > value.thresholdBps
  )) issues.push(`${path}.corroborated status requires maxDeviationBps at or below thresholdBps`);
  if (value.status === "conflicted" && (
    typeof value.maxDeviationBps !== "number"
    || !Number.isFinite(value.maxDeviationBps)
    || typeof value.thresholdBps !== "number"
    || value.maxDeviationBps <= value.thresholdBps
  )) issues.push(`${path}.conflicted status requires maxDeviationBps above thresholdBps`);
}

function validateBarSeries(value: unknown, path: string, issues: string[]) {
  if (!isRecord(value)) return issues.push(`${path} must be an object`);
  requireString(value.instrumentId, `${path}.instrumentId`, issues);
  oneOf(value.interval, ["1d", "1m"], `${path}.interval`, issues);
  validateArray(value.bars, `${path}.bars`, issues, (bar, barPath, barIssues) => {
    if (!isRecord(bar)) return barIssues.push(`${barPath} must be an object`);
    requireString(bar.instrumentId, `${barPath}.instrumentId`, barIssues);
    requireIso(bar.timestamp, `${barPath}.timestamp`, barIssues);
    nullableNumber(bar.close, `${barPath}.close`, barIssues);
  });
}

function validateNews(value: unknown, path: string, issues: string[]) {
  if (!isRecord(value)) return issues.push(`${path} must be an object`);
  requireString(value.id, `${path}.id`, issues);
  oneOf(value.type, ["stock-news", "market-news", "announcement"], `${path}.type`, issues);
  requireString(value.title, `${path}.title`, issues);
  requireString(value.url, `${path}.url`, issues);
  requireIso(value.receivedAt, `${path}.receivedAt`, issues);
  stringArray(value.warnings, `${path}.warnings`, issues);
}

function validateStatus(value: unknown, path: string, issues: string[]) {
  if (!isRecord(value)) return issues.push(`${path} must be an object`);
  oneOf(value.exchange, ["SSE", "SZSE"], `${path}.exchange`, issues);
  if (typeof value.open !== "boolean" && value.open !== null) issues.push(`${path}.open must be boolean or null`);
  oneOf(value.session, ["preopen", "open", "break", "closed", "holiday", "unknown"], `${path}.session`, issues);
  if (value.open === true && value.session !== "open") issues.push(`${path}.open true requires session open`);
  if (value.session === "open" && value.open !== true) issues.push(`${path}.session open requires open true`);
  if (value.session === "unknown" && value.open !== null) issues.push(`${path}.session unknown requires open null`);
  requireIso(value.asOf, `${path}.asOf`, issues);
  requireIso(value.receivedAt, `${path}.receivedAt`, issues);
  if (typeof value.reliable !== "boolean") issues.push(`${path}.reliable must be boolean`);
  stringArray(value.warnings, `${path}.warnings`, issues);
  if (value.reference !== undefined) {
    validateReference(value.reference, `${path}.reference`, issues);
    if (isRecord(value.reference) && value.reference.requestedCalendarDate !== value.calendarDate) issues.push(`${path}.reference.requestedCalendarDate must match calendarDate`);
    if (isRecord(value.reference) && value.reference.session !== value.session) issues.push(`${path}.reference.session must match session`);
  }
}

function validateReference(value: unknown, path: string, issues: string[]) {
  if (!isRecord(value)) return issues.push(`${path} must be an object`);
  if (!isDate(value.requestedCalendarDate)) issues.push(`${path}.requestedCalendarDate must be YYYY-MM-DD`);
  if (value.effectiveTradingDate !== null && !isDate(value.effectiveTradingDate)) issues.push(`${path}.effectiveTradingDate must be YYYY-MM-DD or null`);
  oneOf(value.session, ["preopen", "open", "break", "closed", "holiday", "unknown"], `${path}.session`, issues);
  oneOf(value.semantics, ["live_session", "last_effective_session", "unresolved"], `${path}.semantics`, issues);
  if (value.semantics === "unresolved" && value.effectiveTradingDate !== null) issues.push(`${path}.unresolved semantics requires effectiveTradingDate null`);
  if (value.semantics !== "unresolved" && value.effectiveTradingDate === null) issues.push(`${path}.${String(value.semantics)} semantics requires effectiveTradingDate`);
  if (value.session === "unknown" && value.semantics !== "unresolved") issues.push(`${path}.unknown session requires unresolved semantics`);
}

function validateCapability(value: unknown, path: string, issues: string[]) {
  if (!isRecord(value)) return issues.push(`${path} must be an object`);
  requireString(value.id, `${path}.id`, issues);
  oneOf(value.status, ["operational", "degraded", "unavailable"], `${path}.status`, issues);
  if (typeof value.required !== "boolean") issues.push(`${path}.required must be boolean`);
  nullableIso(value.asOf, `${path}.asOf`, issues);
  requireIso(value.receivedAt, `${path}.receivedAt`, issues);
  oneOf(value.freshness, ["fresh", "mixed", "stale", "unknown"], `${path}.freshness`, issues);
  stringArray(value.warnings, `${path}.warnings`, issues);
  validateArray(value.attempts, `${path}.attempts`, issues, validateAttempt);
}

function validateQuality(value: Record<string, unknown>, issues: string[]) {
  oneOf(value.status, ["operational", "degraded", "unavailable"], "quality.status", issues);
  if (typeof value.reliable !== "boolean") issues.push("quality.reliable must be boolean");
  oneOf(value.freshness, ["fresh", "mixed", "stale", "unknown"], "quality.freshness", issues);
  stringArray(value.warnings, "quality.warnings", issues);
  stringArray(value.unavailableCapabilities, "quality.unavailableCapabilities", issues);
  validateArray(value.attempts, "quality.attempts", issues, validateAttempt);
}

function validateRequestedCapabilities(snapshot: Record<string, unknown>, issues: string[]) {
  if (!isRecord(snapshot.request) || !Array.isArray(snapshot.capabilities)) return;
  const requiredCapabilityIds = new Set(snapshot.capabilities.flatMap((capability) =>
    isRecord(capability) && capability.required === true && typeof capability.id === "string" ? [capability.id] : []
  ));
  for (const id of expectedCapabilityIds(snapshot.request)) {
    if (!requiredCapabilityIds.has(id)) issues.push(`capabilities missing required requested capability ${id}`);
  }
}

function expectedCapabilityIds(request: Record<string, unknown>): string[] {
  if (!Array.isArray(request.include)) return [];
  const include = new Set(request.include.filter((item): item is string => typeof item === "string"));
  const instrumentIds = Array.isArray(request.instrumentIds) ? request.instrumentIds.filter((item): item is string => typeof item === "string") : [];
  const intervals = Array.isArray(request.intervals) ? request.intervals.filter((item): item is MarketInterval => item === "1d" || item === "1m") : [];
  const expected = new Set<string>();
  if (include.has("quotes")) expected.add("quotes");
  if (include.has("bars")) for (const instrumentId of instrumentIds) for (const interval of intervals) expected.add(`bars:${instrumentId}:${interval}`);
  if (include.has("news")) expected.add("news");
  if (include.has("announcements")) for (const instrumentId of instrumentIds) expected.add(`announcements:${instrumentId}`);
  if (include.has("comparisons")) expected.add("comparisons");
  return [...expected];
}

function validateAggregateQuality(snapshot: Record<string, unknown>, issues: string[]) {
  if (!Array.isArray(snapshot.capabilities) || !isRecord(snapshot.quality)) return;
  const requiredUnavailable = snapshot.capabilities.flatMap((capability) =>
    isRecord(capability) && capability.required === true && capability.status === "unavailable" && typeof capability.id === "string" ? [capability.id] : []
  );
  const requiredStale = snapshot.capabilities.flatMap((capability) =>
    isRecord(capability) && capability.required === true && capability.freshness === "stale" && typeof capability.id === "string" ? [capability.id] : []
  );
  if (requiredUnavailable.length) {
    if (snapshot.quality.status === "operational") issues.push(`quality.status cannot be operational with required unavailable capabilities: ${requiredUnavailable.join(", ")}`);
    if (snapshot.quality.reliable === true) issues.push(`quality.reliable cannot be true with required unavailable capabilities: ${requiredUnavailable.join(", ")}`);
    if (snapshot.quality.freshness === "fresh") issues.push(`quality.freshness cannot be fresh with required unavailable capabilities: ${requiredUnavailable.join(", ")}`);
    if (Array.isArray(snapshot.quality.unavailableCapabilities)) {
      for (const id of requiredUnavailable) {
        if (!snapshot.quality.unavailableCapabilities.includes(id)) issues.push(`quality.unavailableCapabilities must include ${id}`);
      }
    }
  }
  if (requiredStale.length) {
    if (snapshot.quality.reliable === true) issues.push(`quality.reliable cannot be true with required stale capabilities: ${requiredStale.join(", ")}`);
    if (snapshot.quality.freshness !== "stale") issues.push(`quality.freshness must be stale when required capabilities are stale: ${requiredStale.join(", ")}`);
  }
}

function validateAttempt(value: unknown, path: string, issues: string[]) {
  if (!isRecord(value)) return issues.push(`${path} must be an object`);
  requireString(value.provider, `${path}.provider`, issues);
  if (typeof value.ok !== "boolean") issues.push(`${path}.ok must be boolean`);
  if (typeof value.latencyMs !== "number" || !Number.isFinite(value.latencyMs)) issues.push(`${path}.latencyMs must be a finite number`);
  if (value.errorCode !== null && typeof value.errorCode !== "string") issues.push(`${path}.errorCode must be string or null`);
  if (value.message !== null && typeof value.message !== "string") issues.push(`${path}.message must be string or null`);
}

function isDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function validateArray(value: unknown, path: string, issues: string[], validate: (item: unknown, path: string, issues: string[]) => unknown) {
  if (!Array.isArray(value)) return issues.push(`${path} must be an array`);
  value.forEach((item, index) => validate(item, `${path}[${index}]`, issues));
}

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function requireString(value: unknown, path: string, issues: string[]) { if (typeof value !== "string" || !value) issues.push(`${path} must be a non-empty string`); }
function requireIso(value: unknown, path: string, issues: string[]) { if (typeof value !== "string" || Number.isNaN(Date.parse(value))) issues.push(`${path} must be an ISO date`); }
function nullableIso(value: unknown, path: string, issues: string[]) { if (value !== null) requireIso(value, path, issues); }
function nullableNumber(value: unknown, path: string, issues: string[]) { if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) issues.push(`${path} must be a finite number or null`); }
function stringArray(value: unknown, path: string, issues: string[]) { if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) issues.push(`${path} must be a string array`); }
function enumArray(value: unknown, allowed: string[], path: string, issues: string[]) { if (!Array.isArray(value) || value.some((item) => !allowed.includes(String(item)))) issues.push(`${path} contains an unsupported value`); }
function oneOf(value: unknown, allowed: string[], path: string, issues: string[]) { if (!allowed.includes(String(value))) issues.push(`${path} must be one of ${allowed.join(", ")}`); }
