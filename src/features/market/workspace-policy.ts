import type {
  MarketSnapshot,
  MarketSnapshotRequest,
} from "../../../packages/market-schema/src/index";
import type {
  MarketBar,
  MarketCapabilityHealth,
  MarketDataQuality,
  MarketInterval,
  MarketNewsItem,
  MarketProviderAttempt,
  MarketProviders,
  MarketQuote,
  MarketStatus,
} from "./types";

const OPEN_REFRESH_MS = 5_000;
const UNKNOWN_REFRESH_MS = 10_000;
const BREAK_REFRESH_MS = 15_000;
const CLOSED_REFRESH_MS = 60_000;
const HOLIDAY_REFRESH_MS = 300_000;
const TRANSITION_GRACE_MS = 250;
const SNAPSHOT_BATCH_SIZE = 10;

export interface MarketWorkspaceState {
  quotes: MarketQuote[];
  bars: Record<string, MarketBar[]>;
  news: MarketNewsItem[];
  announcements: MarketNewsItem[];
  status: MarketStatus[];
  providers: MarketProviders | null;
  diagnosticWarnings: string[];
  attempts: MarketProviderAttempt[];
  warnings: string[];
  quality: MarketDataQuality;
}

export interface MarketRefreshDecision {
  intervalMs: number;
  delayMs: number;
  session: MarketStatus["session"] | "initial";
  nextBoundaryAt: string | null;
}

export interface MergeMarketSnapshotOptions {
  providers?: MarketProviders | null;
  diagnosticWarnings?: string[];
  requestedQuoteIds?: string[];
  requestedCapabilityIds?: string[];
  failedCapabilities?: MarketCapabilityHealth[];
  preserveUnrequestedCapabilities?: boolean;
  preserveUnrequestedStatuses?: boolean;
  snapshotWarnings?: string[];
}

export function emptyMarketWorkspaceState(): MarketWorkspaceState {
  return {
    quotes: [],
    bars: {},
    news: [],
    announcements: [],
    status: [],
    providers: null,
    diagnosticWarnings: [],
    attempts: [],
    warnings: [],
    quality: {
      status: "unavailable",
      reliable: false,
      asOf: null,
      receivedAt: new Date(0).toISOString(),
      freshness: "unknown",
      capabilities: [],
      warnings: [],
      attempts: [],
      unavailableCapabilities: [],
    },
  };
}

export function marketSnapshotRequests(
  instrumentIds: string[],
  activeId: string | undefined,
  interval: MarketInterval,
  slow: boolean,
): MarketSnapshotRequest[] {
  const uniqueIds = [...new Set(instrumentIds.filter(Boolean))];
  const overview: MarketSnapshotRequest[] = [];
  for (let index = 0; index < uniqueIds.length; index += SNAPSHOT_BATCH_SIZE) {
    overview.push({
      instrumentIds: uniqueIds.slice(index, index + SNAPSHOT_BATCH_SIZE),
      intervals: [interval],
      include: ["quotes"],
      quoteMode: "fallback",
    });
  }
  if (activeId) {
    overview.push({
      instrumentIds: [activeId],
      intervals: [interval],
      include: ["bars"],
      quoteMode: "fallback",
    });
    if (slow) {
      overview.push({
        instrumentIds: [activeId],
        intervals: [interval],
        include: ["news", "announcements"],
        quoteMode: "fallback",
      });
    }
  }
  return overview;
}

export function marketBarSeriesKey(instrumentId: string, interval: MarketInterval): string {
  return `${instrumentId}:${interval}`;
}

export function marketRequestCapabilityIds(requests: MarketSnapshotRequest[]): string[] {
  return unique(requests.flatMap((request) => requestCapabilityIds(request)));
}

export function marketSnapshotFailureCapabilities(
  request: MarketSnapshotRequest,
  warning: string,
  receivedAt = new Date().toISOString(),
  attempts: MarketProviderAttempt[] = [],
): MarketCapabilityHealth[] {
  return requestCapabilityIds(request, true).map((id) => ({
    id,
    status: "unavailable",
    required: true,
    asOf: null,
    receivedAt,
    freshness: "unknown",
    warnings: [warning],
    attempts,
  }));
}

