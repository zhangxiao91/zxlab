# Personal Market Agent

Personal Market Agent context defines how ZXLab turns normalized market facts and user-confirmed context into private, evidence-bound observations and review runs. It exists to support personal attention and portfolio review without becoming an execution or recommendation system.

## Language

**Market Fact**:
A normalized external market datum with an observation time, source, quality, and warnings.
_Avoid_: Raw data, truth

**Market Snapshot**:
An immutable view of the required Market Facts and their data quality at one observation point.
_Avoid_: Dashboard state, latest data

**Research Fact Bundle**:
An immutable, purpose-scoped set of historical, reference, document, and calendar Market Facts materialized under one knowledge cutoff and deterministic research plan.
_Avoid_: Market Snapshot v2, research context, tool output

**Research Plan**:
A versioned policy that fixes which Research Facts, windows, formulas, mappings, and quality thresholds a research purpose requires.
_Avoid_: Prompt plan, model tool plan

**Knowledge Cutoff**:
The server-created upper bound of system knowledge admitted to a Research Fact Bundle. It is never earlier than Observation Cutoff and advances to the latest retrieval or First Observed At of every admitted Research Artifact; callers cannot supply or backdate it.
_Avoid_: Single provider retrieval time, caller cutoff

**Point-in-Time Research Artifact Store**:
The Market-owned append-only module that captures immutable Research Artifacts and selects revisions under both Observation Cutoff and Knowledge Cutoff. Agent, browser, and model callers cannot choose providers, formulas, storage locators, or historical knowledge times.
_Avoid_: Agent database, response cache

**Observation Cutoff**:
The latest market or effective time that a Market Fact may describe in one Research Fact request.
_Avoid_: Retrieval time, Knowledge Cutoff

**Instrument Mapping**:
An effective-dated relationship from an instrument to a benchmark, industry, industry index, or index membership, supported by a versioned taxonomy or an explicit profile comparison choice.
_Avoid_: Model-selected peer, inferred benchmark

**Research Document Version**:
An immutable normalized version of an announcement or filing whose content digest and stable paragraph identifiers support exact citation and version comparison.
_Avoid_: Announcement text, latest PDF

**Market Event**:
A deterministic, rule-identified change detected from one or more Market Snapshots.
_Avoid_: Signal, recommendation, insight

**Portfolio Snapshot**:
A versioned, read-only view derived from the user's Risk ledger and explicitly made available to the Agent.
_Avoid_: Portfolio, ledger, account

**Evidence Bundle**:
The immutable set of Market Facts, Market Events, optional portfolio impact, and Confirmed Context available to one Agent Run.
_Avoid_: Prompt, context window

**Agent Run**:
One auditable execution of a named Agent workflow against a sealed Evidence Bundle.
_Avoid_: Chat, response, generation

**Tool Definition**:
A versioned, read-only capability contract owned by the Market Agent. It fixes the allowed Ask scope, input boundary, output capability, and execution budget; it does not let the model choose providers, formulas, URLs, storage locations, or historical cutoffs.
_Avoid_: Prompt function, arbitrary API call

**Tool Invocation**:
One server-identified attempt by an Agent Run to execute an allowed Tool Definition after Tool Policy evaluation. Its instrument and observation cutoff come from the Run and Market Snapshot, not from model-produced arguments.
_Avoid_: Model request, provider request

**Tool Result**:
An immutable execution envelope that binds a Tool Invocation to its outcome and Research Fact fingerprint. The enclosed Research Fact Bundle remains the fact authority; the envelope does not create or calculate financial facts.
_Avoid_: Model answer, raw provider response

**Tool Trace**:
An append-only, privacy-filtered record of tool selection and execution state. It may expose stable identifiers, bounded status codes, timing, outcome, and Research fingerprint, but never questions, arguments, results, provider bodies, model text, or private reasoning.
_Avoid_: Chain of thought, tool output, Run Trace

**Tool Policy**:
A versioned server-owned policy that limits which Tool Definitions a workflow may select, the number and shape of invocations, their time budget, and fallback behavior. A model decision can narrow execution by skipping a tool but cannot expand this policy.
_Avoid_: System prompt, model discretion

**Observation**:
An evidence-linked statement produced by an Agent Run and classified as fact, inference, or unknown.
_Avoid_: Advice, conclusion, signal

**Research Dossier**:
A profile-scoped, single-instrument body of user-confirmed research state. It preserves accepted Fact Anchors, user-authored Thesis Statements, and their immutable revision history without becoming a Market Fact or trading plan.
_Avoid_: Research Fact Bundle, Watch Dossier, Memory summary

**Dossier Revision**:
An immutable, append-only version of a Research Dossier created only after explicit user confirmation.
_Avoid_: Mutable document, latest model answer

**Dossier Fact Anchor**:
A user-accepted normalized Research Fact, including its period, quality, formula, provenance, Evidence reference, and Research fingerprint. A degraded observation cannot replace a reliable anchor.
_Avoid_: Model finding, copied provider response

**Thesis Statement**:
A user-authored research claim stored in a Research Dossier. A model may propose an evidence-bound impact classification but cannot create, rewrite, or activate a Thesis Statement.
_Avoid_: Observation, Watch Next, recommendation

**Dossier Delta Proposal**:
An immutable, Evidence-bound proposal describing deterministic Fact changes and optional model-classified Thesis Impacts relative to one exact Dossier Revision. It has no durable effect until explicitly confirmed.
_Avoid_: Dossier Revision, Run diff

**Thesis Impact**:
A non-authoritative proposal classifying how reliable Fact deltas support, weaken, invalidate, mix, or fail to resolve an existing Thesis Statement.
_Avoid_: Fact, automatic thesis mutation

**Confirmed Context**:
User-reviewed durable context that may shape relevance or presentation but cannot create a Market Fact.
_Avoid_: Memory, profile data

**Alert Rule**:
A user-confirmed deterministic condition that can create alert state transitions when supported by reliable Market Facts.
_Avoid_: Prompt, watch request, trading rule

**Alert Rule Draft**:
A proposed Alert Rule that has no effect until the user explicitly confirms it.
_Avoid_: Alert Rule, active alert

**Watch Next**:
An evidence-linked condition worth observing in a later Market Snapshot, without prescribing a trade.
_Avoid_: Recommendation, action item

**Market-only Mode**:
An Agent Run that has reliable market evidence but no current Portfolio Snapshot.
_Avoid_: Degraded mode

**Portfolio-aware Mode**:
An Agent Run that combines a reliable Market Snapshot with a current Portfolio Snapshot and deterministic Risk impact.
_Avoid_: Trading mode, portfolio agent
