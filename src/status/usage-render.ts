import type { UsageStatus } from "./types";
import { buildHeatmap, chartGeometry, formatCompactNumber, usageForRange } from "./usage-utils";

const escape = (value: unknown) => String(value).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[character]!));
const fullNumber = (value: number | null) => value === null ? "Unavailable" : new Intl.NumberFormat("en").format(value);
const dateLabel = (value: string) => new Intl.DateTimeFormat("en", {
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
}).format(new Date(`${value}T00:00:00Z`));
const duration = (minutes: number | null) => {
  if (minutes === null) return "Window unavailable";
  if (minutes % 1440 === 0) return `${minutes / 1440} days`;
  if (minutes % 60 === 0) return `${minutes / 60} hours`;
  return `${minutes} minutes`;
};

function limitCards(usage: UsageStatus) {
  if (!usage.limits.length) return '<p class="usage-empty-copy">No rate-limit windows were returned by this Codex version.</p>';
  return usage.limits.map((limit) => {
    const percentage = limit.usedPercent === null ? 0 : Math.max(0, Math.min(100, limit.usedPercent));
    return `<article class="usage-limit-card">
      <div class="usage-limit-card__top"><p>${escape(limit.label)}</p><strong>${limit.usedPercent === null ? "—" : `${escape(limit.usedPercent)}%`}</strong></div>
      <div class="usage-limit-track" role="progressbar" aria-label="${escape(limit.label)} used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percentage}"><span style="--usage-progress:${percentage}%"></span></div>
      <div class="usage-limit-card__meta"><span>${escape(duration(limit.windowMinutes))}</span>${limit.resetsAt ? `<time data-reset-at datetime="${escape(limit.resetsAt)}">Reset time unavailable</time>` : "<span>Reset unavailable</span>"}</div>
    </article>`;
  }).join("");
}

function summaryCards(usage: UsageStatus, rangePoints: ReturnType<typeof usageForRange>) {
  const total = rangePoints.reduce((sum, point) => sum + point.tokens, 0);
  const lifetime = usage.tokenSummary.lifetimeTokens;
  const approximateValue = lifetime === null ? null : lifetime / 1_000_000 * 4;
  const entries = [
    { label: "Selected range", value: total, display: formatCompactNumber(total), title: `${fullNumber(total)} tokens` },
    { label: "Lifetime", value: lifetime, display: formatCompactNumber(lifetime), title: `${fullNumber(lifetime)} tokens` },
    { label: "Peak day", value: usage.tokenSummary.peakDailyTokens, display: formatCompactNumber(usage.tokenSummary.peakDailyTokens), title: `${fullNumber(usage.tokenSummary.peakDailyTokens)} tokens` },
    {
      label: "Approx. token value",
      value: approximateValue,
      display: approximateValue === null ? "Unavailable" : `≈ ${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(approximateValue)}`,
      title: approximateValue === null ? "Unavailable" : `${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(approximateValue)} estimate at $4 per 1M tokens`,
    },
  ];
  return entries.map((entry) => `<div><span>${entry.label}</span><strong title="${escape(entry.title)}">${escape(entry.display)}</strong></div>`).join("");
}

function chart(usage: UsageStatus, days: 7 | 30 | 90) {
  const points = usageForRange(usage.dailyUsage, days, new Date(usage.updatedAt));
  if (!points.length) return `<div class="usage-chart-empty"><p>No daily Token history is available for this range.</p></div>`;
  const geometry = chartGeometry(points);
  const hitWidth = Math.max(18, 960 / geometry.points.length);
  return `<div class="usage-chart-wrap">
    <svg class="usage-chart" viewBox="0 0 960 280" role="img" aria-label="Daily Token usage for the selected range">
      <defs><linearGradient id="usage-area-gradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d8ff73" stop-opacity=".34"/><stop offset="1" stop-color="#d8ff73" stop-opacity="0"/></linearGradient></defs>
      <g class="usage-chart__grid" aria-hidden="true"><line x1="0" y1="70" x2="960" y2="70"/><line x1="0" y1="140" x2="960" y2="140"/><line x1="0" y1="210" x2="960" y2="210"/></g>
      <path class="usage-chart__area" d="${geometry.area}"/><path class="usage-chart__line" d="${geometry.path}"/>
      ${geometry.points.map((point) => {
        const label = `${dateLabel(point.date)} · ${fullNumber(point.tokens)} tokens`;
        const x = Math.max(0, Math.min(960 - hitWidth, point.x - hitWidth / 2));
        return `<g class="usage-chart__point">
          <line x1="${point.x}" y1="0" x2="${point.x}" y2="280" aria-hidden="true" />
          <circle cx="${point.x}" cy="${point.y}" r="7" aria-hidden="true" />
          <rect tabindex="0" x="${x}" y="0" width="${hitWidth}" height="280" data-chart-point data-tooltip="${label}" aria-label="${label}"></rect>
        </g>`;
      }).join("")}
    </svg>
    <div class="usage-chart__axis"><time datetime="${points[0].date}">${points[0].date}</time><time datetime="${points.at(-1)!.date}">${points.at(-1)!.date}</time></div>
  </div>`;
}

