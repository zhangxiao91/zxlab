const numberOrNull = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
const textOrNull = (value) => typeof value === "string" && value.trim() ? value.trim() : null;

const titleCase = (value) => value
  .replace(/[_-]+/g, " ")
  .replace(/\b\w/g, (letter) => letter.toUpperCase());

export function limitLabel(snapshot, windowName, minutes) {
  if (minutes === 300) return "5-hour window";
  if (minutes === 10080) return "Weekly window";
  const name = textOrNull(snapshot?.limitName);
  if (name) return `${name} ${windowName}`;
  if (minutes && minutes % 1440 === 0) return `${minutes / 1440}-day window`;
  if (minutes && minutes % 60 === 0) return `${minutes / 60}-hour window`;
  return `${titleCase(textOrNull(snapshot?.limitId) ?? "Codex")} ${windowName}`;
}

function normalizeWindow(snapshot, windowName, windowData) {
  if (!windowData || typeof windowData !== "object") return null;
  const duration = numberOrNull(windowData.windowDurationMins);
  const resetSeconds = numberOrNull(windowData.resetsAt);
  return {
    id: `${textOrNull(snapshot.limitId) ?? "codex"}:${windowName}`,
    label: limitLabel(snapshot, windowName, duration),
    usedPercent: numberOrNull(windowData.usedPercent),
    windowMinutes: duration,
    resetsAt: resetSeconds === null ? null : new Date(resetSeconds * 1000).toISOString(),
  };
}

function snapshotsFrom(raw) {
  const byId = raw?.rateLimitsByLimitId;
  if (byId && typeof byId === "object" && !Array.isArray(byId)) {
    const values = Object.values(byId).filter((value) => value && typeof value === "object");
    if (values.length) return values;
  }
  return raw?.rateLimits && typeof raw.rateLimits === "object" ? [raw.rateLimits] : [];
}

export function normalizeUsage(rateLimitsRaw, usageRaw, now = new Date()) {
  const limits = snapshotsFrom(rateLimitsRaw).flatMap((snapshot) => [
    normalizeWindow(snapshot, "primary", snapshot.primary),
    normalizeWindow(snapshot, "secondary", snapshot.secondary),
  ].filter(Boolean));

  const summary = usageRaw?.summary && typeof usageRaw.summary === "object" ? usageRaw.summary : {};
  const dailyUsage = Array.isArray(usageRaw?.dailyUsageBuckets)
    ? usageRaw.dailyUsageBuckets.flatMap((bucket) => {
        const date = textOrNull(bucket?.startDate);
        const tokens = numberOrNull(bucket?.tokens);
        if (!date || tokens === null || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
        return [{ date, tokens }];
      }).sort((a, b) => a.date.localeCompare(b.date))
    : [];
  const today = now.toISOString().slice(0, 10);

  return {
    status: "online",
    updatedAt: now.toISOString(),
    limits,
    tokenSummary: {
      lifetimeTokens: numberOrNull(summary.lifetimeTokens),
      todayTokens: dailyUsage.find((point) => point.date === today)?.tokens ?? null,
      peakDailyTokens: numberOrNull(summary.peakDailyTokens),
      currentStreakDays: numberOrNull(summary.currentStreakDays),
      longestStreakDays: numberOrNull(summary.longestStreakDays),
    },
    dailyUsage,
  };
}

export function errorResponse(code, message, status = "error", updatedAt = new Date().toISOString()) {
  return {
    status,
    updatedAt,
    limits: [],
    tokenSummary: {
      lifetimeTokens: null,
      todayTokens: null,
      peakDailyTokens: null,
      currentStreakDays: null,
      longestStreakDays: null,
    },
    dailyUsage: [],
    error: { code, message },
  };
}
