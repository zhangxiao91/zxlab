import { statusConfig } from "./config";
import { mockStatusProvider, createMockStatusSnapshot } from "./providers/mock";
import { remoteStatusProvider } from "./providers/remote";
import { tailscaleStatusProvider } from "./providers/tailscale";
import type { ActivityItem, DeviceStatus, StatusScenario, StatusSnapshot } from "./types";

const scenarios: StatusScenario[] = ["normal", "loading", "empty", "error", "unavailable", "stale", "partial"];

export function parseStatusScenario(value: string | null): StatusScenario {
  return scenarios.includes(value as StatusScenario) ? value as StatusScenario : "normal";
}

export async function getStatusSnapshot(
  scenario: StatusScenario = "normal",
  options: { signal?: AbortSignal; delayMs?: number } = {},
) {
  if (scenario !== "normal") {
    return mockStatusProvider.getSnapshot({ scenario, signal: options.signal, delayMs: options.delayMs });
  }
  const provider = {
    mock: mockStatusProvider,
    tailscale: tailscaleStatusProvider,
    remote: remoteStatusProvider,
  }[statusConfig.providerMode];
  return provider.getSnapshot({ scenario, signal: options.signal, delayMs: options.delayMs });
}

export function shouldLoadLiveStatus() {
  return statusConfig.providerMode !== "mock";
}

function setText(root: ParentNode, selector: string, value: string | number | undefined) {
  const element = root.querySelector<HTMLElement>(selector);
  if (element) element.textContent = value === undefined ? "Unavailable" : String(value);
}

function formatRelativeTime(value: string) {
  const difference = new Date(value).getTime() - Date.now();
  const units = [
    ["day", 24 * 60 * 60 * 1000],
    ["hour", 60 * 60 * 1000],
    ["minute", 60 * 1000],
    ["second", 1000],
  ] as const;
  const [unit, divisor] = units.find(([, size]) => Math.abs(difference) >= size) ?? units[3];
  return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(
    Math.round(difference / divisor),
    unit,
  );
}

function renderRelativeTime(element: HTMLTimeElement) {
  const value = element.dateTime;
  if (!value) return;
  const prefix = element.dataset.prefix ?? "";
  element.textContent = `${prefix}${formatRelativeTime(value)}`;
  element.title = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" })
    .format(new Date(value));
}

export function enhanceRelativeTimes(root: ParentNode) {
  root.querySelectorAll<HTMLTimeElement>("time[data-relative-time]").forEach(renderRelativeTime);
}

function setTime(root: ParentNode, selector: string, value: string | undefined) {
  const element = root.querySelector<HTMLTimeElement>(selector);
  if (!element || !value) return;
  element.dateTime = value;
  renderRelativeTime(element);
}

function renderModuleState(root: HTMLElement, state: string, message?: string) {
  const ready = root.querySelector<HTMLElement>("[data-module-ready]");
  const fallback = root.querySelector<HTMLElement>("[data-module-fallback]");
  root.dataset.moduleState = state;
  if (ready) ready.hidden = state !== "ready";
  if (fallback) {
    fallback.hidden = state === "ready";
    setText(fallback, "[data-state-title]", {
      loading: "Loading demo data",
      empty: "No public data yet",
      error: "Module error",
      unavailable: "Source unavailable",
    }[state] ?? "Source unavailable");
    setText(fallback, "[data-state-message]", message ?? "This module has no public data.");
  }
}

function createDeviceItem(device: DeviceStatus) {
  const item = document.createElement("li");
  item.className = "device-item";
  item.dataset.deviceState = device.state;

  const heading = document.createElement("div");
  const name = document.createElement("h3");
  const type = document.createElement("p");
  name.textContent = device.name;
  type.textContent = device.type;
  heading.append(name, type);

  const state = document.createElement("span");
  state.className = "status-indicator";
  state.dataset.state = device.state;
  const dot = document.createElement("span");
  dot.setAttribute("aria-hidden", "true");
  state.append(dot, document.createTextNode(device.state));

  const detail = document.createElement("div");
  const seen = document.createElement("time");
  seen.dateTime = device.lastSeen;
  seen.dataset.relativeTime = "true";
  seen.dataset.prefix = "Last seen ";
  renderRelativeTime(seen);
  detail.append(seen);
  if (device.publicTask) {
    const task = document.createElement("p");
    task.textContent = device.publicTask;
    detail.append(task);
  }
  if (device.latencyMs !== undefined) {
    const latency = document.createElement("p");
    latency.textContent = `${device.latencyMs} ms demo latency`;
    detail.append(latency);
  }

  item.append(heading, state, detail);
  return item;
}

function createActivityItem(item: ActivityItem) {
  const listItem = document.createElement("li");
  const body = item.href?.startsWith("/") ? document.createElement("a") : document.createElement("div");
  if (body instanceof HTMLAnchorElement) body.href = item.href!;
  const meta = document.createElement("div");
  const type = document.createElement("span");
  const time = document.createElement("time");
  type.textContent = item.type;
  time.dateTime = item.timestamp;
  time.dataset.relativeTime = "true";
  renderRelativeTime(time);
  meta.append(type, time);
  const title = document.createElement("h3");
  title.textContent = item.title;
  body.append(meta, title);
  if (item.description) {
    const description = document.createElement("p");
    description.textContent = item.description;
    body.append(description);
  }
  listItem.append(body);
  return listItem;
}

