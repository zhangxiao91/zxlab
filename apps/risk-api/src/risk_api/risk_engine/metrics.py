from collections import defaultdict
from decimal import Decimal

from .models import PortfolioRiskInput, RiskMetrics


def calculate_risk_metrics(data: PortfolioRiskInput, max_daily_loss_pct: Decimal) -> RiskMetrics:
    if data.net_value <= 0:
        raise ValueError("net_value must be positive")
    stale = [position.instrument_id for position in data.positions if position.quote_stale]
    warnings = [f"stale_quote:{item}" for item in stale]
    position_weights: dict[str, Decimal] = {}
    themes: dict[str, Decimal] = defaultdict(Decimal)
    nominal = Decimal("0")
    effective = Decimal("0")
    for position in data.positions:
        weight = position.market_value / data.net_value
        position_weights[position.instrument_id] = weight
        nominal += weight
        effective += weight * position.leverage_multiplier
        for theme in position.themes:
            themes[theme] += weight * position.leverage_multiplier
    reliable = not stale and data.reconciled
    return RiskMetrics(
        nominal_exposure=nominal if reliable else None,
        effective_exposure=effective if reliable else None,
        day_loss_budget_used=max(Decimal("0"), -data.day_pnl / (data.net_value * max_daily_loss_pct)),
        position_weights=position_weights,
        theme_weights=dict(themes),
        reliable=reliable,
        warnings=warnings + ([] if data.reconciled else ["ledger_not_reconciled"]),
    )