function heatmap(usage: UsageStatus) {
  const days = buildHeatmap(usage.dailyUsage);
  if (!days.length) return '<div class="usage-heatmap-empty"><p>No historical Token data has been returned yet.</p></div>';
  const first = days.find((day) => day.tokens !== null)?.date ?? days[0].date;
  const last = days.at(-1)!.date;
  const monthLabels = Array.from(new Set(days.filter((_, index) => index % 7 === 0).map((day) => day.date.slice(0, 7))))
    .map((month) => `<span>${new Intl.DateTimeFormat("en", { month: "short", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`))}</span>`).join("");
  return `<div class="usage-heatmap-scroll" tabindex="0" aria-label="Scrollable Token activity calendar">
    <div class="usage-heatmap-months" aria-hidden="true">${monthLabels}</div>
    <div class="usage-heatmap" role="grid" aria-label="Token activity from ${first} to ${last}">
      ${days.map((day) => { const label = `${dateLabel(day.date)} · ${day.tokens === null ? "No data" : `${fullNumber(day.tokens)} tokens · intensity ${day.level} of 4`}`; return `<button type="button" role="gridcell" data-heatmap-day data-level="${day.level}" data-has-data="${day.tokens !== null}" data-tooltip="${label}" aria-label="${label}"><span class="sr-only">${day.date}</span></button>`; }).join("")}
    </div>
  </div>
  <div class="usage-heatmap-footer"><span>${first} — ${last}</span><div aria-label="Intensity legend"><span>Less</span>${[0,1,2,3,4].map((level) => `<i data-level="${level}"></i>`).join("")}<span>More</span></div></div>`;
}

export function renderUsageContent(usage: UsageStatus, days: 7 | 30 | 90 = 30, isMock = false) {
  const points = usageForRange(usage.dailyUsage, days, new Date(usage.updatedAt));
  return `<div class="usage-live-state" data-usage-status="${usage.status}">
    <div class="usage-source-line"><span>${isMock ? "Illustrative demo data" : usage.status === "online" ? "Live App Server data" : usage.status === "stale" ? "Cached App Server data" : "Usage unavailable"}</span><time datetime="${escape(usage.updatedAt)}" data-relative-time data-prefix="Updated ">${escape(usage.updatedAt)}</time></div>
    <div class="usage-limits">${limitCards(usage)}</div>
    <section class="usage-trend" aria-labelledby="token-trend-title">
      <div class="usage-subhead"><div><p>Daily totals</p><h3 id="token-trend-title">Token usage</h3></div><div class="usage-range" role="group" aria-label="Token chart date range">${[7,30,90].map((range) => `<button type="button" data-usage-range="${range}" aria-pressed="${range === days}">${range}D</button>`).join("")}</div></div>
      <div class="usage-summary">${summaryCards(usage, points)}</div>${chart(usage, days)}
    </section>
    <section class="usage-calendar" aria-labelledby="usage-calendar-title"><div class="usage-subhead"><div><p>Daily intensity</p><h3 id="usage-calendar-title">Activity field</h3></div><output class="usage-calendar__reading" data-usage-reading aria-live="polite">Hover or focus a day to inspect tokens</output></div>${heatmap(usage)}</section>
    <output class="usage-tooltip" role="tooltip" data-usage-tooltip hidden></output>
  </div>`;
}
