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

export interface UsageLimit {
  id: string;
  label: string;
  usedPercent: number | null;
  windowMinutes: number | null;
  resetsAt: string | null;
}

export interface TokenSummary {
  lifetimeTokens: number | null;
  todayTokens: number | null;
  peakDailyTokens: number | null;
  currentStreakDays: number | null;
  longestStreakDays: number | null;
}

export interface DailyUsagePoint {
  date: string;
  tokens: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}

export interface UsageStatus {
  status: "online" | "stale" | "offline" | "error";
  updatedAt: string;
  limits: UsageLimit[];
  tokenSummary: TokenSummary;
  dailyUsage: DailyUsagePoint[];
  error?: { code: string; message: string };
}

export type DeviceType = "desktop" | "laptop" | "phone" | "server" | "node" | "other";
export type DeviceState = "online" | "offline" | "idle" | "unknown";

export interface DeviceStatus {
  id: string;
  name: string;
  type: DeviceType;
  state: DeviceState;
  lastSeen?: string;
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