export function marketRefreshDecision(statuses: MarketStatus[], now = Date.now()): MarketRefreshDecision {
  const session = refreshSession(statuses, true);
  const intervalMs = session === "open" || session === "preopen"
    ? OPEN_REFRESH_MS
    : session === "unknown" || session === "initial"
      ? UNKNOWN_REFRESH_MS
      : session === "break"
        ? BREAK_REFRESH_MS
        : session === "holiday"
          ? HOLIDAY_REFRESH_MS
          : CLOSED_REFRESH_MS;
  const candidateBoundary = nextSessionBoundary(statuses, session, now);
  const boundary = candidateBoundary != null && candidateBoundary > now ? candidateBoundary : null;
  const boundaryDelay = boundary == null ? Number.POSITIVE_INFINITY : boundary - now + TRANSITION_GRACE_MS;
  return {
    intervalMs,
    delayMs: Math.min(intervalMs, boundaryDelay),
    session,
    nextBoundaryAt: boundary == null ? null : new Date(boundary).toISOString(),
  };
}

export function marketWorkspaceRefreshDecision(
  state: Pick<MarketWorkspaceState, "status" | "quality">,
  now = Date.now(),
): MarketRefreshDecision {
  const coreReliable = !state.quality.capabilities.some((capability) =>
    isCoreMarketCapability(capability.id)
    && (
      capability.status === "unavailable"
      || capability.freshness === "stale"
      || capability.freshness === "unknown"
    )
  );
  const session = refreshSession(state.status, coreReliable);
  const statuses = session === "unknown"
    ? state.status.map((status) => ({ ...status, reliable: false }))
    : state.status;
  const decision = marketRefreshDecision(statuses, now);
  return session === decision.session ? decision : {
    intervalMs: UNKNOWN_REFRESH_MS,
    delayMs: UNKNOWN_REFRESH_MS,
    session,
    nextBoundaryAt: null,
  };
}

