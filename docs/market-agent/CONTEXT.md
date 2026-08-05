# Personal Market Agent

Personal Market Agent context defines how ZXLab turns normalized market facts and user-confirmed context into private, evidence-bound observations and review runs. It exists to support personal attention and portfolio review without becoming an execution or recommendation system.

## Language

**Market Fact**:
A normalized external market datum with an observation time, source, quality, and warnings.
_Avoid_: Raw data, truth

**Market Snapshot**:
An immutable view of the required Market Facts and their data quality at one observation point.
_Avoid_: Dashboard state, latest data

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

**Observation**:
An evidence-linked statement produced by an Agent Run and classified as fact, inference, or unknown.
_Avoid_: Advice, conclusion, signal

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
