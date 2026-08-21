import assert from "node:assert/strict";
import test from "node:test";
import { calculateResearchFactBundleFingerprint } from "@zxlab/research-fact-schema";
import { researchFactBundleFixture } from "@zxlab/research-fact-schema/fixtures";
import { ResearchFactAdapter, ResearchFactError, selectResearchInstrumentScope } from "./research-fact-reader.ts";

test("research scope remains bounded while retaining the selected instrument", () => {
  const instrumentIds = Array.from({ length: 25 }, (_, index) => `SSE:${String(600000 + index).padStart(6, "0")}`);
  const result = selectResearchInstrumentScope(instrumentIds, instrumentIds[24]);

  assert.equal(result.instrumentIds.length, 20);
  assert.ok(result.instrumentIds.includes(instrumentIds[24]));
  assert.deepEqual(result.omittedInstrumentIds.length, 5);
});

test("research adapter sends one server-owned plan and validates the returned bundle", async () => {
  const bundle = researchFactBundleFixture();
  bundle.fingerprint = await calculateResearchFactBundleFingerprint(bundle);
  let captured: Request | undefined;
  const adapter = new ResearchFactAdapter({
    baseUrl: "https://market.example",
    token: "service-token",
    service: {
      async fetch(request: Request) {
        captured = request;
        return Response.json({ data: bundle });
      },
    } as unknown as Fetcher,
  });

  const result = await adapter.materialize({
    purpose: "relative_performance",
    instrumentIds: ["SSE:600000"],
    selectedInstrumentId: "SSE:600000",
    observationCutoff: "2026-08-14T07:00:00.000Z",
  });

  assert.equal(captured?.method, "POST");
  assert.equal(new URL(captured!.url).pathname, "/api/market/research/facts");
  assert.equal(captured?.headers.get("authorization"), "Bearer service-token");
  assert.deepEqual(await captured?.json(), {
    purpose: "relative_performance",
    instrumentIds: ["SSE:600000"],
    selectedInstrumentId: "SSE:600000",
    observationCutoff: "2026-08-14T07:00:00.000Z",
  });
  assert.equal(result.fingerprint, bundle.fingerprint);
});

test("research adapter binds the response to the request-authoritative expected session", async () => {
  const legacyBundle = researchFactBundleFixture();
  legacyBundle.fingerprint = await calculateResearchFactBundleFingerprint(legacyBundle);
  const adapter = new ResearchFactAdapter({
    token: "service-token",
    service: { fetch: async () => Response.json({ data: legacyBundle }) } as unknown as Fetcher,
  });

  await assert.rejects(
    adapter.materialize({
      purpose: "relative_performance",
      instrumentIds: ["SSE:600000"],
      observationCutoff: "2026-08-14T07:00:00.000Z",
      expectedLatestSessionDate: "2026-08-14",
    }),
    (error: unknown) => error instanceof ResearchFactError
      && error.code === "RESEARCH_FACT_SCOPE_MISMATCH"
      && error.retryable === false,
  );
});

test("research adapter rejects missing identity as a non-retryable safe configuration error", async () => {
  const adapter = new ResearchFactAdapter({ baseUrl: "https://market.example" });
  await assert.rejects(
    adapter.materialize({ purpose: "price_context", instrumentIds: ["SSE:600000"], observationCutoff: "2026-08-14T07:00:00.000Z" }),
    (error: unknown) => error instanceof ResearchFactError
      && error.code === "RESEARCH_FACT_CONFIGURATION_MISSING"
      && error.retryable === false
      && error.message === error.code,
  );
});

test("research adapter classifies authentication, throttling, and upstream failures", async () => {
  const cases = [
    { status: 401, code: "RESEARCH_FACT_UNAUTHORIZED", retryable: false },
    { status: 403, code: "RESEARCH_FACT_UNAUTHORIZED", retryable: false },
    { status: 429, code: "RESEARCH_FACT_RATE_LIMITED", retryable: true },
    { status: 500, code: "RESEARCH_FACT_UPSTREAM_UNAVAILABLE", retryable: true },
  ] as const;
  for (const fixture of cases) {
    const adapter = new ResearchFactAdapter({
      token: "service-token",
      service: { fetch: async () => new Response(null, { status: fixture.status }) } as unknown as Fetcher,
    });
    await assert.rejects(
      adapter.materialize({ purpose: "price_context", instrumentIds: ["SSE:600000"], observationCutoff: "2026-08-14T07:00:00.000Z" }),
      (error: unknown) => error instanceof ResearchFactError && error.code === fixture.code && error.retryable === fixture.retryable,
    );
  }
});