export function mergeMarketSnapshots(
  current: MarketWorkspaceState,
  snapshots: MarketSnapshot[],
  options: MergeMarketSnapshotOptions = {},
): MarketWorkspaceState {
  const failedCapabilities = options.failedCapabilities ?? [];
  const requestedCapabilityIds = new Set(options.requestedCapabilityIds
    ?? marketRequestCapabilityIds(snapshots.map((snapshot) => snapshot.request)));
  if (!snapshots.length) {
    const diagnosticWarnings = options.diagnosticWarnings === undefined
      ? current.diagnosticWarnings
      : unique(options.diagnosticWarnings);
    const snapshotWarnings = unique(options.snapshotWarnings ?? []);
    const hasSnapshotFailure = failedCapabilities.some((capability) => capability.required)
      || snapshotWarnings.length > 0;
    const replacesAnnouncements = [...requestedCapabilityIds].some((id) => id.startsWith("announcements:"));
    const capabilities = aggregateCapabilities([
      ...current.quality.capabilities.filter((capability) =>
        !requestedCapabilityIds.has(capability.id)
        && !(replacesAnnouncements && capability.id.startsWith("announcements:"))
      ),
      ...failedCapabilities,
    ]);
    return {
      ...current,
      providers: options.providers === undefined ? current.providers : options.providers,
      diagnosticWarnings,
      attempts: uniqueAttempts([...current.attempts, ...failedCapabilities.flatMap((capability) => capability.attempts)]),
      warnings: unique([
        ...current.warnings.filter((warning) => !current.diagnosticWarnings.includes(warning)),
        ...snapshotWarnings,
        ...diagnosticWarnings,
      ]),
      quality: {
        ...current.quality,
        status: hasSnapshotFailure && current.quality.status === "operational"
          ? "degraded"
          : current.quality.status,
        reliable: hasSnapshotFailure ? false : current.quality.reliable,
        freshness: hasSnapshotFailure && current.quality.freshness === "fresh"
          ? "mixed"
          : current.quality.freshness,
        capabilities,
        warnings: unique([...current.quality.warnings, ...snapshotWarnings]),
        attempts: uniqueAttempts([...current.quality.attempts, ...failedCapabilities.flatMap((capability) => capability.attempts)]),
        unavailableCapabilities: unique([
          ...current.quality.unavailableCapabilities.filter((id) => !requestedCapabilityIds.has(id)),
          ...failedCapabilities.map((capability) => capability.id),
        ]),
      },
    };
  }

  const retentionWarnings: string[] = [];
  const quoteSnapshots = snapshots.filter((snapshot) => snapshot.request.include.includes("quotes"));
  const requestedQuoteIds = [...new Set(options.requestedQuoteIds ?? quoteSnapshots.flatMap((snapshot) => snapshot.request.instrumentIds))];
  const incomingQuotes = new Map(snapshots.flatMap((snapshot) => snapshot.data.quotes).map((quote) => [quote.instrumentId, quote]));
  const currentQuotes = new Map(current.quotes.map((quote) => [quote.instrumentId, quote]));
  const quotes: MarketQuote[] = requestedQuoteIds.length
    ? requestedQuoteIds.flatMap<MarketQuote>((instrumentId) => {
        const incoming = incomingQuotes.get(instrumentId);
        if (incoming && incoming.quality !== "unavailable" && incoming.price != null) return [incoming];
        const previous = currentQuotes.get(instrumentId);
        if (!previous || previous.price == null) return incoming ? [incoming] : [];
        const warning = `${instrumentId} 本轮报价不可用，显示上次成功报价`;
        retentionWarnings.push(warning);
        return [{
          ...previous,
          quality: previous.quality === "conflicted" ? "conflicted" as const : "stale" as const,
          stale: true,
          warnings: unique([...previous.warnings, ...(incoming?.warnings ?? []), warning]),
        }];
      })
    : current.quotes;

  const bars = { ...current.bars };
  const incomingBars = new Map(snapshots.flatMap((snapshot) => snapshot.data.bars)
    .map((series) => [marketBarSeriesKey(series.instrumentId, series.interval), series]));
  for (const capabilityId of requestedCapabilityIds) {
    const seriesIdentity = parseBarCapabilityId(capabilityId);
    if (!seriesIdentity) continue;
    const key = marketBarSeriesKey(seriesIdentity.instrumentId, seriesIdentity.interval);
    const series = incomingBars.get(key);
    if (series?.bars.length) bars[key] = series.bars;
    else if (bars[key]?.length) retentionWarnings.push(`${seriesIdentity.instrumentId} ${seriesIdentity.interval} 本轮 K 线不可用，保留上次成功数据`);
    else bars[key] = [];
  }

  const requestedNews = snapshots.some((snapshot) => snapshot.request.include.includes("news"));
  const requestedAnnouncements = snapshots.some((snapshot) => snapshot.request.include.includes("announcements"));
  const incomingNews = dedupeNews(snapshots.flatMap((snapshot) => snapshot.data.news));
  const incomingAnnouncements = dedupeNews(snapshots.flatMap((snapshot) => snapshot.data.announcements));
  const newsUnavailable = snapshots.some((snapshot) => snapshot.capabilities.some((capability) => capability.id === "news" && capability.status === "unavailable"));
  const requestedAnnouncementIds = new Set(snapshots
    .filter((snapshot) => snapshot.request.include.includes("announcements"))
    .flatMap((snapshot) => snapshot.request.instrumentIds));
  const announcementsUnavailable = snapshots.some((snapshot) => snapshot.capabilities.some((capability) => capability.id.startsWith("announcements:") && capability.status === "unavailable"));
  if (requestedNews && newsUnavailable && !incomingNews.length && current.news.length) {
    retentionWarnings.push("本轮新闻不可用，保留上次成功数据");
  }
  const retainedAnnouncements = current.announcements.filter((item) => item.instrumentId && requestedAnnouncementIds.has(item.instrumentId));
  if (requestedAnnouncements && announcementsUnavailable && !incomingAnnouncements.length && retainedAnnouncements.length) {
    retentionWarnings.push("本轮公告不可用，保留上次成功数据");
  }
  const incomingStatus = new Map(latestStatuses(snapshots.flatMap((snapshot) => snapshot.data.status))
    .map((status) => [status.exchange, status]));
  const currentStatus = new Map(current.status.map((status) => [status.exchange, status]));
  const requestedExchanges = new Set<MarketStatus["exchange"]>((options.requestedQuoteIds
    ?? snapshots.flatMap((snapshot) => snapshot.request.instrumentIds))
    .flatMap<MarketStatus["exchange"]>((instrumentId) => {
      const exchange = instrumentId.split(":")[0];
      return exchange === "SSE" || exchange === "SZSE" ? [exchange] : [];
    }));
  const statusExchanges = options.preserveUnrequestedStatuses
    ? new Set([...requestedExchanges, ...currentStatus.keys()])
    : requestedExchanges;
  const status = [...statusExchanges].flatMap((exchange) => {
    const incoming = incomingStatus.get(exchange);
    if (incoming) return [incoming];
    const previous = currentStatus.get(exchange);
    if (!previous) return [];
    if (!requestedExchanges.has(exchange)) return [previous];
    const warning = `${exchange} 本轮交易状态不可用，保留上次状态但不再视为可靠`;
    retentionWarnings.push(warning);
    return [{
      ...previous,
      open: null,
      session: "unknown" as const,
      freshness: "unknown" as const,
      quality: "degraded" as const,
      reliable: false,
      warnings: unique([...previous.warnings, warning]),
    }];
  }).sort((left, right) => left.exchange.localeCompare(right.exchange));

  const snapshotWarnings = unique(options.snapshotWarnings ?? []);
  const quality = aggregateSnapshotQuality(
    current.quality,
    snapshots,
    requestedCapabilityIds,
    failedCapabilities,
    retentionWarnings,
    snapshotWarnings,
    options.preserveUnrequestedCapabilities ?? false,
    options.preserveUnrequestedStatuses ?? false,
  );
  const diagnosticWarnings = options.diagnosticWarnings === undefined
    ? current.diagnosticWarnings
    : unique(options.diagnosticWarnings);
  return {
    quotes,
    bars,
    news: requestedNews
      ? (newsUnavailable && !incomingNews.length ? current.news : incomingNews)
      : current.news,
    announcements: requestedAnnouncements
      ? (announcementsUnavailable && !incomingAnnouncements.length ? retainedAnnouncements : incomingAnnouncements)
      : current.announcements,
    status,
    providers: options.providers === undefined ? current.providers : options.providers,
    diagnosticWarnings,
    attempts: quality.attempts,
    warnings: unique([...quality.warnings, ...retentionWarnings, ...snapshotWarnings, ...diagnosticWarnings]),
    quality,
  };
}

