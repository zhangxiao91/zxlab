import type { CollectionRunDetail, SignalSourceType, StartCollectionRequest } from "@zxlab/signal-schema";
import type { SignalCollector } from "../collectors/types";
import { createCollectors } from "../collectors";
import { SIGNAL_SOURCES, findSource, type SignalSourceConfig } from "../config/sources";
import { SignalError } from "../lib/errors";
import { CollectionRepository } from "../repositories/collection-repository";
import { normalizeCandidate } from "./candidate-normalizer";

export interface CollectionRunOptions {
  runId?: string;
  triggerType?: "manual" | "workflow";
  now?: string;
}

export class CollectionService {
  private readonly repository: CollectionRepository;
  private readonly collectors: Map<SignalSourceType, SignalCollector>;

  constructor(private readonly env: Env, collectors?: Map<SignalSourceType, SignalCollector>) {
    this.repository = new CollectionRepository(env.DB);
    this.collectors = collectors ?? createCollectors(env);
  }

  async run(request: StartCollectionRequest, options: CollectionRunOptions = {}): Promise<CollectionRunDetail> {
    const now = options.now ?? new Date().toISOString();
    const runId = options.runId ?? crypto.randomUUID();
    const sources = this.selectSources(request);
    await this.repository.syncSources(SIGNAL_SOURCES, now);
    await this.repository.createRun(runId, options.triggerType ?? "manual", sources.length, now);
    let successSources = 0;
    let failedSources = 0;
    let fetched = 0;
    let inserted = 0;
    let duplicates = 0;
    const errors: string[] = [];

    for (const source of sources) {
      const sourceRunId = `${runId}:${source.id}`;
      await this.repository.startSourceRun(sourceRunId, runId, source.id, new Date().toISOString());
      try {
        const collector = this.collectors.get(source.type);
        if (!collector) throw new SignalError("SOURCE_DISABLED", `No collector exists for ${source.type}`, 409);
        const since = request.since ?? new Date(Date.parse(now) - source.lookbackHours * 3_600_000).toISOString();
        const rawItems = await collector.collect(source, { runId, now, since });
        let sourceInserted = 0;
        let sourceDuplicates = 0;
        for (const raw of rawItems) {
          const normalized = await normalizeCandidate(source, raw, { runId, now });
          const effectiveTime = Date.parse(normalized.publishedAt ?? normalized.updatedAt ?? normalized.fetchedAt);
          if (Number.isFinite(effectiveTime) && effectiveTime < Date.parse(since)) continue;
          const result = await this.repository.persistCandidate(normalized, request.dryRun);
          if (result.inserted) sourceInserted += 1;
          if (result.duplicate) sourceDuplicates += 1;
        }
        fetched += rawItems.length;
        inserted += sourceInserted;
        duplicates += sourceDuplicates;
        successSources += 1;
        await this.repository.completeSourceRun(sourceRunId, { fetched: rawItems.length, inserted: sourceInserted, duplicates: sourceDuplicates });
      } catch (cause) {
        failedSources += 1;
        const error = cause instanceof SignalError ? cause : new SignalError("SOURCE_FETCH_FAILED", "Source collection failed", 502, cause);
        errors.push(`${source.id}:${error.code}:${error.message.replace(/\s+/g, " ").slice(0, 240)}`);
        await this.repository.failSourceRun(sourceRunId, error.code, error.message);
      }
    }
    await this.repository.finalizeRun(runId, { successSources, failedSources, fetched, inserted, duplicates, errors });
    return this.repository.getRun(runId);
  }

  private selectSources(request: StartCollectionRequest): SignalSourceConfig[] {
    if (request.sourceIds?.length) {
      return request.sourceIds.map((id) => {
        const source = findSource(id);
        if (!source) throw new SignalError("SOURCE_NOT_FOUND", `Unknown source: ${id}`, 404);
        if (!source.enabled) throw new SignalError("SOURCE_DISABLED", `Source is disabled: ${id}`, 409);
        const missingSecret = this.missingSecret(source);
        if (missingSecret) throw new SignalError("SOURCE_DISABLED", `Source ${id} requires ${missingSecret}`, 409);
        if (request.sourceTypes?.length && !request.sourceTypes.includes(source.type)) {
          throw new SignalError("INVALID_REQUEST", `Source ${id} does not match sourceTypes`, 400);
        }
        return source;
      });
    }
    const sources = SIGNAL_SOURCES.filter((source) => {
      if (!source.enabled || (request.sourceTypes?.length && !request.sourceTypes.includes(source.type))) return false;
      const missingSecret = this.missingSecret(source);
      if (missingSecret) {
        console.warn(JSON.stringify({ event: "signal_source_skipped", sourceId: source.id, reason: "missing_secret", secret: missingSecret }));
        return false;
      }
      return true;
    });
    if (!sources.length) throw new SignalError("SOURCE_NOT_FOUND", "No enabled sources matched the request", 404);
    return [...sources];
  }

  private missingSecret(source: SignalSourceConfig): string | undefined {
    if (!source.requiresSecret) return undefined;
    const value = (this.env as unknown as Record<string, string | undefined>)[source.requiresSecret];
    return value ? undefined : source.requiresSecret;
  }
}
