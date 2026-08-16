import assert from "node:assert/strict";
import test from "node:test";
import { researchFactBundleFixture } from "./fixtures.ts";
import {
  calculateResearchFactBundleFingerprint,
  parseResearchFactBundle,
  parseResearchFactRequest,
  validateResearchFactBundle,
  validateResearchFactRequest,
  verifyResearchFactBundleFingerprint,
} from "./index.ts";

test("accepts caller purpose but rejects provider, plan, formula, and fact injection", () => {
  assert.deepEqual(validateResearchFactRequest({
    purpose: "relative_performance",
    instrumentIds: ["SSE:600000"],
    observationCutoff: "2026-08-14T07:00:00.000Z",
  }), { ok: true, issues: [] });
  assert.equal(parseResearchFactRequest({
    purpose: "relative_performance",
    instrumentIds: ["SSE:600000"],
    selectedInstrumentId: "SSE:600000",
    observationCutoff: "2026-08-14T07:00:00.000Z",
  }).selectedInstrumentId, "SSE:600000");

  const result = validateResearchFactRequest({
    purpose: "relative_performance",
    instrumentIds: ["SSE:600000"],
    observationCutoff: "2026-08-14T07:00:00.000Z",
    knowledgeCutoff: "2026-08-14T07:00:00.500Z",
    provider: "caller-chosen",
    plan: "relative-performance.v999",
    formula: "invent a return",
    facts: [],
  });

  assert.equal(result.ok, false);
  assert.match(result.issues.join(" "), /provider is not allowed/);
  assert.match(result.issues.join(" "), /plan is not allowed/);
  assert.match(result.issues.join(" "), /formula is not allowed/);
  assert.match(result.issues.join(" "), /facts is not allowed/);
  assert.match(result.issues.join(" "), /knowledgeCutoff is not allowed/);
});

test("accepts a provenance-bound relative-performance slice with complete 20/60/250 baselines", async () => {
  const bundle = researchFactBundleFixture();
  bundle.fingerprint = await calculateResearchFactBundleFingerprint(bundle);

  const validation = validateResearchFactBundle(bundle);
  assert.deepEqual(validation, { ok: true, issues: [] });
  assert.equal(parseResearchFactBundle(bundle).facts.length, 13);
  assert.equal(await verifyResearchFactBundleFingerprint(bundle), true);

  const baselineFacts = bundle.facts.filter((fact) => fact.kind === "market_baseline");
  assert.deepEqual([...new Set(baselineFacts.map((fact) => fact.window))], [20, 60, 250]);
  assert.deepEqual([...new Set(baselineFacts.map((fact) => fact.baselineType))], [
    "price_return",
    "volume_median",
    "realized_volatility",
    "relative_return",
  ]);
});

test("rejects an operational relative-performance slice with a missing baseline", () => {
  const bundle = researchFactBundleFixture();
  bundle.facts = bundle.facts.filter((fact) => !(
    fact.kind === "market_baseline"
    && fact.baselineType === "realized_volatility"
    && fact.window === 250
  ));
  bundle.capabilities.find((capability) => capability.id === "market_baselines")!.factIds = bundle.facts
    .filter((fact) => fact.kind === "market_baseline")
    .map((fact) => fact.id);

  const result = validateResearchFactBundle(bundle);
  assert.equal(result.ok, false);
  assert.match(result.issues.join(" "), /missing realized_volatility:250/);
});

