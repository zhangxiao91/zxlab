# Market Agent beta acceptance

Market Agent generation is routed through the unified Gateway with this order:

1. DeepSeek official;
2. the Market Agent fast OpenAI fallback, when configured;
3. the configured OpenAI text model;
4. the remaining Gateway candidates.

Beta is isolated from Production at the Worker state boundary:

- Pages Preview binds `MARKET_AGENT_SERVICE` to `zxlab-market-agent-beta`;
- Pages Production remains bound to `zxlab-market-agent`;
- the beta Worker owns `market-agent-beta`, `market-agent-runs-beta`, and
  `market-agent-runs-beta-dlq`;
- beta has no cron trigger; acceptance Runs are created explicitly;
- only the beta Worker points to
  `https://beta.zxlab.pages.dev/api/ai/generate`.
- Signal and the beta Market Agent share a dedicated encrypted
  `MARKET_AGENT_MEMORY_TOKEN`; Signal accepts it only for
  `POST /api/memory/retrieve`.
- Apply Market Agent migrations through `0009_run_trace_controls.sql` before
  deploying the P4 Worker. Migrations `0007` and `0008` add archive tombstones,
  keyset pagination indexes, checkpoint Events, and retention state; migration
  `0009` adds server timing and the bounded, profile-scoped Run trace ledger.
- beta intentionally has no cron trigger, so Preview acceptance can verify the
  archive contract and migrations but not the scheduled retention trigger.
- Signal Memory is a single-owner personal domain in Phase 6.5. Do not admit a
  second independent owner until Signal Memory storage and retrieval are
  owner-scoped.

Run the environment gate after the beta Pages deployment and beta Worker deploy:

```bash
npm run verify:market-agent:env -- --commit "$(git rev-parse HEAD)"
```

It verifies the Preview Gateway credentials by binding type, the successful beta
commit, the isolated Preview/Production service bindings, and the beta Worker's
Gateway URL/token. Secret values are never included in the report. A stale
Preview `DEEPSEEK_*_MODEL` override is reported as a warning and should be
removed unless it is intentionally part of the current Gateway contract.

Then run one dedicated end-to-end request:

```bash
npm run verify:market-agent:run
```

The command creates and polls three independent `close_review` Runs through the
Keychain-backed debug Access path. Every Run must pass; use `--runs 1` only for
fast diagnosis. Acceptance allows `success` or an evidence-limited `partial`
Run, but each Run requires a completed model narration with
`provider=deepseek`, a DeepSeek model, `fallbackIndex=0`, and a Gateway request
ID. A deterministic narration or any provider fallback fails the command.

## Authenticated browser acceptance

The command above verifies the machine-authenticated `close_review` path. It
does not replace a real, signed-in browser acceptance when the Ask UI, rendered
Evidence, or refresh persistence is in scope. For that acceptance, use the beta
route:

```text
https://beta.zxlab.pages.dev/lab/trading?view=review&mode=market
```

Use accessible names as the primary automation contract. The following fixture
exercises the currently configured relative-performance benchmark mapping:

```js
getByRole("combobox", { name: /问题范围/ }).selectOption("relative_performance")
getByRole("textbox", { name: "标的" }).fill("SSE:600000")
getByRole("textbox", { name: "问题说明" }).fill(
  "请按 20、60、250 日窗口比较相对表现，并引用公式与数据来源。",
)
getByRole("button", { name: "开始回答" }).click()
```

`SSE:600000` is a deliberate fixture, not a general product constraint: the
current explicit registry maps it to `SSE:000300`. If that registry changes,
choose an instrument with an effective explicit mapping and update the expected
benchmark below. CSS classes are diagnostic fallbacks only; do not make them
the primary E2E contract.

Capture the `runId` from the successful
`POST /api/private/market-agent/ask` response. All later browser, refresh, and
D1 assertions must refer to that exact Run. Querying the latest Run is racy and
can attach evidence from another user's or agent's acceptance request.

A browser pass requires all of the following:

- a terminal `success` or `partial` response for the captured Run;
- a rendered answer and an `Evidence` disclosure with the sealed Evidence
  fingerprint prefix and item count;
- a refresh followed by recovery of the same Run and Evidence;
- no new browser console error attributable to the request;
- the exact-Run D1 consistency gate below.

For P4 Run controls, the same browser session must additionally verify:

- the activity panel renders only events returned by `GET /runs/:id/trace` or
  the persisted `trace` SSE event, including server timestamps and durations;
- an active Run can be cancelled, reaches terminal `cancelled`, and stays
  cancelled after refresh;
- retrying that cancelled Run creates one new Run with
  `revisionOfRunId = <cancelled run id>`; replaying the same retry request with
  the same idempotency key returns the same new Run;
- the old Run remains cancelled and cannot be overwritten by a late consumer;
- no trace row contains prompt text, tool input/output, raw error messages,
  credentials, headers, query strings, model output, or private reasoning.

Cancellation is durable lease fencing. It prevents an old consumer from
persisting later stages or a result, but it does not claim to synchronously
terminate an upstream HTTP request that has already been sent.

`partial` is a terminal state, not a model-health verdict. When narration is in
scope, inspect structured `RunOutcome.narration` and `EvidenceAssessment`
instead of inferring provider health from status or limitation text.

### Rendered Research Evidence boundary

The Evidence disclosure is not currently a complete Evidence browser. A raw
Research Fact is visible only when the rendered answer contains a citation such
as `<runId>:research:<index>` and the user opens that citation. The model is not
guaranteed to cite every Research Fact, and deterministic fallback does not
create an observation solely to expose one.

