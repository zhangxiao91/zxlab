import type { HealthState, PublicActivity, RuntimeIncident, RuntimeServiceSnapshot, ServiceHealthReport } from "@zxlab/runtime-schema";
import type { ProbeResult } from "./probes";

interface SampleRow { service_id: string; status: HealthState; version: string; observed_at: string; latency_ms: number; error_code: string | null; checks_json: string; public_json: string | null; }

export class RuntimeRepository {
  constructor(private readonly db: D1Database) {}

  async record(results: ProbeResult[], trigger: string) {
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.db.prepare("INSERT INTO runtime_probe_runs (id, started_at, trigger, status) VALUES (?, ?, ?, 'running')").bind(runId, now, trigger).run();
    for (const result of results) await this.recordSample(runId, result, now);
    await this.db.prepare("UPDATE runtime_probe_runs SET completed_at = ?, status = 'completed' WHERE id = ?").bind(new Date().toISOString(), runId).run();
    return runId;
  }

  private async recordSample(runId: string, result: ProbeResult, observedAt: string) {
    const previous = await this.db.prepare("SELECT status, version FROM runtime_samples WHERE service_id = ? ORDER BY observed_at DESC LIMIT 1").bind(result.report.serviceId).first<{ status: HealthState; version: string }>();
    await this.db.prepare(`INSERT INTO runtime_samples (id, run_id, service_id, status, version, observed_at, latency_ms, error_code, checks_json, public_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), runId, result.report.serviceId, result.report.status, result.report.version, observedAt, result.latencyMs, result.errorCode, JSON.stringify(result.report.checks), result.report.public ? JSON.stringify(result.report.public) : null).run();
    if (previous?.version && previous.version !== result.report.version && result.report.version !== "unknown") {
      await this.activity("deployment", result.report.serviceId, `${result.report.serviceId} deployed ${result.report.version}`, "operational", observedAt);
    }
    const priorSameDirection = previous && (previous.status === "operational") === (result.report.status === "operational");
    const open = await this.db.prepare("SELECT id FROM runtime_incidents WHERE service_id = ? AND resolved_at IS NULL ORDER BY opened_at DESC LIMIT 1").bind(result.report.serviceId).first<{ id: string }>();
    if (!open && result.report.status !== "operational" && priorSameDirection) {
      const id = crypto.randomUUID();
      const severity = result.report.status === "offline" ? "offline" : "degraded";
      await this.db.prepare("INSERT INTO runtime_incidents (id, service_id, severity, opened_at, last_status) VALUES (?, ?, ?, ?, ?)").bind(id, result.report.serviceId, severity, observedAt, result.report.status).run();
      await this.activity("incident-opened", result.report.serviceId, `${result.report.serviceId} entered ${severity}`, result.report.status, observedAt);
    } else if (open && result.report.status === "operational" && priorSameDirection) {
      await this.db.prepare("UPDATE runtime_incidents SET resolved_at = ?, last_status = 'operational' WHERE id = ?").bind(observedAt, open.id).run();
      await this.activity("incident-resolved", result.report.serviceId, `${result.report.serviceId} recovered`, "operational", observedAt);
    } else if (open) {
      await this.db.prepare("UPDATE runtime_incidents SET last_status = ? WHERE id = ?").bind(result.report.status, open.id).run();
    }
  }

  private activity(type: string, serviceId: string, title: string, status: HealthState, createdAt: string) {
    return this.db.prepare("INSERT INTO runtime_activities (id, type, service_id, title, status, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), type, serviceId, title, status, createdAt).run();
  }

  async latestRows(): Promise<Array<SampleRow & { public: Record<string, unknown> | null }>> {
    const rows = await this.db.prepare(`SELECT s.* FROM runtime_samples s JOIN (SELECT service_id, MAX(observed_at) observed_at FROM runtime_samples GROUP BY service_id) latest ON latest.service_id = s.service_id AND latest.observed_at = s.observed_at ORDER BY s.service_id`).all<SampleRow>();
    return rows.results.map((row) => ({ ...row, public: row.public_json ? JSON.parse(row.public_json) as Record<string, unknown> : null }));
  }

  async services(): Promise<RuntimeServiceSnapshot[]> {
    return (await this.latestRows()).map((row) => ({ serviceId: row.service_id, status: row.status, version: row.version, observedAt: row.observed_at, latencyMs: row.latency_ms, errorCode: row.error_code, checks: JSON.parse(row.checks_json) }));
  }

  async activities(): Promise<PublicActivity[]> {
    const rows = await this.db.prepare("SELECT id, type, title, status, created_at FROM runtime_activities ORDER BY created_at DESC LIMIT 20").all<{ id: string; type: PublicActivity["type"]; title: string; status: HealthState; created_at: string }>();
    return rows.results.map((row) => ({ id: row.id, type: row.type, title: row.title, status: row.status, createdAt: row.created_at }));
  }

  async incidents(): Promise<RuntimeIncident[]> {
    const rows = await this.db.prepare("SELECT id, service_id, severity, opened_at, resolved_at, last_status FROM runtime_incidents ORDER BY opened_at DESC LIMIT 100").all<{ id: string; service_id: string; severity: RuntimeIncident["severity"]; opened_at: string; resolved_at: string | null; last_status: HealthState }>();
    return rows.results.map((row) => ({ id: row.id, serviceId: row.service_id, severity: row.severity, openedAt: row.opened_at, resolvedAt: row.resolved_at, lastStatus: row.last_status }));
  }

  purge(beforeSamples: string, beforeIncidents: string) {
    return this.db.batch([
      this.db.prepare("DELETE FROM runtime_samples WHERE observed_at < ?").bind(beforeSamples),
      this.db.prepare("DELETE FROM runtime_incidents WHERE resolved_at IS NOT NULL AND resolved_at < ?").bind(beforeIncidents),
      this.db.prepare("DELETE FROM runtime_activities WHERE created_at < ?").bind(beforeIncidents),
      this.db.prepare("DELETE FROM runtime_probe_runs WHERE completed_at < ?").bind(beforeSamples),
    ]);
  }
}
