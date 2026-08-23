export type ResearchArtifactKind =
  | "normalized_daily_history.v1"
  | "financial_statement.v1"
  | "official_filing_identity.v1";

export interface FinancialStatementProjection {
  statementType: "income" | "cash_flow" | "balance_sheet";
  reportPeriod: { start: string; end: string; basis: "quarter" | "year_to_date" | "fiscal_year" };
  reportTypeCode: string;
  dataState: string;
  cells: Array<{ metric: string; value: string; unit: "CNY" }>;
}

export interface OfficialFilingProjection {
  filingId: string;
  reportPeriodEnd: string;
  reportType: "quarterly" | "semiannual" | "annual";
  title: string;
  publishedAt: string;
  url: string;
}

export interface ResearchArtifactCandidate {
  kind: ResearchArtifactKind;
  subjectId: string;
  logicalKey: string;
  provider: string;
  providerVersion: string;
  sourceAsOf: string;
  retrievedAt: string;
  payload: unknown;
  rawPayload: unknown;
  warnings?: string[];
  projection?: FinancialStatementProjection | OfficialFilingProjection;
}

export interface CapturedResearchArtifactRelation {
  fromLogicalKey: string;
  toLogicalKey: string;
  relation: "corroborated_by" | "derived_from";
}

export interface CapturedResearchArtifactBatch {
  candidates: ResearchArtifactCandidate[];
  relations?: CapturedResearchArtifactRelation[];
}

export interface ResearchArtifactRef {
  artifactId: string;
  kind: ResearchArtifactKind;
  subjectId: string;
  logicalKey: string;
  sourceAsOf: string;
  firstObservedAt: string;
  contentDigest: `sha256:${string}`;
  provider: string;
  providerVersion: string;
  retrievedAt: string;
}

export interface ResearchArtifact extends ResearchArtifactRef {
  payload: unknown;
  warnings: string[];
  projection?: FinancialStatementProjection | OfficialFilingProjection;
}

export interface CaptureReceipt {
  artifacts: ResearchArtifactRef[];
  inserted: number;
  deduplicated: number;
}

export interface ArtifactSelection {
  subjectIds: string[];
  kinds: ResearchArtifactKind[];
  observationCutoff: string;
  knowledgeCutoff: string;
}

export interface ResearchArtifactSnapshot {
  observationCutoff: string;
  knowledgeCutoff: string;
  artifacts: ResearchArtifact[];
}

export interface PointInTimeResearchArtifactStore {
  capture(batch: CapturedResearchArtifactBatch): Promise<CaptureReceipt>;
  selectAsOf(query: ArtifactSelection): Promise<ResearchArtifactSnapshot>;
}

export class ResearchArtifactStoreError extends Error {
  readonly code: "ARTIFACT_STORE_UNAVAILABLE" | "ARTIFACT_PERSISTENCE_FAILED" | "RESEARCH_ARTIFACT_INTEGRITY_FAILURE";
  readonly retryable: boolean;

  constructor(code: ResearchArtifactStoreError["code"], message: string = code) {
    super(message);
    this.name = "ResearchArtifactStoreError";
    this.code = code;
    this.retryable = code !== "RESEARCH_ARTIFACT_INTEGRITY_FAILURE";
  }
}

interface StoredArtifact extends ResearchArtifact {
  rawPayload: unknown;
}

export class InMemoryPointInTimeResearchArtifactStore implements PointInTimeResearchArtifactStore {
  private readonly byId = new Map<string, StoredArtifact>();
  private readonly now: () => string;

  constructor(input: { now?: () => string } = {}) {
    this.now = input.now ?? (() => new Date().toISOString());
  }

  async capture(batch: CapturedResearchArtifactBatch): Promise<CaptureReceipt> {
    assertBatch(batch);
    let inserted = 0;
    let deduplicated = 0;
    const artifacts: ResearchArtifactRef[] = [];
    for (const candidate of batch.candidates) {
      const prepared = await prepareCandidate(candidate, this.now());
      const existing = this.byId.get(prepared.artifactId);
      if (existing) {
        assertSameArtifact(existing, prepared);
        deduplicated += 1;
        artifacts.push(reference(existing));
        continue;
      }
      this.byId.set(prepared.artifactId, prepared);
      inserted += 1;
      artifacts.push(reference(prepared));
    }
    return { artifacts, inserted, deduplicated };
  }

