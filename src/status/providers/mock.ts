import type {
  ActivityItem,
  DeviceStatus,
  ModuleResult,
  StatusProvider,
  StatusProviderOptions,
  StatusScenario,
  StatusSnapshot,
  UsageStatus,
} from "../types";

const wait = (delay: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(resolve, delay);
    signal?.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        reject(new DOMException("Request aborted", "AbortError"));
      },
      { once: true },
    );
  });

function ready<T>(data: T, updatedAt: string): ModuleResult<T> {
  return { state: "ready", data, source: "ZXLab demo provider", updatedAt };
}

function moduleState<T>(state: ModuleResult<T>["state"], message: string): ModuleResult<T> {
  return { state, data: null, source: "ZXLab demo provider", message };
}

export function createMockStatusSnapshot(scenario: StatusScenario = "normal"): StatusSnapshot {
  const now = new Date();
  const updatedAt = new Date(
    scenario === "stale" ? now.valueOf() - 45 * 60 * 1000 : now.valueOf(),
  ).toISOString();

  const usage: UsageStatus = {
    providerId: "codex-demo",
    providerName: "Codex demo",
    fiveHourWindow: { label: "5-hour window", usedPercent: 38, resetsAt: new Date(now.valueOf() + 2 * 60 * 60 * 1000).toISOString() },
    weeklyAllowance: { label: "Weekly allowance", usedPercent: 54, resetsAt: new Date(now.valueOf() + 3 * 24 * 60 * 60 * 1000).toISOString() },
    creditsRemaining: 24,
    nextReset: new Date(now.valueOf() + 2 * 60 * 60 * 1000).toISOString(),
    currentModel: "Demo model",
    activeThreads: 3,
    tasksToday: 7,
    tokensUsed: 128400,
    modelDistribution: [
      { model: "Frontier demo", percent: 64 },
      { model: "Fast demo", percent: 36 },
    ],
    recentTrend: [
      { label: "Mon", value: 28 }, { label: "Tue", value: 42 }, { label: "Wed", value: 35 },
      { label: "Thu", value: 58 }, { label: "Fri", value: 46 },
    ],
  };

  const devices: DeviceStatus[] = [
    {
      id: "studio-workstation-demo",
      name: "Studio workstation",
      type: "desktop",
      state: "online",
      lastSeen: updatedAt,
      latencyMs: 18,
      publicTask: "Local development",
      updatedAt,
    },
    {
      id: "travel-laptop-demo",
      name: "Travel laptop",
      type: "laptop",
      state: "idle",
      lastSeen: new Date(now.valueOf() - 22 * 60 * 1000).toISOString(),
      publicTask: "No public task",
      updatedAt,
    },
    {
      id: "personal-phone-demo",
      name: "Personal phone",
      type: "phone",
      state: "unknown",
      lastSeen: new Date(now.valueOf() - 75 * 60 * 1000).toISOString(),
      updatedAt,
    },
  ];

  const activity: ActivityItem[] = [
    {
      id: "demo-lab-route",
      type: "lab",
      title: "Lab routes prepared",
      description: "Example activity showing where a future experiment update would appear.",
      timestamp: updatedAt,
      href: "/lab",
      source: "Demo activity",
    },
    {
      id: "demo-note-update",
      type: "note",
      title: "Notebook entry published",
      description: "Example content event; this feed is not connected to a live source.",
      timestamp: new Date(now.valueOf() - 3 * 60 * 60 * 1000).toISOString(),
      href: "/notes",
      source: "Demo activity",
    },
    {
      id: "demo-deployment",
      type: "deployment",
      title: "Static site deployment completed",
      description: "Example deployment event for the public activity interface.",
      timestamp: new Date(now.valueOf() - 8 * 60 * 60 * 1000).toISOString(),
      source: "Demo activity",
    },
  ];

  const base: StatusSnapshot = {
    overall: {
      state: scenario === "partial" ? "partial" : "operational",
      label: scenario === "partial" ? "Partial demo data" : "Demo systems operational",
      message: "Illustrative values only. No private service is connected.",
      sourceState: scenario === "partial" ? "partial" : "mock",
      stale: scenario === "stale",
    },
    usage: ready(usage, updatedAt),
    devices: ready(devices, updatedAt),
    activity: ready(activity, updatedAt),
    updatedAt,
    source: "ZXLab demo provider",
    isMock: true,
  };

  if (scenario === "normal" || scenario === "stale") return base;
  if (scenario === "partial") {
    return {
      ...base,
      usage: moduleState("unavailable", "Usage provider is not connected in this partial demo."),
      activity: moduleState("error", "The demo activity source returned an isolated error."),
    };
  }

  const state = scenario === "loading" ? "loading" : scenario;
  const normalizedState = state === "error" || state === "unavailable" || state === "empty" || state === "loading"
    ? state
    : "unavailable";
  const message = {
    loading: "Waiting for the demo provider.",
    empty: "The provider returned no public data.",
    error: "The demo provider returned an error.",
    unavailable: "No public status provider is connected.",
  }[normalizedState];

  return {
    ...base,
    overall: {
      state: "unknown",
      label: normalizedState === "loading" ? "Refreshing demo status" : "Status unavailable",
      message,
      sourceState: "unavailable",
      stale: false,
    },
    usage: moduleState(normalizedState, message),
    devices: moduleState(normalizedState, message),
    activity: moduleState(normalizedState, message),
  };
}

export const mockStatusProvider: StatusProvider = {
  id: "mock",
  async getSnapshot(options: StatusProviderOptions = {}) {
    if (options.delayMs && typeof window !== "undefined") {
      await wait(options.delayMs, options.signal);
    }
    return createMockStatusSnapshot(options.scenario);
  },
};