test("accepts a degraded relative-performance bundle without inventing a missing mapping or baseline", async () => {
  const bundle = researchFactBundleFixture();
  bundle.facts = [];
  bundle.capabilities = [
    { id: "instrument_mapping", required: true, status: "unavailable", factIds: [], asOf: null, retrievedAt: bundle.knowledgeCutoff, warnings: ["BENCHMARK_MAPPING_MISSING"], limitations: [{ code: "BENCHMARK_MAPPING_MISSING", subjectId: "SSE:600000", retryable: false }], error: { code: "BENCHMARK_MAPPING_MISSING", retryable: false } },
    { id: "market_baselines", required: true, status: "unavailable", factIds: [], asOf: null, retrievedAt: bundle.knowledgeCutoff, warnings: ["INSUFFICIENT_SAMPLE"], limitations: [{ code: "INSUFFICIENT_SAMPLE", subjectId: "SSE:600000", baselineType: "price_return", window: 250, actual: 180, required: 251, retryable: false }], error: { code: "INSUFFICIENT_SAMPLE", retryable: false } },
  ];
  bundle.fingerprint = await calculateResearchFactBundleFingerprint(bundle);

  assert.deepEqual(validateResearchFactBundle(bundle), { ok: true, issues: [] });
  assert.equal(await verifyResearchFactBundleFingerprint(bundle), true);
});

test("binds price_context to its plan and complete direct baselines when operational", () => {
  const bundle = researchFactBundleFixture();
  bundle.purpose = "price_context";
  bundle.planVersion = "relative-performance.v1";
  bundle.facts = bundle.facts.filter((fact) => fact.kind === "market_baseline" && fact.baselineType !== "relative_return");
  bundle.capabilities = [bundle.capabilities.find((capability) => capability.id === "market_baselines")!];
  bundle.capabilities[0].factIds = bundle.facts.map((fact) => fact.id);

  const result = validateResearchFactBundle(bundle);
  assert.equal(result.ok, false);
  assert.match(result.issues.join(" "), /price_context requires planVersion price-context.v1/);
});

test("rejects invented numerics and incomplete deterministic lineage", () => {
  const bundle = researchFactBundleFixture();
  const baseline = bundle.facts.find((fact) => fact.kind === "market_baseline")!;
  baseline.value.decimal = "NaN";
  baseline.formula.inputArtifactIds = [];

  const result = validateResearchFactBundle(bundle);
  assert.equal(result.ok, false);
  assert.match(result.issues.join(" "), /value.decimal/);
  assert.match(result.issues.join(" "), /inputArtifactIds/);
});

test("rejects optimistic fact and capability quality", () => {
  const bundle = researchFactBundleFixture();
  const baseline = bundle.facts.find((fact) => fact.kind === "market_baseline")!;
  baseline.quality.coverage.actual = baseline.quality.coverage.required - 1;
  const mappingCapability = bundle.capabilities.find((capability) => capability.id === "instrument_mapping")!;
  mappingCapability.factIds = ["missing-fact"];

  const result = validateResearchFactBundle(bundle);
  assert.equal(result.ok, false);
  assert.match(result.issues.join(" "), /reliable quality requires complete coverage/);
  assert.match(result.issues.join(" "), /references unknown fact missing-fact/);
});

test("binds the fingerprint to facts, provenance, formulas, quality, and capabilities", async () => {
  const bundle = researchFactBundleFixture();
  bundle.fingerprint = await calculateResearchFactBundleFingerprint(bundle);
  assert.equal(await verifyResearchFactBundleFingerprint(bundle), true);

  const changed = structuredClone(bundle);
  const baseline = changed.facts.find((fact) => fact.kind === "market_baseline")!;
  baseline.formula.version = "tampered.v2";
  assert.equal(await verifyResearchFactBundleFingerprint(changed), false);
});

test("requires every deterministic input to be provenance-bound and within the observation cutoff", () => {
  const bundle = researchFactBundleFixture();
  const relative = bundle.facts.find((fact) => fact.kind === "market_baseline" && fact.baselineType === "relative_return")!;
  relative.provenance.sourceArtifactIds = relative.provenance.sourceArtifactIds.slice(0, 1);
  relative.provenance.sourceAsOf = "2026-08-15T07:00:00.000Z";

  const result = validateResearchFactBundle(bundle);
  assert.equal(result.ok, false);
  assert.match(result.issues.join(" "), /formula input .* is absent from provenance/);
  assert.match(result.issues.join(" "), /sourceAsOf cannot exceed observationCutoff/);
});