  async selectAsOf(query: ArtifactSelection): Promise<ResearchArtifactSnapshot> {
    assertSelection(query);
    const selected = new Map<string, StoredArtifact>();
    for (const artifact of this.byId.values()) {
      if (!query.subjectIds.includes(artifact.subjectId) || !query.kinds.includes(artifact.kind)) continue;
      if (Date.parse(artifact.sourceAsOf) > Date.parse(query.observationCutoff)) continue;
      if (Date.parse(artifact.firstObservedAt) > Date.parse(query.knowledgeCutoff)) continue;
      const current = selected.get(`${artifact.kind}:${artifact.logicalKey}`);
      if (!current || compareRevision(artifact, current) > 0) selected.set(`${artifact.kind}:${artifact.logicalKey}`, artifact);
    }
    return {
      observationCutoff: query.observationCutoff,
      knowledgeCutoff: query.knowledgeCutoff,
      artifacts: [...selected.values()].sort(compareArtifact).map(cloneArtifact),
    };
  }
}

interface ArtifactVersionRow {
  artifact_id: string;
  artifact_kind: ResearchArtifactKind;
  schema_version: string;
  subject_id: string;
  logical_key: string;
  provider: string;
  provider_version: string;
  source_as_of: string;
  first_observed_at: string;
  first_retrieved_at: string;
  content_digest: `sha256:${string}`;
  blob_key: string;
  byte_length: number;
  payload_json: string;
  warnings_json: string;
}

export class D1R2PointInTimeResearchArtifactStore implements PointInTimeResearchArtifactStore {
  private readonly db: D1Database;
  private readonly blobs: R2Bucket;
  private readonly now: () => string;
  private readonly rawFinancialCaptureEnabled: boolean;

  constructor(input: { db: D1Database; blobs: R2Bucket; now?: () => string; rawFinancialCaptureEnabled?: boolean }) {
    this.db = input.db;
    this.blobs = input.blobs;
    this.now = input.now ?? (() => new Date().toISOString());
    this.rawFinancialCaptureEnabled = input.rawFinancialCaptureEnabled ?? false;
  }