export function renderStatusSnapshot(root: HTMLElement, snapshot: StatusSnapshot) {
  root.dataset.overallState = snapshot.overall.state;
  root.dataset.stale = String(snapshot.overall.stale);
  root.setAttribute("aria-busy", String(snapshot.usage.state === "loading"));
  setText(root, "[data-overall-label]", snapshot.overall.label);
  setText(root, "[data-overall-message]", snapshot.overall.message);
  setText(root, "[data-source-label]", snapshot.source);
  setText(root, "[data-freshness]", snapshot.overall.stale
    ? "Stale status snapshot"
    : snapshot.isMock ? "Fresh demo snapshot" : "Fresh live snapshot");
  setTime(root, "[data-updated-at]", snapshot.updatedAt);
  const overallIndicator = root.querySelector<HTMLElement>("[data-status-indicator='overall']");
  if (overallIndicator) {
    overallIndicator.dataset.state = snapshot.overall.state;
    setText(overallIndicator, "[data-indicator-label]", snapshot.overall.label);
  }

  const usageRoot = root.querySelector<HTMLElement>("[data-status-module='usage']");
  if (usageRoot) {
    renderModuleState(usageRoot, snapshot.usage.state, snapshot.usage.message);
    setText(usageRoot, "[data-usage-provider]", snapshot.usage.data?.providerName ?? snapshot.usage.source);
    if (snapshot.usage.data) {
      setText(usageRoot, "[data-field='current-model']", snapshot.usage.data.currentModel);
      setText(usageRoot, "[data-field='credits']", snapshot.usage.data.creditsRemaining);
      setText(usageRoot, "[data-field='threads']", snapshot.usage.data.activeThreads);
      setText(usageRoot, "[data-field='tasks']", snapshot.usage.data.tasksToday);
      setText(usageRoot, "[data-field='tokens']", snapshot.usage.data.tokensUsed?.toLocaleString());
      const fiveHour = usageRoot.querySelector<HTMLProgressElement>("[data-progress='five-hour']");
      const weekly = usageRoot.querySelector<HTMLProgressElement>("[data-progress='weekly']");
      if (fiveHour && snapshot.usage.data.fiveHourWindow) fiveHour.value = snapshot.usage.data.fiveHourWindow.usedPercent;
      if (weekly && snapshot.usage.data.weeklyAllowance) weekly.value = snapshot.usage.data.weeklyAllowance.usedPercent;
      setText(usageRoot, "[data-progress-value='five-hour']", `${snapshot.usage.data.fiveHourWindow?.usedPercent ?? 0}%`);
      setText(usageRoot, "[data-progress-value='weekly']", `${snapshot.usage.data.weeklyAllowance?.usedPercent ?? 0}%`);
      setText(usageRoot, "[data-field='five-hour-value']", `${snapshot.usage.data.fiveHourWindow?.usedPercent ?? 0}%`);
      setText(usageRoot, "[data-field='weekly-value']", `${snapshot.usage.data.weeklyAllowance?.usedPercent ?? 0}%`);
    }
  }

  const devicesRoot = root.querySelector<HTMLElement>("[data-status-module='devices']");
  if (devicesRoot) {
    renderModuleState(devicesRoot, snapshot.devices.state, snapshot.devices.message);
    setText(devicesRoot, "[data-device-provider]", snapshot.devices.source);
    const list = devicesRoot.querySelector<HTMLUListElement>("[data-device-list]");
    if (list && snapshot.devices.data) list.replaceChildren(...snapshot.devices.data.map(createDeviceItem));
  }

  const activityRoot = root.querySelector<HTMLElement>("[data-status-module='activity']");
  if (activityRoot) {
    renderModuleState(activityRoot, snapshot.activity.state, snapshot.activity.message);
    setText(activityRoot, "[data-activity-provider]", snapshot.activity.source);
    const list = activityRoot.querySelector<HTMLOListElement>("[data-activity-list]");
    if (list && snapshot.activity.data) list.replaceChildren(...snapshot.activity.data.map(createActivityItem));
  }
}

export function renderLoadingSnapshot(root: HTMLElement) {
  renderStatusSnapshot(root, createMockStatusSnapshot("loading"));
}

export function scheduleStatusRefresh(callback: () => void) {
  if (!statusConfig.autoRefreshMs) return () => {};
  let timer: number | undefined;
  const start = () => {
    if (document.hidden || timer !== undefined) return;
    timer = window.setInterval(callback, statusConfig.autoRefreshMs!);
  };
  const stop = () => {
    if (timer === undefined) return;
    window.clearInterval(timer);
    timer = undefined;
  };
  const handleVisibility = () => document.hidden ? stop() : start();
  document.addEventListener("visibilitychange", handleVisibility);
  start();
  return () => {
    stop();
    document.removeEventListener("visibilitychange", handleVisibility);
  };
}