export function retainMarketWorkspaceAfterFailure(
  current: MarketWorkspaceState,
  message: string,
): MarketWorkspaceState {
  const warning = `行情刷新失败，显示上次成功数据：${message}`;
  const capabilities = current.quality.capabilities.map((capability) =>
    capability.id.startsWith("status:")
      ? {
          ...capability,
          status: "unavailable" as const,
          freshness: "unknown" as const,
          warnings: unique([...capability.warnings, warning]),
        }
      : capability
  );
  return {
    ...current,
    quotes: current.quotes.map((quote) => quote.price == null ? quote : {
      ...quote,
      quality: quote.quality === "conflicted" ? "conflicted" : "stale",
      stale: true,
      warnings: unique([...quote.warnings, warning]),
    }),
    warnings: unique([...current.warnings, warning]),
    status: current.status.map((status) => ({
      ...status,
      open: null,
      session: "unknown",
      freshness: "unknown",
      quality: "degraded",
      reliable: false,
      warnings: unique([...status.warnings, warning]),
    })),
    quality: {
      ...current.quality,
      status: "unavailable",
      reliable: false,
      freshness: current.quotes.some((quote) => quote.price != null) ? "stale" : "unknown",
      capabilities,
      warnings: unique([...current.quality.warnings, warning]),
      unavailableCapabilities: unique([
        ...current.quality.unavailableCapabilities,
        ...capabilities.filter((capability) => capability.status === "unavailable").map((capability) => capability.id),
      ]),
    },
  };
}

