from datetime import datetime
from decimal import Decimal
from zoneinfo import ZoneInfo

from risk_api.portfolio_ledger.models import Transaction, TransactionType
from risk_api.portfolio_ledger.service import calculate_positions, import_transactions_csv

NOW = datetime(2026, 7, 18, tzinfo=ZoneInfo("Asia/Shanghai"))


def tx(identifier: str, kind: TransactionType, quantity: str, price: str, fee: str = "0") -> Transaction:
    return Transaction(id=identifier, account_id="a", instrument_id="SSE:510300", type=kind, occurred_at=NOW, quantity=Decimal(quantity), price=Decimal(price), fee=Decimal(fee))


def test_buy_and_partial_sell_keep_weighted_cost() -> None:
    positions = calculate_positions([tx("1", TransactionType.BUY, "100", "10", "2"), tx("2", TransactionType.BUY, "100", "12", "2"), tx("3", TransactionType.SELL, "50", "13", "1")])
    assert positions[0].quantity == Decimal("150")
    assert positions[0].average_cost.quantize(Decimal("0.01")) == Decimal("11.02")
    assert positions[0].fees == Decimal("5")


def test_adjustment_is_appended_not_mutated() -> None:
    positions = calculate_positions([tx("1", TransactionType.BUY, "100", "10"), tx("2", TransactionType.POSITION_ADJUSTMENT, "5", "10")])
    assert positions[0].quantity == Decimal("105")


def test_csv_duplicate_import_is_idempotent() -> None:
    content = "account_id,external_id,occurred_at,type,instrument_id,quantity,price\na,x1,2026-07-18T10:00:00+08:00,BUY,SSE:510300,100,4\na,x1,2026-07-18T10:00:00+08:00,BUY,SSE:510300,100,4\n"
    imported, duplicates = import_transactions_csv(content)
    assert len(imported) == 1
    assert len(duplicates) == 1