Therefore, formula and provenance visibility is a conditional rendered
contract. If no Research Fact citation is rendered, do not report the browser
Evidence inspection as passed even if the D1 consistency gate succeeds. Report
the two results separately. When a baseline Research Fact is cited, its raw JSON
must include the matching Research fingerprint, `relative-performance.v1`,
`relative_performance`, a `market_baseline` with `relative_return`, the expected
window and benchmark, formula version/expression/adjustment/rounding, and
non-empty provenance and quality fields.

## Exact-Run beta D1 consistency gate

This gate is read-only. Replace `RUN_ID` with the identifier captured from the
browser response; do not substitute a "latest Run" query.

```bash
npx wrangler d1 execute market-agent-beta --remote \
  --config apps/market-agent-worker/wrangler.beta.jsonc \
  --command "WITH target AS (
    SELECT id,status,evidence_fingerprint,evidence_json
    FROM agent_runs
    WHERE id='RUN_ID'
      AND workflow='ask'
      AND json_extract(command_json,'$.scope')='relative_performance'
  ),
  research_evidence AS (
    SELECT target.id,
      json_extract(item.value,'$.value.researchFingerprint') AS research_fp,
      json_extract(item.value,'$.value.fact.kind') AS fact_kind,
      json_extract(item.value,'$.value.fact.baselineType') AS baseline_type,
      json_extract(item.value,'$.value.fact.window') AS window,
      json_extract(item.value,'$.value.fact.benchmarkId') AS benchmark_id,
      json_extract(item.value,'$.value.fact.formula.id') AS formula_id,
      json_extract(item.value,'$.value.fact.formula.expression') AS expression,
      json_array_length(json_extract(item.value,'$.value.fact.provenance.providers')) AS provider_count,
      json_array_length(json_extract(item.value,'$.value.fact.provenance.sourceArtifactIds')) AS artifact_count,
      json_extract(item.value,'$.value.fact.provenance.sourceAsOf') AS source_as_of,
      json_extract(item.value,'$.value.fact.provenance.retrievedAt') AS retrieved_at
    FROM target, json_each(target.evidence_json,'$.items') AS item
    WHERE json_extract(item.value,'$.value.type')='research_fact'
  )
  SELECT target.id,
    target.status,
    target.evidence_fingerprint=json_extract(target.evidence_json,'$.fingerprint') AS evidence_fp_matches,
    json_extract(rms.snapshot_json,'$.schemaVersion') AS checkpoint_schema,
    json_extract(rms.snapshot_json,'$.research.schemaVersion') AS research_schema,
    json_extract(rms.snapshot_json,'$.research.planVersion') AS research_plan,
    json_extract(rms.snapshot_json,'$.research.purpose') AS research_purpose,
    json_extract(rms.snapshot_json,'$.research.fingerprint') AS checkpoint_research_fp,
    length(rms.fingerprint)=71
      AND substr(rms.fingerprint,1,7)='sha256:'
      AND substr(rms.fingerprint,8) NOT GLOB '*[^0-9a-f]*' AS checkpoint_fp_shape,
    COUNT(research_evidence.id) AS research_fact_count,
    SUM(CASE WHEN fact_kind='market_baseline'
      AND baseline_type='relative_return'
      AND benchmark_id='SSE:000300'
      AND formula_id='market.relative_return.v1'
      AND expression='subject_return - benchmark_return'
      THEN 1 ELSE 0 END) AS relative_return_fact_count,
    COUNT(DISTINCT CASE WHEN baseline_type='relative_return' THEN window END) AS relative_return_window_count,
    SUM(CASE WHEN provider_count>0 AND artifact_count>0
      AND source_as_of IS NOT NULL AND retrieved_at IS NOT NULL
      THEN 1 ELSE 0 END) AS provenance_complete_count,
    COUNT(DISTINCT research_evidence.research_fp) AS distinct_evidence_research_fps,
    json_extract(rms.snapshot_json,'$.research.fingerprint')=MIN(research_evidence.research_fp) AS research_fp_matches
  FROM target
  JOIN run_market_snapshots rms ON rms.run_id=target.id
  LEFT JOIN research_evidence ON research_evidence.id=target.id
  GROUP BY target.id"
```

For the fixture above, require:

- exactly one row for the captured Run with status `success` or `partial`;
- `evidence_fp_matches = 1` and `checkpoint_fp_shape = 1`;
- `checkpoint_schema = run-checkpoint.v2`;
- `research_schema = research-facts.v2`;
- `research_plan = relative-performance.v1` and
  `research_purpose = relative_performance`;
- `research_fact_count > 0`, `relative_return_fact_count = 3`, and
  `relative_return_window_count = 3` for the 20/60/250-day windows;
- `provenance_complete_count = research_fact_count`;
- `distinct_evidence_research_fps = 1` and `research_fp_matches = 1`;
- `checkpoint_research_fp` has the `sha256:` prefix followed by 64 lowercase
  hexadecimal characters.

`run_market_snapshots.fingerprint` is the integrity fingerprint of the complete
checkpoint. It must not equal the Research Fact Bundle fingerprint. This SQL
checks persisted cross-references and fingerprint shape; cryptographic
recomputation remains the responsibility of `verifyRunCheckpoint` and its
tests.

Report browser rendering, refresh persistence, exact-Run D1 consistency, and
narration/provider outcome as separate evidence. A Pages redirect, health 200,
deployment, local test, machine-authenticated probe, or D1 row alone is not an
authenticated browser E2E pass.