function aggregateSnapshotQuality(
  current: MarketDataQuality,
  snapshots: MarketSnapshot[],
  requestedCapabilityIds: Set<string>,
  failedCapabilities: MarketCapabilityHealth[],
  retentionWarnings: string[],
  snapshotWarnings: string[],
  preserveUnrequestedCapabilities: boolean,
  preserveUnrequestedStatuses: boolean,
): MarketDataQuality {
  const qualities = snapshots.map((snapshot) => snapshot.quality);
  const statuses = qualities.map((quality) => quality.status);
  let status: MarketDataQuality["status"] = statuses.every((value) => value === "unavailable")
    ? "unavailable"
    : statuses.some((value) => value !== "operational")
      ? "degraded"
      : "operational";
  const incomingCapabilities = aggregateCapabilities([
    ...snapshots.flatMap((snapshot) => snapshot.capabilities),
    ...failedCapabilities,
  ]);
  const incomingCapabilityIds = new Set(incomingCapabilities.map((capability) => capability.id));
  const replacesAnnouncements = [...requestedCapabilityIds].some((id) => id.startsWith("announcements:"));
  const retainedCapabilities = current.capabilities.filter((capability) =>
    (
      preserveUnrequestedCapabilities
      || isSlowCapability(capability.id)
      || (preserveUnrequestedStatuses && capability.id.startsWith("status:"))
    )
    && !requestedCapabilityIds.has(capability.id)
    && !(replacesAnnouncements && capability.id.startsWith("announcements:"))
    && !incomingCapabilityIds.has(capability.id)
  );
  const capabilities = aggregateCapabilities([...incomingCapabilities, ...retainedCapabilities]);
  const requiredCapabilities = capabilities.filter((capability) => capability.required);
  if (requiredCapabilities.some((capability) => capability.status !== "operational")) {
    status = status === "unavailable" ? status : "degraded";
  }
  let freshness = combineFreshness([
    ...qualities.map((quality) => quality.freshness),
    ...retainedCapabilities.map((capability) => capability.freshness),
    ...failedCapabilities.map((capability) => capability.freshness),
  ]);
  let reliable = qualities.length > 0 && qualities.every((quality) => quality.reliable);
  reliable = reliable && requiredCapabilities.every((capability) =>
    capability.status !== "unavailable"
    && capability.freshness !== "stale"
    && capability.freshness !== "unknown"
  );
  if (retentionWarnings.length) {
    status = status === "operational" ? "degraded" : status;
    freshness = "stale";
    reliable = false;
  }
  if (snapshotWarnings.length) {
    status = status === "unavailable" ? status : "degraded";
    freshness = freshness === "fresh" ? "mixed" : freshness;
    reliable = false;
  }
  return {
    status,
    reliable,
    asOf: latest(snapshots.map((snapshot) => snapshot.asOf)),
    receivedAt: latest(snapshots.map((snapshot) => snapshot.receivedAt)) ?? new Date(0).toISOString(),
    freshness,
    capabilities,
    warnings: unique([
      ...qualities.flatMap((quality) => quality.warnings),
      ...retainedCapabilities.flatMap((capability) => capability.warnings),
      ...failedCapabilities.flatMap((capability) => capability.warnings),
      ...snapshotWarnings,
    ]),
    attempts: uniqueAttempts([
      ...qualities.flatMap((quality) => quality.attempts),
      ...retainedCapabilities.flatMap((capability) => capability.attempts),
      ...failedCapabilities.flatMap((capability) => capability.attempts),
    ]),
    unavailableCapabilities: unique([
      ...qualities.flatMap((quality) => quality.unavailableCapabilities),
      ...requiredCapabilities.filter((capability) => capability.status === "unavailable").map((capability) => capability.id),
      ...(snapshotWarnings.length && !failedCapabilities.length ? ["snapshot-request"] : []),
    ]),
  };
}

function refreshSession(statuses: MarketStatus[], workspaceReliable: boolean): MarketRefreshDecision["session"] {
  if (!statuses.length) return "initial";
  if (statuses.some((status) => status.session === "open" || status.session === "preopen")) {
    return statuses.some((status) => status.session === "open") ? "open" : "preopen";
  }
  if (!workspaceReliable) return "unknown";
  if (statuses.some((status) => !status.reliable || status.session === "unknown" || status.open === null)) return "unknown";
  if (statuses.some((status) => status.session === "break")) return "break";
  if (statuses.some((status) => status.session === "closed")) return "closed";
  return "holiday";
}

function nextSessionBoundary(
  statuses: MarketStatus[],
  session: MarketRefreshDecision["session"],
  now: number,
): number | null {
  const date = statuses.find((status) => status.reliable)?.calendarDate;
  if (!date || session === "initial" || session === "unknown" || session === "holiday") return null;
  const minutes = shanghaiMinutes(now);
  if (session === "preopen") return shanghaiEpoch(date, 9, 30);
  if (session === "break") return shanghaiEpoch(date, 13, 0);
  if (session === "open") return minutes < 11 * 60 + 30 ? shanghaiEpoch(date, 11, 30) : shanghaiEpoch(date, 15, 0);
  if (session === "closed" && minutes < 9 * 60 + 15) return shanghaiEpoch(date, 9, 15);
  return null;
}

function shanghaiMinutes(timestamp: number): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function shanghaiEpoch(date: string, hour: number, minute: number): number {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year, month - 1, day, hour - 8, minute);
}

