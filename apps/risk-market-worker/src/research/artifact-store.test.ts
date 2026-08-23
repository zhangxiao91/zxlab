import assert from "node:assert/strict";
import test from "node:test";
import {
  D1R2PointInTimeResearchArtifactStore,
  InMemoryPointInTimeResearchArtifactStore,
  type ResearchArtifactCandidate,
} from "./artifact-store.ts";

const subjectId = "SSE:600000";

function financialCandidate(value: string, retrievedAt: string): ResearchArtifactCandidate {
  return {
    kind: "financial_statement.v1",
    subjectId,
    logicalKey: `${subjectId}:income:2026-06-30:year_to_date`,
    provider: "eastmoney-financials",
    providerVersion: "eastmoney-financials.v1",
    sourceAsOf: "2026-08-20T10:00:00.000Z",
    retrievedAt,
    payload: {
      statementType: "income",
      reportPeriod: { start: "2026-01-01T00:00:00.000Z", end: "2026-06-30T00:00:00.000Z", basis: "year_to_date" },
      cells: [{ metric: "operating_revenue", value }],
    },
    rawPayload: { data: [{ REPORT_DATE: "2026-06-30", NOTICE_DATE: "2026-08-20", TOTAL_OPERATE_INCOME: value }] },
  };
}

function dailyCandidate(provider: string, rawMarker: string): ResearchArtifactCandidate {
  return {
    kind: "normalized_daily_history.v1",
    subjectId,
    logicalKey: `${subjectId}:normalized-daily-history:qfq`,
    provider,
    providerVersion: "daily-history.v1",
    sourceAsOf: "2026-08-20T07:00:00.000Z",
    retrievedAt: "2026-08-20T07:01:00.000Z",
    payload: { bars: [{ sessionDate: "2026-08-20", close: "10", volume: "100" }] },
    rawPayload: { marker: rawMarker },
  };
}

type StoredRow = {
  artifact_id: string;
  artifact_kind: string;
  schema_version: string;
  subject_id: string;
  logical_key: string;
  provider: string;
  provider_version: string;
  source_as_of: string;
  first_observed_at: string;
  first_retrieved_at: string;
  content_digest: string;
  blob_key: string;
  byte_length: number;
  payload_json: string;
  warnings_json: string;
};

class FakeD1Statement {
  readonly query: string;
  readonly values: unknown[];
  private readonly database: FakeArtifactD1;

  constructor(database: FakeArtifactD1, query: string, values: unknown[] = []) {
    this.database = database;
    this.query = query;
    this.values = values;
  }

  bind(...values: unknown[]): D1PreparedStatement {
    return new FakeD1Statement(this.database, this.query, values) as unknown as D1PreparedStatement;
  }

  async first<T>(): Promise<T | null> {
    return this.database.first(this.query, this.values) as T | null;
  }

  async all<T>(): Promise<D1Result<T>> {
    return { results: this.database.all(this.query, this.values) as T[] } as D1Result<T>;
  }
}

class FakeArtifactD1 {
  private rows = new Map<string, StoredRow>();
  private observationRetrievedTimes: string[] = [];
  failNextBatch = false;
  dropNextBatchWrites = false;

  asBinding(): D1Database { return this as unknown as D1Database; }

  prepare(query: string): D1PreparedStatement {
    return new FakeD1Statement(this, query) as unknown as D1PreparedStatement;
  }

  async batch(statements: D1PreparedStatement[]): Promise<D1Result<unknown>[]> {
    if (this.failNextBatch) {
      this.failNextBatch = false;
      throw new Error("D1_BATCH_FAILED");
    }
    if (this.dropNextBatchWrites) {
      this.dropNextBatchWrites = false;
      return statements.map(() => ({ success: true } as D1Result<unknown>));
    }
    const next = new Map(this.rows);
    const nextObservationRetrievedTimes = [...this.observationRetrievedTimes];
    for (const statement of statements) this.apply(next, nextObservationRetrievedTimes, statement as unknown as FakeD1Statement);
    this.rows = next;
    this.observationRetrievedTimes = nextObservationRetrievedTimes;
    return statements.map(() => ({ success: true } as D1Result<unknown>));
  }

  first(query: string, values: unknown[]): StoredRow | null {
    if (!query.includes("WHERE artifact_id = ?")) throw new Error(`Unsupported first query: ${query}`);
    return this.rows.get(String(values[0])) ?? null;
  }

