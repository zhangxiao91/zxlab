# Research Fact Plane v2

Research Fact Plane v2 extends the Market fact layer from a current observation
surface into a versioned research surface. It does not replace `MarketSnapshot`:
the Snapshot still answers what is observable now, while a Research Fact Bundle
answers what deterministic research material was available by a fixed knowledge
cutoff.

## Module interface

The Market Agent expresses a research purpose, not a provider or calculation
recipe:

```ts
interface ResearchFactPlane {
  materialize(input: {
    purpose: ResearchPurpose;
    instrumentIds: string[];
    selectedInstrumentId?: string;
    observationCutoff: string;
  }): Promise<ResearchFactBundle>;
}
```

`purpose` resolves to a versioned Research Plan inside the Market Worker. The
plan owns capability selection, windows, provider policy, deterministic
operators, quality thresholds, and payload budgets. Browser and model callers
cannot choose those values.

The request's `observationCutoff` is fixed to the current Market Snapshot
`asOf`. After acquisition, the Plane creates `knowledgeCutoff` from the latest
retrieval admitted to the Bundle. This keeps market as-of and system knowledge
time distinct: `sourceAsOf <= observationCutoff` and
`retrievedAt <= knowledgeCutoff <= generatedAt`.

The production adapter uses the Market Worker service binding and a dedicated
`MARKET_RESEARCH_TOKEN`; it does not reuse the Runtime health identity. Tests
use an in-memory adapter. Provider adapters and deterministic operators remain
internal seams of the Research Fact Plane implementation.

## Invariants

- Facts with a market/effective time after the observation cutoff are excluded;
  artifacts retrieved after the server-created knowledge cutoff are invalid.
- Every derived number identifies its deterministic operator, formula version,
  inputs, parameters, units, and rounding policy.
- Missing data remains missing with a structured limitation. It is never
  replaced by zero, a shorter window, a peer value, or model output.
- Benchmark, industry, and index mappings are effective-dated. Profile-selected
  comparators remain distinct from canonical index membership.
- An `N`-session return or realized-volatility baseline requires `N + 1`
  valid closes; an `N`-session volume baseline requires `N` completed sessions.
- Financial changes compare like-for-like reporting periods and accounting
  scopes. Cumulative reports are converted to single-quarter values only by a
  versioned deterministic operator.
- Valuation percentiles use one metric and one methodology for one instrument;
  insufficient or economically meaningless samples return unknown.
- Document citations bind a document version, paragraph ID, and content digest.
  A changed document creates a new version and a deterministic paragraph diff.
- Partial provider failure produces a partial Bundle with capability outcomes.
  Only invalid requests, authorization failures, or integrity failures abort the
  entire request.
- Agent replay consumes the sealed Bundle. It never re-fetches current provider
  data or silently upgrades formula and document versions.

## Delivery slices

### Slice A: price context and relative performance

- Versioned benchmark mapping with an explicit unmapped result.
- 20, 60, and 250 completed-session price, median-volume, and realized
  volatility baselines. Turnover/amount operators remain a later baseline
  extension.
- Benchmark-aligned excess return when a valid mapping is available.
- Provider, source as-of, retrieval time, coverage, data quality, formula, and
  input provenance on every fact.
- Market Agent Evidence and checkpoint sealing for `today_change`,
  `relative_performance`, and close review.

This slice is the first release because it exercises the core time, mapping,
quality, deterministic-computation, and replay contracts without pretending
that unsupported research domains are already available.

### Slice B: financial statements and valuation

- Canonical financial metric taxonomy and statement revisions.
- Reported values plus comparable YoY and QoQ changes.
- PE TTM, PB MRQ, PS TTM, and dividend-yield distributions with methodology and
  minimum-coverage rules.
- Point-in-time source artifact storage so historical Runs cannot see later
  financial revisions.

### Slice C: documents and version differences

- Immutable raw document storage and normalized text manifests.
- Stable paragraph citations, extraction quality, and content digests.
- Deterministic document version linking and paragraph diff.
- Full-text retrieval by immutable version, outside the normal Agent payload
  budget.

### Slice D: research calendar

- Corporate actions, earnings dates, and macro releases.
- Scheduled, confirmed, changed, completed, and cancelled states.
- Source-aware date precision and change history.

## Storage evolution

Slice A can materialize only a near-current observation cutoff from normalized
long daily bars and an explicit mapping registry. It does not claim arbitrary
historical point-in-time availability: a later provider revision cannot be used
to recreate what was known months earlier. Point-in-time financials, valuation
histories, document versions, mappings, and calendar changes require
append-only metadata storage with `firstObservedAt`; document binaries and
normalized full text require blob storage. Cache API remains a transport cache
and is never the authority for versions or historical knowledge reconstruction.

Preview bindings and migrations are introduced only in the slice that needs
them. Production configuration remains outside the default deployment scope.

## Acceptance

For each delivered purpose, acceptance must prove:

- the deterministic result is identical with model generation disabled;
- every number opens to source and formula provenance;
- insufficient coverage is visible as unknown;
- the Research Fact fingerprint is part of sealed Run integrity;
- replay does not perform provider I/O;
- local interface tests, Worker tests, full build, Preview activation, and an
  authenticated browser Run are reported as separate evidence.