test("requires capability factIds to exactly cover the facts they claim", () => {
  const bundle = researchFactBundleFixture();
  const baselineCapability = bundle.capabilities.find((capability) => capability.id === "market_baselines")!;
  baselineCapability.factIds = baselineCapability.factIds.slice(1);

  const result = validateResearchFactBundle(bundle);
  assert.equal(result.ok, false);
  assert.match(result.issues.join(" "), /market_baselines factIds must exactly cover market_baseline facts/);
});

test("requires structured limitations to locate every partial baseline", () => {
  const bundle = researchFactBundleFixture();
  const capability = bundle.capabilities.find((item) => item.id === "market_baselines")!;
  capability.status = "degraded";
  capability.warnings = ["INSUFFICIENT_SAMPLE"];
  capability.limitations = [{
    code: "INSUFFICIENT_SAMPLE",
    subjectId: "SSE:600000",
    baselineType: "realized_volatility",
    window: 250,
    actual: 180,
    required: 251,
    retryable: false,
  }];
  assert.equal(validateResearchFactBundle(bundle).ok, true);

  const missingDimensions = structuredClone(bundle);
  missingDimensions.capabilities.find((item) => item.id === "market_baselines")!.limitations = [{ code: "INSUFFICIENT_SAMPLE", retryable: false }];
  const result = validateResearchFactBundle(missingDimensions);
  assert.equal(result.ok, false);
  assert.match(result.issues.join(" "), /INSUFFICIENT_SAMPLE requires subjectId, baselineType, window, actual, and required/);
});

test("enforces the closed deterministic operator contract for every baseline type", () => {
  const fields: Array<[string, (bundle: ReturnType<typeof researchFactBundleFixture>) => void]> = [
    ["formula.id", (bundle) => { bundle.facts.find((fact) => fact.kind === "market_baseline")!.formula.id = "caller.formula.v1"; }],
    ["formula.version", (bundle) => { bundle.facts.find((fact) => fact.kind === "market_baseline")!.formula.version = "2"; }],
    ["formula.expression", (bundle) => { bundle.facts.find((fact) => fact.kind === "market_baseline")!.formula.expression = "invented"; }],
    ["formula.parameters.window", (bundle) => { bundle.facts.find((fact) => fact.kind === "market_baseline")!.formula.parameters.window = "60"; }],
    ["formula.parameters.annualizationSessions", (bundle) => { bundle.facts.find((fact) => fact.kind === "market_baseline")!.formula.parameters.annualizationSessions = "252"; }],
    ["formula.parameters.adjustment", (bundle) => { bundle.facts.find((fact) => fact.kind === "market_baseline")!.formula.parameters.adjustment = "none"; }],
    ["formula.rounding", (bundle) => { bundle.facts.find((fact) => fact.kind === "market_baseline")!.formula.rounding = "binary-float"; }],
    ["value.unit", (bundle) => { bundle.facts.find((fact) => fact.kind === "market_baseline")!.value.unit = "shares"; }],
  ];

  for (const [expectedIssue, mutate] of fields) {
    const bundle = researchFactBundleFixture();
    mutate(bundle);
    assert.match(validateResearchFactBundle(bundle).issues.join(" "), new RegExp(expectedIssue.replace(".", "\\.")));
  }
});

