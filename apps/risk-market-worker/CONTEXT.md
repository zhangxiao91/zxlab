# Market

Market owns normalized external market facts, their session-aware quality, provider fallback behavior, and deterministic Research Fact materialization.

## Language

**Effective Trading Date**:
The most recent completed trading day established by a reliable trading calendar for the request time. During a weekend or holiday, this date—not the wall-clock calendar date—defines what “today” and the latest valid close refer to.
_Avoid_: Today, current calendar date

**Fresh Market Fact**:
A reliable Market Fact that matches the effective trading date and relevant completed session. It does not become stale merely because wall-clock time advances through a weekend or holiday.
_Avoid_: Recent fact, live fact
