from datetime import datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

from .portfolio_ledger.models import Transaction, TransactionType
from .risk_engine.models import PortfolioRiskInput, PositionRiskInput

TZ = ZoneInfo("Asia/Shanghai")
NOW = datetime(2026, 7, 18, 14, 32, 10, tzinfo=TZ)


def demo_transactions() -> list[Transaction]:
    return [
        Transaction(id="tx-001", account_id="account-001", instrument_id="SSE:510300", type=TransactionType.BUY, occurred_at=NOW - timedelta(days=18), quantity=Decimal("120000"), price=Decimal("3.82"), fee=Decimal("46.8"), source="mock", external_id="mock-001"),
        Transaction(id="tx-002", account_id="account-001", instrument_id="SSE:588000", type=TransactionType.BUY, occurred_at=NOW - timedelta(days=11), quantity=Decimal("260000"), price=Decimal("0.924"), fee=Decimal("24"), source="mock", external_id="mock-002"),
        Transaction(id="tx-003", account_id="account-001", instrument_id="SSE:513100", type=TransactionType.BUY, occurred_at=NOW - timedelta(days=6), quantity=Decimal("200000"), price=Decimal("1.484"), fee=Decimal("35"), source="mock", external_id="mock-003"),
        Transaction(id="tx-004", account_id="account-001", instrument_id="SSE:513100", type=TransactionType.BUY, occurred_at=NOW.replace(hour=9, minute=36), quantity=Decimal("40000"), price=Decimal("1.520"), fee=Decimal("8"), source="mock", external_id="mock-004", metadata={"plan": "missing"}),
        Transaction(id="tx-005", account_id="account-001", instrument_id="SSE:588000", type=TransactionType.BUY, occurred_at=NOW.replace(hour=14, minute=2), quantity=Decimal("50000"), price=Decimal("0.849"), fee=Decimal("8.2"), source="mock", external_id="mock-005", metadata={"risk_budget_at_trade": "0.94"}),
    ]


def demo_risk_input(stale: bool = True) -> PortfolioRiskInput:
    return PortfolioRiskInput(
        as_of=NOW, net_value=Decimal("1286420"), day_pnl=Decimal("-31842"), reconciled=True,
        positions=[
            PositionRiskInput(instrument_id="SSE:510300", market_value=Decimal("469920"), leverage_multiplier=Decimal("1"), industry="宽基", themes=["大盘", "核心资产"], evidence_ids=["position_snapshot:ps-510300"]),
            PositionRiskInput(instrument_id="SSE:588000", market_value=Decimal("262570"), leverage_multiplier=Decimal("1"), industry="科技", themes=["半导体", "硬科技"], evidence_ids=["position_snapshot:ps-588000"]),
            PositionRiskInput(instrument_id="SSE:513100", market_value=Decimal("365280"), leverage_multiplier=Decimal("3"), industry="海外科技", themes=["AI", "纳斯达克"], has_trade_plan=False, quote_stale=stale, evidence_ids=["position_snapshot:ps-513100", "quote_snapshot:q-513100"]),
        ],
        added_after_loss_budget=True, add_transaction_evidence_id="transaction:tx-005",
        stop_was_relaxed=True, stop_change_evidence_id="trade_plan_version:tp-588000-v3",
    )


def demo_evidence() -> dict[str, dict]:
    return {
        "transaction:tx-005": {"id": "transaction:tx-005", "type": "成交", "title": "科创50ETF 买入 50,000 份", "timestamp": "2026-07-18T14:02:18+08:00", "source": "portfolio_ledger", "payload": {"side": "BUY", "quantity": 50000, "price": 0.849, "fee": 8.2, "immutable": True}},
        "quote_snapshot:q-513100": {"id": "quote_snapshot:q-513100", "type": "行情快照", "title": "513100 过期报价", "timestamp": "2026-07-18T14:27:41+08:00", "source": "mock", "payload": {"price": 1.522, "stale_seconds": 269, "quality": "stale"}},
        "position_snapshot:ps-513100": {"id": "position_snapshot:ps-513100", "type": "持仓快照", "title": "513100 有效敞口", "timestamp": NOW.isoformat(), "source": "risk_engine", "payload": {"market_value": 365280, "leverage_multiplier": 3, "reliable": False}},
        "trade_plan_version:tp-588000-v3": {"id": "trade_plan_version:tp-588000-v3", "type": "计划版本", "title": "科创50ETF 计划 v3", "timestamp": "2026-07-18T11:08:00+08:00", "source": "portfolio_ledger", "payload": {"prior_stop": 0.86, "new_stop": 0.81, "version": 3}},
    }