test("research adapter preserves only whitelisted non-retryable Risk errors", async () => {
  const cases = [
    { status: 502, body: { error: { code: "RESEARCH_HISTORY_INTEGRITY_FAILURE", message: "safe", retryable: false } }, expectedCode: "RESEARCH_HISTORY_INTEGRITY_FAILURE", retryable: false },
    { status: 400, body: { error: { code: "OBSERVATION_CUTOFF_OUT_OF_RANGE", message: "safe", retryable: false } }, expectedCode: "OBSERVATION_CUTOFF_OUT_OF_RANGE", retryable: false },
    { status: 502, body: { error: { code: "ATTACKER_CONTROLLED", retryable: false } }, expectedCode: "RESEARCH_FACT_UPSTREAM_UNAVAILABLE", retryable: true },
    { status: 502, body: { error: { code: "RESEARCH_HISTORY_INTEGRITY_FAILURE", retryable: true } }, expectedCode: "RESEARCH_FACT_UPSTREAM_UNAVAILABLE", retryable: true },
  ] as const;
  for (const fixture of cases) {
    const adapter = new ResearchFactAdapter({
      token: "service-token",
      service: { fetch: async () => Response.json(fixture.body, { status: fixture.status }) } as unknown as Fetcher,
    });
    await assert.rejects(
      adapter.materialize({ purpose: "price_context", instrumentIds: ["SSE:600000"], observationCutoff: "2026-08-14T07:00:00.000Z" }),
      (error: unknown) => error instanceof ResearchFactError && error.code === fixture.expectedCode && error.retryable === fixture.retryable,
    );
  }
});

test("research adapter classifies schema, integrity, and scope mismatches as non-retryable", async () => {
  const request = { purpose: "relative_performance" as const, instrumentIds: ["SSE:600000"], observationCutoff: "2026-08-14T07:00:00.000Z" };
  const invalidIntegrity = researchFactBundleFixture();
  const wrongScope = researchFactBundleFixture();
  wrongScope.purpose = "price_context";
  wrongScope.planVersion = "price-context.v1";
  wrongScope.fingerprint = await calculateResearchFactBundleFingerprint(wrongScope);
  const cases = [
    { data: {}, code: "RESEARCH_FACT_SCHEMA_MISMATCH" },
    { data: invalidIntegrity, code: "RESEARCH_FACT_INTEGRITY_MISMATCH" },
    { data: wrongScope, code: "RESEARCH_FACT_SCOPE_MISMATCH" },
  ];
  for (const fixture of cases) {
    const adapter = new ResearchFactAdapter({
      token: "service-token",
      service: { fetch: async () => Response.json({ data: fixture.data }) } as unknown as Fetcher,
    });
    await assert.rejects(
      adapter.materialize(request),
      (error: unknown) => error instanceof ResearchFactError && error.code === fixture.code && error.retryable === false,
    );
  }
});

test("research adapter classifies timeout as retryable", async () => {
  const adapter = new ResearchFactAdapter({
    token: "service-token",
    timeoutMs: 5,
    service: {
      fetch(request: Request) {
        return new Promise<Response>((_resolve, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }));
      },
    } as unknown as Fetcher,
  });

  await assert.rejects(
    adapter.materialize({ purpose: "price_context", instrumentIds: ["SSE:600000"], observationCutoff: "2026-08-14T07:00:00.000Z" }),
    (error: unknown) => error instanceof ResearchFactError && error.code === "RESEARCH_FACT_TIMEOUT" && error.retryable === true,
  );
});

test("research adapter keeps unexpected transport failures safe and retryable", async () => {
  const adapter = new ResearchFactAdapter({
    token: "service-token",
    service: { fetch: async () => { throw new Error("sensitive upstream detail"); } } as unknown as Fetcher,
  });

  await assert.rejects(
    adapter.materialize({ purpose: "price_context", instrumentIds: ["SSE:600000"], observationCutoff: "2026-08-14T07:00:00.000Z" }),
    (error: unknown) => error instanceof ResearchFactError
      && error.code === "RESEARCH_FACT_TRANSPORT_FAILED"
      && error.retryable === true
      && error.message === error.code,
  );
});
