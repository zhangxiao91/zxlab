# Market

Market owns normalized external market facts, their session-aware quality, provider fallback behavior, and deterministic Research Fact materialization.

## Language

**Effective Trading Date**:
The trading date established by a reliable calendar for the request semantics. During an active live session it is the active trading date; after completion, during a weekend, or during a holiday it is the most recent completed trading day. `MarketReference.session` and `semantics` must be read with the date. During a weekend or holiday, this date—not the wall-clock calendar date—defines what “today” and the latest valid close refer to.
_Avoid_: Today, current calendar date

**Fresh Market Fact**:
A reliable Market Fact that matches the effective trading date and relevant completed session. It does not become stale merely because wall-clock time advances through a weekend or holiday.
_Avoid_: Recent fact, live fact

**Research Artifact**:
An immutable, content-addressed provider observation accepted by the Research Fact Plane. Its source time and first successful ZXLab observation time are distinct, and it is never overwritten by a later provider revision.
_Avoid_: Cache entry, latest response

**First Observed At**:
The server-assigned time at which a Research Artifact first became durably visible in the Point-in-Time Research Artifact Store. It cannot be supplied or backdated by callers or providers.
_Avoid_: Retrieval time, report date

**Artifact Revision**:
A new immutable Research Artifact for the same logical source record whose canonical content digest differs. Point-in-time selection may use the revision only when both its source time and First Observed At satisfy the Run cutoffs.
_Avoid_: Updated row, overwritten artifact
