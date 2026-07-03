export type DataState = "ready" | "loading" | "empty" | "error" | "unavailable";
export type OverallState = "operational" | "partial" | "degraded" | "maintenance" | "unknown";
export type SourceState = "connected" | "partial" | "mock" | "unavailable";
export type StatusScenario = "normal" | "loading" | "empty" | "error" | "unavailable" | "stale" | "partial";

export interface ModuleResult<T> {
  state: DataState;
  data: T | null;
  source: string;
  updatedAt?: string;
  message?: string;
}

export interface OverallStatus {
  state: OverallState;
  label: string;
  message: string;
  sourceState: SourceState;
  stale: boolean;
}

export interface UsageWindow {
  label: string;
  usedPercent: number;
  resetsAt?: string;
}

export interface ModelUsage {
  model: string;
  percent: number;
}

export interface UsageTrendPoint {
  label: string;
  value: number;
}

export interface UsageStatus {
  providerId: string;
  providerName: string;
  fiveHourWindow?: UsageWindow;
  weeklyAllowance?: UsageWindow;
  creditsRemaining?: number;
  nextReset?: string;
  currentModel?: string;
  activeThreads?: number;
  tasksToday?: number;
  tokensUsed?: number;
  modelDistribution?: ModelUsage[];
  recentTrend?: UsageTrendPoint[];
}

export type DeviceType = "desktop" | "laptop" | "phone" | "server" | "node" | "other";
export type DeviceState = "online" | "offline" | "idle" | "unknown";

export interface DeviceStatus {
  id: string;
  name: string;
  type: DeviceType;
  state: DeviceState;
  lastSeen: string;
  latencyMs?: number;
  publicTask?: string;
  updatedAt: string;
}

export interface ActivityItem {
  id: string;
  type: string;
  title: string;
  description?: string;
  timestamp: string;
  href?: string;
  source?: string;
}

export interface StatusSnapshot {
  overall: OverallStatus;
  usage: ModuleResult<UsageStatus>;
  devices: ModuleResult<DeviceStatus[]>;
  activity: ModuleResult<ActivityItem[]>;
  updatedAt: string;
  source: string;
  isMock: boolean;
}

export interface StatusProviderOptions {
  scenario?: StatusScenario;
  signal?: AbortSignal;
  delayMs?: number;
}

export interface StatusProvider {
  readonly id: string;
  getSnapshot(options?: StatusProviderOptions): Promise<StatusSnapshot>;
}