  async capture(batch: CapturedResearchArtifactBatch): Promise<CaptureReceipt> {
    assertBatch(batch);
    if (!this.rawFinancialCaptureEnabled && batch.candidates.some((candidate) => candidate.kind !== "normalized_daily_history.v1")) {
      throw new ResearchArtifactStoreError("ARTIFACT_STORE_UNAVAILABLE", "Raw financial artifact retention is not authorized");
    }
    const prepared = await Promise.all(batch.candidates.map((candidate) => prepareCandidate(candidate, "")));
    let inserted = 0;
    let deduplicated = 0;
    const resolved: Array<{ artifact: StoredArtifact; observationRetrievedAt: string }> = [];
    const pendingBlobs = new Map<string, { blobKey: string; bytes: Uint8Array }>();

    try {
      for (const artifact of prepared) {
        const existing = await this.db.prepare("SELECT * FROM research_artifact_versions WHERE artifact_id = ?").bind(artifact.artifactId).first<ArtifactVersionRow>();
        if (existing) {
          const restored = await this.restore(existing);
          assertSameArtifact(restored, artifact);
          resolved.push({ artifact: restored, observationRetrievedAt: artifact.retrievedAt });
          deduplicated += 1;
        } else {
          const bytes = new TextEncoder().encode(stableJson(persistedEnvelope(artifact)));
          const blobKey = blobKeyFor(artifact.kind, artifact.contentDigest);
          await this.blobs.put(blobKey, bytes, {
            sha256: digestBytes(artifact.contentDigest),
            httpMetadata: { contentType: "application/json" },
          });
          pendingBlobs.set(artifact.artifactId, { blobKey, bytes });
          resolved.push({ artifact, observationRetrievedAt: artifact.retrievedAt });
          inserted += 1;
        }
      }

      const observedAt = this.now();
      const statements: D1PreparedStatement[] = [];
      for (const { artifact, observationRetrievedAt } of resolved) {
        const pending = pendingBlobs.get(artifact.artifactId);
        if (pending) {
          artifact.firstObservedAt = observedAt;
          statements.push(this.db.prepare(`INSERT INTO research_artifact_versions (
            artifact_id, artifact_kind, schema_version, subject_id, logical_key, provider, provider_version,
            source_as_of, first_observed_at, first_retrieved_at, content_digest, blob_key, byte_length, payload_json, warnings_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
            artifact.artifactId,
            artifact.kind,
            artifact.kind,
            artifact.subjectId,
            artifact.logicalKey,
            artifact.provider,
            artifact.providerVersion,
            artifact.sourceAsOf,
            artifact.firstObservedAt,
            artifact.retrievedAt,
            artifact.contentDigest,
            pending.blobKey,
            pending.bytes.byteLength,
            stableJson({ payload: artifact.payload, ...(artifact.projection ? { projection: artifact.projection } : {}) }),
            stableJson(artifact.warnings),
          ));
          statements.push(...projectionStatements(this.db, artifact));
        }
        statements.push(this.db.prepare("INSERT INTO research_artifact_observations (observation_id, artifact_id, observed_at, provider_retrieved_at) VALUES (?, ?, ?, ?)")
          .bind(crypto.randomUUID(), artifact.artifactId, observedAt, observationRetrievedAt));
      }

      const byLogicalKey = new Map(resolved.map(({ artifact }) => [artifact.logicalKey, artifact] as const));
      for (const relation of batch.relations ?? []) {
        const from = byLogicalKey.get(relation.fromLogicalKey);
        const to = byLogicalKey.get(relation.toLogicalKey);
        if (!from || !to) throw new Error("INVALID_ARTIFACT_RELATION");
        statements.push(this.db.prepare("INSERT OR IGNORE INTO research_artifact_relations (from_artifact_id, relation_type, to_artifact_id, created_at) VALUES (?, ?, ?, ?)")
          .bind(from.artifactId, relation.relation, to.artifactId, observedAt));
      }
      if (statements.length) await this.db.batch(statements);
    } catch (error) {
      if (error instanceof ResearchArtifactStoreError) throw error;
      throw new ResearchArtifactStoreError("ARTIFACT_PERSISTENCE_FAILED");
    }

    const artifacts: ResearchArtifactRef[] = [];
    for (const { artifact } of resolved) {
      const row = await this.db.prepare("SELECT * FROM research_artifact_versions WHERE artifact_id = ?").bind(artifact.artifactId).first<ArtifactVersionRow>();
      if (!row) throw new ResearchArtifactStoreError("ARTIFACT_PERSISTENCE_FAILED");
      const restored = await this.restore(row);
      assertSameArtifact(restored, artifact);
      artifacts.push(reference(restored));
    }
    return { artifacts, inserted, deduplicated };
  }

  async selectAsOf(query: ArtifactSelection): Promise<ResearchArtifactSnapshot> {
    assertSelection(query);
    const subjectPlaceholders = query.subjectIds.map(() => "?").join(", ");
    const kindPlaceholders = query.kinds.map(() => "?").join(", ");
    let rows: ArtifactVersionRow[];
    try {
      const loaded = await this.db.prepare(`SELECT * FROM (
        SELECT research_artifact_versions.*,
          ROW_NUMBER() OVER (
            PARTITION BY artifact_kind, logical_key
            ORDER BY source_as_of DESC, first_observed_at DESC, artifact_id DESC
          ) AS revision_rank
        FROM research_artifact_versions
        WHERE subject_id IN (${subjectPlaceholders})
          AND artifact_kind IN (${kindPlaceholders})
          AND source_as_of <= ?
          AND first_observed_at <= ?
      ) WHERE revision_rank = 1
        ORDER BY subject_id, artifact_kind, logical_key`).bind(...query.subjectIds, ...query.kinds, query.observationCutoff, query.knowledgeCutoff).all<ArtifactVersionRow>();
      rows = loaded.results;
    } catch {
      throw new ResearchArtifactStoreError("ARTIFACT_STORE_UNAVAILABLE");
    }
    const selected = new Map<string, ArtifactVersionRow>();
    for (const row of rows) {
      const key = `${row.artifact_kind}:${row.logical_key}`;
      if (!selected.has(key)) selected.set(key, row);
    }
    const artifacts: ResearchArtifact[] = [];
    for (const row of selected.values()) artifacts.push(cloneArtifact(await this.restore(row)));
    artifacts.sort(compareArtifact);
    return { observationCutoff: query.observationCutoff, knowledgeCutoff: query.knowledgeCutoff, artifacts };
  }

  private async restore(row: ArtifactVersionRow): Promise<StoredArtifact> {
    if (row.schema_version !== row.artifact_kind || !ARTIFACT_KINDS.includes(row.artifact_kind) || blobKeyFor(row.artifact_kind, row.content_digest) !== row.blob_key) {
      throw new ResearchArtifactStoreError("RESEARCH_ARTIFACT_INTEGRITY_FAILURE");
    }
    let object: R2ObjectBody | null;
    try { object = await this.blobs.get(row.blob_key); }
    catch { throw new ResearchArtifactStoreError("ARTIFACT_STORE_UNAVAILABLE"); }
    if (!object) throw new ResearchArtifactStoreError("RESEARCH_ARTIFACT_INTEGRITY_FAILURE");
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.byteLength !== row.byte_length) throw new ResearchArtifactStoreError("RESEARCH_ARTIFACT_INTEGRITY_FAILURE");
    const text = new TextDecoder().decode(bytes);
    if (await sha256(text) !== row.content_digest) throw new ResearchArtifactStoreError("RESEARCH_ARTIFACT_INTEGRITY_FAILURE");
    let envelope: ReturnType<typeof persistedEnvelope>;
    let projection: unknown;
    try {
      envelope = JSON.parse(text) as ReturnType<typeof persistedEnvelope>;
      projection = JSON.parse(row.payload_json) as { payload?: unknown; projection?: unknown };
    } catch {
      throw new ResearchArtifactStoreError("RESEARCH_ARTIFACT_INTEGRITY_FAILURE");
    }
    if (!envelope
      || !ARTIFACT_KINDS.includes(envelope.schemaVersion)
      || typeof envelope.subjectId !== "string"
      || artifactIdFor(envelope.schemaVersion, envelope.subjectId, row.content_digest) !== row.artifact_id) {
      throw new ResearchArtifactStoreError("RESEARCH_ARTIFACT_INTEGRITY_FAILURE");
    }
    const restored: StoredArtifact = {
      artifactId: row.artifact_id,
      kind: row.artifact_kind,
      subjectId: row.subject_id,
      logicalKey: row.logical_key,
      provider: row.provider,
      providerVersion: row.provider_version,
      sourceAsOf: row.source_as_of,
      firstObservedAt: row.first_observed_at,
      retrievedAt: row.first_retrieved_at,
      contentDigest: row.content_digest,
      payload: (projection as { payload?: unknown }).payload,
      rawPayload: envelope.rawPayload,
      warnings: parseWarnings(row.warnings_json),
      ...((projection as { projection?: FinancialStatementProjection | OfficialFilingProjection }).projection
        ? { projection: (projection as { projection: FinancialStatementProjection | OfficialFilingProjection }).projection }
        : {}),
    };
    if (stableJson(persistedEnvelope(restored)) !== text) throw new ResearchArtifactStoreError("RESEARCH_ARTIFACT_INTEGRITY_FAILURE");
    return restored;
  }
}

export class UnavailablePointInTimeResearchArtifactStore implements PointInTimeResearchArtifactStore {
  async capture(): Promise<CaptureReceipt> { throw new ResearchArtifactStoreError("ARTIFACT_STORE_UNAVAILABLE"); }
  async selectAsOf(): Promise<ResearchArtifactSnapshot> { throw new ResearchArtifactStoreError("ARTIFACT_STORE_UNAVAILABLE"); }
}

function projectionStatements(db: D1Database, artifact: StoredArtifact): D1PreparedStatement[] {
  const projection = artifact.projection;
  if (!projection) return [];
  if ("statementType" in projection) return projection.cells.map((cell) => db.prepare(`INSERT INTO financial_statement_cells (
    artifact_id, statement_type, report_period_start, report_period_end, period_basis,
    report_type_code, data_state, metric_id, value_decimal, unit
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    artifact.artifactId,
    projection.statementType,
    projection.reportPeriod.start,
    projection.reportPeriod.end,
    projection.reportPeriod.basis,
    projection.reportTypeCode,
    projection.dataState,
    cell.metric,
    cell.value,
    cell.unit,
  ));
  return [db.prepare(`INSERT INTO official_filing_versions (
    artifact_id, filing_id, report_period_end, report_type, title, published_at, filing_url
  ) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(
    artifact.artifactId,
    projection.filingId,
    projection.reportPeriodEnd,
    projection.reportType,
    projection.title,
    projection.publishedAt,
    projection.url,
  )];
}

function persistedEnvelope(artifact: Pick<StoredArtifact, "kind" | "subjectId" | "logicalKey" | "provider" | "providerVersion" | "sourceAsOf" | "payload" | "rawPayload" | "projection">) {
  return {
    schemaVersion: artifact.kind,
    subjectId: artifact.subjectId,
    logicalKey: artifact.logicalKey,
    provider: artifact.provider,
    providerVersion: artifact.providerVersion,
    sourceAsOf: artifact.sourceAsOf,
    payload: artifact.payload,
    rawPayload: artifact.rawPayload,
    ...(artifact.projection ? { projection: artifact.projection } : {}),
  };
}

function blobKeyFor(kind: ResearchArtifactKind, digest: `sha256:${string}`): string {
  return `research-artifacts/v1/${kind}/${digest.slice("sha256:".length)}.json`;
}

function digestBytes(digest: `sha256:${string}`): ArrayBuffer {
  const hex = digest.slice("sha256:".length);
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes.buffer;
}

function parseWarnings(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((warning) => typeof warning !== "string")) throw new Error("invalid");
    return parsed;
  } catch {
    throw new ResearchArtifactStoreError("RESEARCH_ARTIFACT_INTEGRITY_FAILURE");
  }
}

function assertBatch(batch: CapturedResearchArtifactBatch): void {
  if (!batch || !Array.isArray(batch.candidates) || !batch.candidates.length || batch.candidates.length > 100) throw new Error("INVALID_ARTIFACT_BATCH");
  const keys = new Set<string>();
  for (const candidate of batch.candidates) {
    if (!candidate || !ARTIFACT_KINDS.includes(candidate.kind) || !/^(SSE|SZSE):\d{6}$/.test(candidate.subjectId)) throw new Error("INVALID_ARTIFACT_CANDIDATE");
    if (!candidate.logicalKey || !candidate.provider || !candidate.providerVersion || !isIso(candidate.sourceAsOf) || !isIso(candidate.retrievedAt)) throw new Error("INVALID_ARTIFACT_PROVENANCE");
    if (Date.parse(candidate.sourceAsOf) > Date.parse(candidate.retrievedAt)) throw new Error("INVALID_ARTIFACT_TIME_ORDER");
    if (candidate.warnings?.some((warning) => typeof warning !== "string")) throw new Error("INVALID_ARTIFACT_WARNINGS");
    if (keys.has(candidate.logicalKey)) throw new Error("DUPLICATE_ARTIFACT_LOGICAL_KEY");
    keys.add(candidate.logicalKey);
  }
  for (const relation of batch.relations ?? []) {
    if (!keys.has(relation.fromLogicalKey) || !keys.has(relation.toLogicalKey)) throw new Error("INVALID_ARTIFACT_RELATION");
  }
}

function assertSelection(query: ArtifactSelection): void {
  if (!query || !query.subjectIds.length || !query.kinds.length || !isIso(query.observationCutoff) || !isIso(query.knowledgeCutoff)) throw new Error("INVALID_ARTIFACT_SELECTION");
  if (query.subjectIds.some((id) => !/^(SSE|SZSE):\d{6}$/.test(id)) || query.kinds.some((kind) => !ARTIFACT_KINDS.includes(kind))) throw new Error("INVALID_ARTIFACT_SELECTION");
}

const ARTIFACT_KINDS: ResearchArtifactKind[] = ["normalized_daily_history.v1", "financial_statement.v1", "official_filing_identity.v1"];

async function prepareCandidate(candidate: ResearchArtifactCandidate, firstObservedAt: string): Promise<StoredArtifact> {
  const canonical = {
    schemaVersion: candidate.kind,
    subjectId: candidate.subjectId,
    logicalKey: candidate.logicalKey,
    provider: candidate.provider,
    providerVersion: candidate.providerVersion,
    sourceAsOf: candidate.sourceAsOf,
    payload: candidate.payload,
    rawPayload: candidate.rawPayload,
    ...(candidate.projection ? { projection: candidate.projection } : {}),
  };
  const contentDigest = await sha256(stableJson(canonical));
  const artifactId = artifactIdFor(candidate.kind, candidate.subjectId, contentDigest);
  return {
    artifactId,
    kind: candidate.kind,
    subjectId: candidate.subjectId,
    logicalKey: candidate.logicalKey,
    sourceAsOf: candidate.sourceAsOf,
    firstObservedAt,
    contentDigest,
    provider: candidate.provider,
    providerVersion: candidate.providerVersion,
    retrievedAt: candidate.retrievedAt,
    payload: structuredClone(candidate.payload),
    rawPayload: structuredClone(candidate.rawPayload),
    warnings: [...new Set(candidate.warnings ?? [])].sort(),
    ...(candidate.projection ? { projection: structuredClone(candidate.projection) } : {}),
  };
}

function artifactIdFor(kind: ResearchArtifactKind, subjectId: string, contentDigest: `sha256:${string}`): string {
  return kind === "normalized_daily_history.v1"
    ? `daily-bars:${subjectId}:${contentDigest}`
    : `research-artifact:${kind}:${contentDigest}`;
}

function assertSameArtifact(existing: StoredArtifact, candidate: StoredArtifact): void {
  if (existing.contentDigest !== candidate.contentDigest
    || existing.kind !== candidate.kind
    || existing.subjectId !== candidate.subjectId
    || existing.logicalKey !== candidate.logicalKey
    || stableJson(existing.payload) !== stableJson(candidate.payload)
    || stableJson(existing.rawPayload) !== stableJson(candidate.rawPayload)) {
    throw new ResearchArtifactStoreError("RESEARCH_ARTIFACT_INTEGRITY_FAILURE");
  }
}

function reference(artifact: StoredArtifact): ResearchArtifactRef {
  const { payload: _payload, warnings: _warnings, projection: _projection, rawPayload: _rawPayload, ...ref } = artifact;
  return { ...ref };
}

function cloneArtifact(artifact: StoredArtifact): ResearchArtifact {
  const { rawPayload: _rawPayload, ...visible } = artifact;
  return structuredClone(visible);
}

function compareRevision(left: StoredArtifact, right: StoredArtifact): number {
  return left.sourceAsOf.localeCompare(right.sourceAsOf)
    || left.firstObservedAt.localeCompare(right.firstObservedAt)
    || left.artifactId.localeCompare(right.artifactId);
}

function compareArtifact(left: Pick<ResearchArtifactRef, "subjectId" | "kind" | "logicalKey">, right: Pick<ResearchArtifactRef, "subjectId" | "kind" | "logicalKey">): number {
  return left.subjectId.localeCompare(right.subjectId) || left.kind.localeCompare(right.kind) || left.logicalKey.localeCompare(right.logicalKey);
}

function isIso(value: string): boolean { return typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value; }

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

async function sha256(value: string): Promise<`sha256:${string}`> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
