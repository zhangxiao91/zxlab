export type HealthStatus = "operational" | "degraded" | "offline" | "unknown";
export type StatusVisibility = "public" | "authenticated" | "admin";
export type MetricFormat = "number" | "percentage" | "duration" | "bytes" | "datetime" | "text";
export type MemoryFreshness = "fresh" | "aging" | "stale" | "partial" | "unknown";

export interface StatusMetric { id: string; label: string; value: string | number | null; unit?: string; format?: MetricFormat; status?: HealthStatus; description?: string; updatedAt?: string; visibility?: StatusVisibility; }
export interface StatusIncident { id: string; title: string; description?: string; status: "investigating" | "identified" | "monitoring" | "resolved"; severity: "info" | "warning" | "critical"; startedAt: string; resolvedAt?: string; }
export interface AgentStatus { id: string; name: string; status: HealthStatus; online: boolean; platform: string; version: string; lastHeartbeatAt: string; currentTask?: { id: string; name: string; status: "queued" | "running" | "completed" | "failed"; startedAt?: string }; resources?: { cpuPercent?: number; memoryPercent?: number; diskAvailableBytes?: number; latencyMs?: number }; capabilities: string[]; taskStats?: { completedToday: number; failedToday: number }; lastError?: string; }
export interface MemorySource { id: string; name: string; status: HealthStatus; updatedAt: string; }
export interface MemoryStatusDetails { freshness: MemoryFreshness; sources: MemorySource[]; lastSyncAt: string; lastFullIndexAt: string; lastError?: string; }
export interface RuntimeService { id: string; name: string; status: HealthStatus; summary: string; }
export interface RuntimeStatusDetails { version: string; lastDeploymentAt: string; services: RuntimeService[]; lastSuccessfulCronAt: string; }
export type StatusModuleDetails = { kind: "agent"; agents: AgentStatus[] } | { kind: "memory"; memory: MemoryStatusDetails } | { kind: "runtime"; runtime: RuntimeStatusDetails };
export interface StatusModule { id: string; name: string; description: string; category: "agent" | "memory" | "runtime"; status: HealthStatus; summary: string; updatedAt: string; visibility: StatusVisibility; critical?: boolean; metrics: StatusMetric[]; incidents?: StatusIncident[]; details: StatusModuleDetails; }
export interface StatusActivity { id: string; moduleId: string; type: "heartbeat" | "task_started" | "task_completed" | "task_failed" | "sync" | "index" | "deploy" | "incident" | "recovery"; title: string; description?: string; status?: HealthStatus; createdAt: string; visibility?: StatusVisibility; }
export interface StatusOverview { status: HealthStatus; summary: string; updatedAt: string; counts: { total: number; operational: number; degraded: number; offline: number; unknown: number; }; }
export interface StatusResponse { overview: StatusOverview; modules: StatusModule[]; activities: StatusActivity[]; generatedAt: string; }
export interface StatusProvider { getStatus(): Promise<StatusModule>; getActivities?(): Promise<StatusActivity[]>; }