  all(query: string, values: unknown[]): StoredRow[] {
    if (!query.includes("FROM research_artifact_versions")) throw new Error(`Unsupported all query: ${query}`);
    const subjectCount = placeholderCount(query, "subject_id");
    const kindCount = placeholderCount(query, "artifact_kind");
    const subjects = new Set(values.slice(0, subjectCount).map(String));
    const kinds = new Set(values.slice(subjectCount, subjectCount + kindCount).map(String));
    const observationCutoff = String(values[subjectCount + kindCount]);
    const knowledgeCutoff = String(values[subjectCount + kindCount + 1]);
    const rows = [...this.rows.values()]
      .filter((row) => subjects.has(row.subject_id)
        && kinds.has(row.artifact_kind)
        && row.source_as_of <= observationCutoff
        && row.first_observed_at <= knowledgeCutoff)
      .sort((left, right) => right.source_as_of.localeCompare(left.source_as_of)
        || right.first_observed_at.localeCompare(left.first_observed_at)
        || right.artifact_id.localeCompare(left.artifact_id));
    return query.includes("LIMIT 1000") ? rows.slice(0, 1_000) : rows;
  }

  tamperArtifactId(value: string): void {
    const row = this.onlyRow();
    row.artifact_id = value;
  }

  providerRetrievalTimes(): string[] { return [...this.observationRetrievedTimes]; }

  private onlyRow(): StoredRow {
    assert.equal(this.rows.size, 1);
    return [...this.rows.values()][0];
  }

  private apply(rows: Map<string, StoredRow>, observationRetrievedTimes: string[], statement: FakeD1Statement): void {
    if (statement.query.includes("INSERT INTO research_artifact_versions")) {
      const value = statement.values;
      const row: StoredRow = {
        artifact_id: String(value[0]),
        artifact_kind: String(value[1]),
        schema_version: String(value[2]),
        subject_id: String(value[3]),
        logical_key: String(value[4]),
        provider: String(value[5]),
        provider_version: String(value[6]),
        source_as_of: String(value[7]),
        first_observed_at: String(value[8]),
        first_retrieved_at: String(value[9]),
        content_digest: String(value[10]),
        blob_key: String(value[11]),
        byte_length: Number(value[12]),
        payload_json: String(value[13]),
        warnings_json: String(value[14]),
      };
      rows.set(row.artifact_id, row);
    }
    if (statement.query.includes("INSERT INTO research_artifact_observations")) observationRetrievedTimes.push(String(statement.values[3]));
  }
}

class FakeArtifactR2 {
  private readonly objects = new Map<string, Uint8Array>();
  private readonly afterPut?: () => void;

  constructor(afterPut?: () => void) { this.afterPut = afterPut; }

  asBinding(): R2Bucket { return this as unknown as R2Bucket; }

  async put(key: string, value: Uint8Array): Promise<R2Object> {
    this.objects.set(key, value.slice());
    this.afterPut?.();
    return {} as R2Object;
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const stored = this.objects.get(key);
    if (!stored) return null;
    return {
      async arrayBuffer() { return stored.slice().buffer as ArrayBuffer; },
    } as R2ObjectBody;
  }

  removeOnlyObject(): void {
    assert.equal(this.objects.size, 1);
    this.objects.clear();
  }

  tamperOnlyObject(): void {
    assert.equal(this.objects.size, 1);
    const [key, value] = [...this.objects.entries()][0];
    const changed = value.slice();
    changed[0] ^= 1;
    this.objects.set(key, changed);
  }
}

function placeholderCount(query: string, field: string): number {
  const match = new RegExp(`${field} IN \\(([^)]*)\\)`).exec(query);
  if (!match) throw new Error(`Missing ${field} placeholders`);
  return match[1].split(",").length;
}

function d1R2Store(input: { database?: FakeArtifactD1; blobs?: FakeArtifactR2; now?: () => string } = {}) {
  const database = input.database ?? new FakeArtifactD1();
  const blobs = input.blobs ?? new FakeArtifactR2();
  return {
    database,
    blobs,
    store: new D1R2PointInTimeResearchArtifactStore({
      db: database.asBinding(),
      blobs: blobs.asBinding(),
      now: input.now ?? (() => "2026-08-20T10:05:00.000Z"),
      rawFinancialCaptureEnabled: true,
    }),
  };
}

