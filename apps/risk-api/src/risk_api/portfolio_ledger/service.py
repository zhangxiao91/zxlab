import csv
import hashlib
import io
from collections import defaultdict
from decimal import Decimal

from .models import Position, Transaction, TransactionType


def calculate_positions(transactions: list[Transaction]) -> list[Position]:
    state: dict[str, dict[str, Decimal]] = defaultdict(
        lambda: {"quantity": Decimal("0"), "cost": Decimal("0"), "fees": Decimal("0")}
    )
    for transaction in sorted(transactions, key=lambda item: (item.occurred_at, item.id)):
        if not transaction.instrument_id:
            continue
        item = state[transaction.instrument_id]
        if transaction.type == TransactionType.BUY:
            item["quantity"] += transaction.quantity
            item["cost"] += transaction.quantity * transaction.price + transaction.fee + transaction.tax
            item["fees"] += transaction.fee + transaction.tax
        elif transaction.type == TransactionType.SELL:
            if transaction.quantity > item["quantity"]:
                raise ValueError(f"Sell exceeds position for {transaction.instrument_id}")
            average = item["cost"] / item["quantity"] if item["quantity"] else Decimal("0")
            item["cost"] -= average * transaction.quantity
            item["quantity"] -= transaction.quantity
            item["fees"] += transaction.fee + transaction.tax
            if item["quantity"] == 0:
                item["cost"] = Decimal("0")
        elif transaction.type == TransactionType.POSITION_ADJUSTMENT:
            item["quantity"] += transaction.quantity
            item["cost"] += transaction.quantity * transaction.price

    result = []
    for instrument_id, item in state.items():
        if item["quantity"] == 0:
            continue
        result.append(Position(instrument_id=instrument_id, quantity=item["quantity"], average_cost=item["cost"] / item["quantity"], fees=item["fees"]))
    return sorted(result, key=lambda item: item.instrument_id)


def csv_import_key(row: dict[str, str]) -> str:
    stable = "|".join(row.get(key, "").strip() for key in ("account_id", "external_id", "occurred_at", "type", "instrument_id", "quantity", "price"))
    return hashlib.sha256(stable.encode()).hexdigest()


def import_transactions_csv(content: str, existing_keys: set[str] | None = None) -> tuple[list[dict[str, str]], list[str]]:
    existing = existing_keys or set()
    imported, duplicates = [], []
    for row in csv.DictReader(io.StringIO(content)):
        key = csv_import_key(row)
        if key in existing:
            duplicates.append(key)
            continue
        existing.add(key)
        imported.append({**row, "import_key": key})
    return imported, duplicates
