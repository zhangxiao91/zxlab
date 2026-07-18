from decimal import Decimal

from .metrics import calculate_risk_metrics
from .models import PortfolioRiskInput, RiskEvent, RiskMetrics, Severity


class RiskRules:
    max_effective_exposure = Decimal("1.20")
    max_daily_loss_pct = Decimal("0.025")
    max_single_position_weight = Decimal("0.35")
    max_theme_weight = Decimal("0.45")


def evaluate_risk(data: PortfolioRiskInput, rules: RiskRules | None = None) -> tuple[RiskMetrics, list[RiskEvent]]:
    rules = rules or RiskRules()
    metrics = calculate_risk_metrics(data, rules.max_daily_loss_pct)
    events: list[RiskEvent] = []

    if not metrics.reliable:
        events.append(RiskEvent(id="risk:data-unreliable", rule_id="data_quality.reliable_snapshot", severity=Severity.HIGH, title="行情或账本质量阻止可靠计算", message="组合敞口值已暂停，必须先恢复新鲜行情并完成账本对账。", actual_value=None, threshold=None, triggered_at=data.as_of, evidence_ids=[item for position in data.positions for item in position.evidence_ids], data_warnings=metrics.warnings))
    elif metrics.effective_exposure is not None and metrics.effective_exposure > rules.max_effective_exposure:
        events.append(RiskEvent(id="risk:effective-exposure", rule_id="portfolio.max_effective_exposure", severity=Severity.HIGH, title="有效总敞口超过限制", message=f"当前有效敞口为 {metrics.effective_exposure:.1%}，规则上限为 {rules.max_effective_exposure:.0%}", actual_value=metrics.effective_exposure, threshold=rules.max_effective_exposure, triggered_at=data.as_of, evidence_ids=[item for position in data.positions for item in position.evidence_ids]))

    for instrument_id, weight in metrics.position_weights.items():
        if weight > rules.max_single_position_weight:
            events.append(RiskEvent(id=f"risk:position:{instrument_id}", rule_id="portfolio.max_single_position_weight", severity=Severity.HIGH, title="单标的仓位超过限制", message=f"{instrument_id} 名义仓位为 {weight:.1%}，规则上限为 {rules.max_single_position_weight:.0%}", actual_value=weight, threshold=rules.max_single_position_weight, triggered_at=data.as_of, evidence_ids=next(position.evidence_ids for position in data.positions if position.instrument_id == instrument_id)))

    for theme, weight in metrics.theme_weights.items():
        if weight > rules.max_theme_weight:
            events.append(RiskEvent(id=f"risk:theme:{theme}", rule_id="portfolio.max_theme_weight", severity=Severity.HIGH, title="主题集中度超过限制", message=f"{theme} 有效主题敞口为 {weight:.1%}，规则上限为 {rules.max_theme_weight:.0%}", actual_value=weight, threshold=rules.max_theme_weight, triggered_at=data.as_of, evidence_ids=[item for position in data.positions if theme in position.themes for item in position.evidence_ids]))

    for position in data.positions:
        if not position.has_trade_plan:
            events.append(RiskEvent(id=f"risk:unplanned:{position.instrument_id}", rule_id="behavior.unplanned_position", severity=Severity.MEDIUM, title="新增持仓缺少交易计划", message=f"{position.instrument_id} 没有可追溯交易计划。", actual_value=None, threshold=None, triggered_at=data.as_of, evidence_ids=position.evidence_ids))
    if data.added_after_loss_budget:
        events.append(RiskEvent(id="risk:add-after-loss", rule_id="behavior.add_after_loss_budget", severity=Severity.CRITICAL, title="触及日亏损预算后继续加仓", message="风险预算接近耗尽后仍发生新增买入。", actual_value=metrics.day_loss_budget_used, threshold=Decimal("0.90"), triggered_at=data.as_of, evidence_ids=[data.add_transaction_evidence_id] if data.add_transaction_evidence_id else []))
    if data.stop_was_relaxed:
        events.append(RiskEvent(id="risk:stop-relaxed", rule_id="behavior.stop_relaxation", severity=Severity.HIGH, title="止损条件被放宽", message="计划版本变化扩大了原止损容忍区间。", actual_value=None, threshold=None, triggered_at=data.as_of, evidence_ids=[data.stop_change_evidence_id] if data.stop_change_evidence_id else []))
    return metrics, events