function latestStatuses(statuses: MarketStatus[]): MarketStatus[] {
  const values = new Map<MarketStatus["exchange"], MarketStatus>();
  for (const status of statuses) {
    const current = values.get(status.exchange);
    if (!current || Date.parse(status.receivedAt) >= Date.parse(current.receivedAt)) values.set(status.exchange, status);
  }
  return [...values.values()].sort((left, right) => left.exchange.localeCompare(right.exchange));
}

function aggregateCapabilities(capabilities: MarketCapabilityHealth[]): MarketCapabilityHealth[] {
  const groups = new Map<string, MarketCapabilityHealth[]>();
  for (const capability of capabilities) {
    groups.set(capability.id, [...(groups.get(capability.id) ?? []), capability]);
  }
  return [...groups.entries()].map(([id, values]) => {
    const latestValue = values.slice().sort((left, right) =>
      Date.parse(right.receivedAt ?? "") - Date.parse(left.receivedAt ?? "")
    )[0];
    const statuses = values.map((value) => value.status);
    const status: MarketCapabilityHealth["status"] = statuses.every((value) => value === "unavailable")
      ? "unavailable"
      : statuses.some((value) => value !== "operational")
        ? "degraded"
        : "operational";
    return {
      ...latestValue,
      id,
      status,
      required: values.some((value) => value.required),
      asOf: latest(values.map((value) => value.asOf)),
      receivedAt: latest(values.map((value) => value.receivedAt)) ?? latestValue.receivedAt,
      freshness: combineFreshness(values.map((value) => value.freshness)),
      warnings: unique(values.flatMap((value) => value.warnings)),
      attempts: uniqueAttempts(values.flatMap((value) => value.attempts)),
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
}

function dedupeNews(items: MarketNewsItem[]): MarketNewsItem[] {
  return [...new Map(items.map((item) => [item.id, item])).values()]
    .sort((left, right) => Date.parse(right.publishedAt ?? right.receivedAt) - Date.parse(left.publishedAt ?? left.receivedAt));
}

function combineFreshness(values: MarketDataQuality["freshness"][]): MarketDataQuality["freshness"] {
  if (!values.length || values.every((value) => value === "unknown")) return "unknown";
  if (values.some((value) => value === "stale")) return "stale";
  if (values.every((value) => value === "fresh")) return "fresh";
  return "mixed";
}

function requestCapabilityIds(
  request: MarketSnapshotRequest,
  transportScopedQuotes = false,
): string[] {
  const ids: string[] = [];
  if (request.include.includes("quotes")) {
    ids.push(transportScopedQuotes
      ? `snapshot:quotes:${request.instrumentIds.join("+")}`
      : "quotes");
  }
  if (request.include.includes("bars")) {
    for (const instrumentId of request.instrumentIds) {
      for (const interval of request.intervals) ids.push(`bars:${instrumentId}:${interval}`);
    }
  }
  if (request.include.includes("news")) ids.push("news");
  if (request.include.includes("announcements")) {
    for (const instrumentId of request.instrumentIds) ids.push(`announcements:${instrumentId}`);
  }
  if (request.include.includes("comparisons")) ids.push("comparisons");
  for (const exchange of new Set(request.instrumentIds.map((instrumentId) => instrumentId.split(":")[0]))) {
    if (exchange !== "SSE" && exchange !== "SZSE") continue;
    ids.push(transportScopedQuotes
      ? `snapshot:status:${exchange}:${request.instrumentIds.join("+")}`
      : `status:${exchange}`);
  }
  return ids;
}

function parseBarCapabilityId(
  id: string,
): { instrumentId: string; interval: MarketInterval } | null {
  const match = /^bars:(SSE|SZSE):(\d{6}):(1d|1m)$/.exec(id);
  return match
    ? { instrumentId: `${match[1]}:${match[2]}`, interval: match[3] as MarketInterval }
    : null;
}

function isSlowCapability(id: string): boolean {
  return id === "news" || id.startsWith("announcements:");
}

function isCoreMarketCapability(id: string): boolean {
  return id === "quotes" || id.startsWith("snapshot:quotes:") || id.startsWith("bars:");
}

function uniqueAttempts(values: MarketProviderAttempt[]): MarketProviderAttempt[] {
  return [...new Map(values.map((attempt) => [
    `${attempt.provider}|${attempt.ok}|${attempt.latencyMs}|${attempt.errorCode}|${attempt.message}`,
    attempt,
  ])).values()];
}

function latest(values: Array<string | null>): string | null {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
