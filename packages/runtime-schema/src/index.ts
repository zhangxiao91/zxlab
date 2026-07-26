export type HealthState = "operational" | "degraded" | "offline" | "unknown";

export interface HealthCheck {
  id: string;
  status: HealthState;
  latencyMs?: number;
  lastSuccessAt?: string;
  errorCode?: string;
}

export interface ServiceHealthReport {
  schemaVersion: "1";
  serviceId: string;
  status: HealthState;
  version: string;
  generatedAt: string;
  checks: HealthCheck[];
  public?: Record<string, unknown>;
}

export interface PublicModule<T = Record<string, unknown>> {
  id: "runtime" | "memory" | "agents" | "usage";
  name: string;
  status: HealthState;
  summary: string;
  updatedAt: string | null;
  data: T | null;
}

export interface PublicActivity {
  id: string;
  type: "incident-opened" | "incident-resolved" | "deployment";
  title: string;
  status: HealthState;
  createdAt: string;
}

export interface RuntimePublicSnapshot {
  schemaVersion: "1";
  overall: {
    status: HealthState;
    summary: string;
    stale: boolean;
    counts: Record<HealthState | "total", number>;
  };
  modules: PublicModule[];
  activities: PublicActivity[];
  generatedAt: string;
}

export interface RuntimeServiceSnapshot {
  serviceId: string;
  status: HealthState;
  version: string;
  observedAt: string;
  latencyMs: number;
  errorCode: string | null;
  checks: HealthCheck[];
}

export interface RuntimeIncident {
  id: string;
  serviceId: string;
  severity: "degraded" | "offline";
  openedAt: string;
  resolvedAt: string | null;
  lastStatus: HealthState;
}

export interface MemoryOverview {
  status: HealthState;
  activeCount: number;
  proposedCount: number;
  lastWriteAt: string | null;
  lastConsolidationAt: string | null;
}
