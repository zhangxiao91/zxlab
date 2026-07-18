from datetime import datetime
from decimal import Decimal
from enum import StrEnum

from pydantic import BaseModel, Field


class Severity(StrEnum):
    CRITICAL = "critical"
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


class PositionRiskInput(BaseModel):
    instrument_id: str
    market_value: Decimal
    leverage_multiplier: Decimal = Decimal("1")
    industry: str
    themes: list[str]
    has_trade_plan: bool = True
    quote_stale: bool = False
    evidence_ids: list[str] = Field(default_factory=list)


class PortfolioRiskInput(BaseModel):
    as_of: datetime
    net_value: Decimal
    day_pnl: Decimal
    positions: list[PositionRiskInput]
    added_after_loss_budget: bool = False
    add_transaction_evidence_id: str | None = None
    stop_was_relaxed: bool = False
    stop_change_evidence_id: str | None = None
    reconciled: bool = True


class RiskMetrics(BaseModel):
    nominal_exposure: Decimal | None
    effective_exposure: Decimal | None
    day_loss_budget_used: Decimal
    position_weights: dict[str, Decimal]
    theme_weights: dict[str, Decimal]
    reliable: bool
    warnings: list[str] = Field(default_factory=list)


class RiskEvent(BaseModel):
    id: str
    rule_id: str
    severity: Severity
    status: str = "active"
    title: str
    message: str
    actual_value: Decimal | None
    threshold: Decimal | None
    triggered_at: datetime
    evidence_ids: list[str]
    data_warnings: list[str] = Field(default_factory=list)