test("requires an explicit ratio unit on financial comparisons", () => {
  const bundle = researchFactBundleFixture();
  bundle.facts.push({
    id: "financial:SSE:600000:revenue:2026Q2",
    kind: "financial_metric",
    subjectId: "SSE:600000",
    metric: "revenue",
    period: { start: "2026-04-01T00:00:00.000Z", end: "2026-06-30T00:00:00.000Z", basis: "quarter" },
    value: { decimal: "100", unit: "CNY" },
    comparison: {
      kind: "yoy",
      decimal: "0.1",
      formula: { id: "financial.yoy.v1", version: "1", expression: "current / prior - 1", inputArtifactIds: ["filing:fixture"], parameters: {}, rounding: "decimal-12-nearest" },
    },
    provenance: { providers: ["official-fixture"], sourceArtifactIds: ["filing:fixture"], sourceAsOf: bundle.observationCutoff, retrievedAt: bundle.knowledgeCutoff },
    quality: { status: "operational", coverage: { actual: 1, required: 1 }, warnings: [] },
  } as never);

  assert.match(validateResearchFactBundle(bundle).issues.join(" "), /comparison\.unit must be ratio/);
});

test("fingerprint canonicalizes limitation order and binds limitation content", async () => {
  const bundle = researchFactBundleFixture();
  const capability = bundle.capabilities.find((item) => item.id === "market_baselines")!;
  capability.status = "degraded";
  capability.warnings = ["PROVIDER_FALLBACK_USED", "INSUFFICIENT_SAMPLE"];
  capability.limitations = [
    { code: "PROVIDER_FALLBACK_USED", retryable: true },
    { code: "INSUFFICIENT_SAMPLE", subjectId: "SSE:600000", baselineType: "price_return", window: 250, actual: 180, required: 251, retryable: false },
  ];
  bundle.fingerprint = await calculateResearchFactBundleFingerprint(bundle);

  const reordered = structuredClone(bundle);
  reordered.capabilities.find((item) => item.id === "market_baselines")!.limitations.reverse();
  assert.equal(await verifyResearchFactBundleFingerprint(reordered), true);

  const changed = structuredClone(bundle);
  changed.capabilities.find((item) => item.id === "market_baselines")!.limitations[1].actual = 179;
  assert.equal(await verifyResearchFactBundleFingerprint(changed), false);
});

test("separates observation time from server-owned knowledge availability time", () => {
  const sourceAfterObservation = researchFactBundleFixture();
  sourceAfterObservation.facts[0].provenance.sourceAsOf = "2026-08-14T07:00:00.001Z";
  assert.match(validateResearchFactBundle(sourceAfterObservation).issues.join(" "), /sourceAsOf cannot exceed observationCutoff/);

  const retrievedAfterKnowledge = researchFactBundleFixture();
  retrievedAfterKnowledge.facts[0].provenance.retrievedAt = "2026-08-14T07:00:00.501Z";
  assert.match(validateResearchFactBundle(retrievedAfterKnowledge).issues.join(" "), /retrievedAt cannot exceed knowledgeCutoff/);

  const knowledgeAfterGeneration = researchFactBundleFixture();
  knowledgeAfterGeneration.knowledgeCutoff = "2026-08-14T07:00:01.001Z";
  assert.match(validateResearchFactBundle(knowledgeAfterGeneration).issues.join(" "), /knowledgeCutoff cannot exceed generatedAt/);
});

test("fingerprint binds observationCutoff and server-owned knowledgeCutoff independently", async () => {
  const bundle = researchFactBundleFixture();
  bundle.fingerprint = await calculateResearchFactBundleFingerprint(bundle);

  const changedObservation = structuredClone(bundle);
  changedObservation.observationCutoff = "2026-08-14T06:59:59.999Z";
  assert.equal(await verifyResearchFactBundleFingerprint(changedObservation), false);

  const changedKnowledge = structuredClone(bundle);
  changedKnowledge.knowledgeCutoff = "2026-08-14T07:00:00.750Z";
  assert.equal(await verifyResearchFactBundleFingerprint(changedKnowledge), false);
});

test("knowledge cutoff cannot precede the requested observation cutoff", () => {
  const bundle = researchFactBundleFixture();
  bundle.knowledgeCutoff = "2026-08-14T06:59:59.000Z";
  const result = validateResearchFactBundle(bundle);
  assert.equal(result.ok, false);
  assert.match(result.issues.join(" "), /observationCutoff cannot exceed knowledgeCutoff/);
});
