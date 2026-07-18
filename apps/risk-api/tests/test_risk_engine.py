from decimal import Decimal

from risk_api.demo import demo_risk_input
from risk_api.risk_engine.service import evaluate_risk


def test_stale_quote_blocks_reliable_exposure() -> None:
    metrics, events = evaluate_risk(demo_risk_input(stale=True))
    assert metrics.reliable is False
    assert metrics.effective_exposure is None
    assert any(event.rule_id == "data_quality.reliable_snapshot" for event in events)


def test_effective_exposure_includes_leverage_multiplier() -> None:
    metrics, events = evaluate_risk(demo_risk_input(stale=False))
    expected = (Decimal("469920") + Decimal("262570") + Decimal("365280") * 3) / Decimal("1286420")
    assert metrics.effective_exposure == expected
    assert any(event.rule_id == "portfolio.max_effective_exposure" for event in events)


def test_concentration_loss_budget_and_behavior_rules() -> None:
    metrics, events = evaluate_risk(demo_risk_input(stale=False))
    rule_ids = {event.rule_id for event in events}
    assert metrics.position_weights["SSE:510300"] > Decimal("0.35")
    assert metrics.day_loss_budget_used > Decimal("0.98")
    assert "portfolio.max_single_position_weight" in rule_ids
    assert "behavior.add_after_loss_budget" in rule_ids
    assert "behavior.unplanned_position" in rule_ids
    assert "behavior.stop_relaxation" in rule_ids
    assert "portfolio.max_theme_weight" in rule_ids