const selection = {
  subjectIds: [subjectId],
  kinds: ["financial_statement.v1" as const],
  observationCutoff: "2026-08-20T23:59:59.999Z",
  knowledgeCutoff: "2026-08-20T23:59:59.999Z",
};

function hasStoreError(code: string) {
  return (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

test("daily artifacts use the complete canonical observation for their content address", async () => {
  const store = new InMemoryPointInTimeResearchArtifactStore({ now: () => "2026-08-20T07:02:00.000Z" });

  const first = await store.capture({ candidates: [dailyCandidate("provider-a", "first")] });
  const second = await store.capture({ candidates: [dailyCandidate("provider-b", "second")] });

  assert.notEqual(first.artifacts[0].contentDigest, second.artifacts[0].contentDigest);
  assert.notEqual(first.artifacts[0].artifactId, second.artifacts[0].artifactId);
});

test("artifact store selects revisions only when source and first observation are within both cutoffs", async () => {
  const observed = ["2026-08-20T10:05:00.000Z", "2026-08-21T09:05:00.000Z"];
  const store = new InMemoryPointInTimeResearchArtifactStore({ now: () => observed.shift()! });

  const first = await store.capture({ candidates: [financialCandidate("100", "2026-08-20T10:04:00.000Z")] });
  const second = await store.capture({ candidates: [financialCandidate("110", "2026-08-21T09:04:00.000Z")] });

  assert.notEqual(first.artifacts[0].artifactId, second.artifacts[0].artifactId);
  const historical = await store.selectAsOf({
    subjectIds: [subjectId],
    kinds: ["financial_statement.v1"],
    observationCutoff: "2026-08-20T23:59:59.999Z",
    knowledgeCutoff: "2026-08-20T23:59:59.999Z",
  });
  assert.equal(historical.artifacts.length, 1);
  assert.deepEqual(historical.artifacts[0].payload, financialCandidate("100", "ignored").payload);

  const current = await store.selectAsOf({
    subjectIds: [subjectId],
    kinds: ["financial_statement.v1"],
    observationCutoff: "2026-08-21T23:59:59.999Z",
    knowledgeCutoff: "2026-08-21T23:59:59.999Z",
  });
  assert.equal(current.artifacts.length, 1);
  assert.deepEqual(current.artifacts[0].payload, financialCandidate("110", "ignored").payload);
});

test("artifact store deduplicates identical content without moving firstObservedAt", async () => {
  const observed = ["2026-08-20T10:05:00.000Z", "2026-08-22T10:05:00.000Z"];
  const store = new InMemoryPointInTimeResearchArtifactStore({ now: () => observed.shift()! });
  const candidate = financialCandidate("100", "2026-08-20T10:04:00.000Z");

  const first = await store.capture({ candidates: [candidate] });
  const second = await store.capture({ candidates: [{ ...candidate, retrievedAt: "2026-08-22T10:04:00.000Z" }] });

  assert.equal(first.artifacts[0].artifactId, second.artifacts[0].artifactId);
  assert.equal(first.artifacts[0].firstObservedAt, "2026-08-20T10:05:00.000Z");
  assert.equal(second.artifacts[0].firstObservedAt, first.artifacts[0].firstObservedAt);
  assert.equal(second.deduplicated, 1);
});

test("adding a later observation cannot change an earlier point-in-time snapshot", async () => {
  const observed = ["2026-08-20T10:05:00.000Z", "2026-08-23T10:05:00.000Z"];
  const store = new InMemoryPointInTimeResearchArtifactStore({ now: () => observed.shift()! });
  await store.capture({ candidates: [financialCandidate("100", "2026-08-20T10:04:00.000Z")] });
  const query = {
    subjectIds: [subjectId],
    kinds: ["financial_statement.v1" as const],
    observationCutoff: "2026-08-20T23:59:59.999Z",
    knowledgeCutoff: "2026-08-20T23:59:59.999Z",
  };
  const before = await store.selectAsOf(query);
  await store.capture({ candidates: [financialCandidate("120", "2026-08-23T10:04:00.000Z")] });
  const after = await store.selectAsOf(query);
  assert.deepEqual(after, before);
});

test("D1/R2 adapter rejects financial raw capture before storage when retention is not authorized", async () => {
  const store = new D1R2PointInTimeResearchArtifactStore({ db: {} as D1Database, blobs: {} as R2Bucket });
  await assert.rejects(
    store.capture({ candidates: [financialCandidate("100", "2026-08-20T10:04:00.000Z")] }),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "ARTIFACT_STORE_UNAVAILABLE"),
  );
});

test("D1/R2 capture assigns First Observed At only after the blob is durable", async () => {
  let blobIsDurable = false;
  const blobs = new FakeArtifactR2(() => { blobIsDurable = true; });
  const { store } = d1R2Store({
    blobs,
    now: () => blobIsDurable ? "2026-08-20T10:05:01.000Z" : "2026-08-20T10:05:00.000Z",
  });

  const receipt = await store.capture({ candidates: [financialCandidate("100", "2026-08-20T10:04:00.000Z")] });

  assert.equal(receipt.artifacts[0].firstObservedAt, "2026-08-20T10:05:01.000Z");
});

test("D1/R2 dedupe appends an observation with the current provider retrieval time", async () => {
  const { store, database } = d1R2Store();
  await store.capture({ candidates: [financialCandidate("100", "2026-08-20T10:04:00.000Z")] });
  await store.capture({ candidates: [financialCandidate("100", "2026-08-22T10:04:00.000Z")] });

  assert.deepEqual(database.providerRetrievalTimes(), [
    "2026-08-20T10:04:00.000Z",
    "2026-08-22T10:04:00.000Z",
  ]);
});

test("D1/R2 capture leaves an R2 orphan invisible when the D1 transaction fails", async () => {
  const { store, database } = d1R2Store();
  database.failNextBatch = true;

  await assert.rejects(
    store.capture({ candidates: [financialCandidate("100", "2026-08-20T10:04:00.000Z")] }),
    hasStoreError("ARTIFACT_PERSISTENCE_FAILED"),
  );
  assert.deepEqual((await store.selectAsOf(selection)).artifacts, []);
});

test("D1/R2 capture does not acknowledge a row that is absent on read-after-write", async () => {
  const { store, database } = d1R2Store();
  database.dropNextBatchWrites = true;

  await assert.rejects(
    store.capture({ candidates: [financialCandidate("100", "2026-08-20T10:04:00.000Z")] }),
    hasStoreError("ARTIFACT_PERSISTENCE_FAILED"),
  );
  assert.deepEqual((await store.selectAsOf(selection)).artifacts, []);
});

test("D1/R2 selection fails closed when the blob is missing", async () => {
  const { store, blobs } = d1R2Store();
  await store.capture({ candidates: [financialCandidate("100", "2026-08-20T10:04:00.000Z")] });
  blobs.removeOnlyObject();

  await assert.rejects(store.selectAsOf(selection), hasStoreError("RESEARCH_ARTIFACT_INTEGRITY_FAILURE"));
});

test("D1/R2 selection fails closed when the blob content is tampered", async () => {
  const { store, blobs } = d1R2Store();
  await store.capture({ candidates: [financialCandidate("100", "2026-08-20T10:04:00.000Z")] });
  blobs.tamperOnlyObject();

  await assert.rejects(store.selectAsOf(selection), hasStoreError("RESEARCH_ARTIFACT_INTEGRITY_FAILURE"));
});

test("D1/R2 selection recomputes the content address and rejects a tampered D1 artifact ID", async () => {
  const { store, database } = d1R2Store();
  await store.capture({ candidates: [financialCandidate("100", "2026-08-20T10:04:00.000Z")] });
  database.tamperArtifactId("research-artifact:financial_statement.v1:sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");

  await assert.rejects(store.selectAsOf(selection), hasStoreError("RESEARCH_ARTIFACT_INTEGRITY_FAILURE"));
});

test("D1/R2 selection returns every legal logical key beyond one thousand revisions", async () => {
  const { store } = d1R2Store();
  for (let offset = 0; offset < 1_001; offset += 100) {
    const candidates = Array.from({ length: Math.min(100, 1_001 - offset) }, (_, index) => {
      const revision = offset + index;
      return {
        ...financialCandidate(String(revision), "2026-08-20T10:04:00.000Z"),
        logicalKey: `${subjectId}:income:2026-06-30:year_to_date:${revision}`,
      };
    });
    await store.capture({ candidates });
  }

  assert.equal((await store.selectAsOf(selection)).artifacts.length, 1_001);
});
