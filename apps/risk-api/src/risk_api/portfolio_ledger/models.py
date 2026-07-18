from datetime import datetime
from decimal import Decimal
from enum import StrEnum

from pydantic import BaseModel, Field


class TransactionType(StrEnum):
    BUY = "BUY"
    SELL = "SELL"
    DIVIDEND = "DIVIDEND"
    FEE = "FEE"
    TAX = "TAX"
    DEPOSIT = "DEPOSIT"
    WITHDRAWAL = "WITHDRAWAL"
    TRANSFER = "TRANSFER"
    POSITION_ADJUSTMENT = "POSITION_ADJUSTMENT"


class Account(BaseModel):
    id: str
    name: str
    currency: str = "CNY"
    cash: Decimal = Decimal("0")


class Instrument(BaseModel):
    id: str
    symbol: str
    name: str
    exchange: str
    asset_type: str
    leverage_multiplier: Decimal = Decimal("1")
    industry: str | None = None
    themes: list[str] = Field(default_factory=list)
    risk_group: str | None = None


class Transaction(BaseModel):
    id: str
    account_id: str
    instrument_id: str | None = None
    type: TransactionType
    occurred_at: datetime
    quantity: Decimal = Decimal("0")
    price: Decimal = Decimal("0")
    fee: Decimal = Decimal("0")
    tax: Decimal = Decimal("0")
    source: str = "manual"
    external_id: str | None = None
    correction_of: str | None = None
    metadata: dict[str, str] = Field(default_factory=dict)


class Position(BaseModel):
    instrument_id: str
    quantity: Decimal
    average_cost: Decimal
    fees: Decimal


class TradePlanVersion(BaseModel):
    id: str
    plan_id: str
    instrument_id: str
    direction: str
    thesis: str
    planned_holding_period: str
    target_position_weight: Decimal
    max_position_weight: Decimal
    stop_condition: str
    stop_price: Decimal | None = None
    invalidation_condition: str
    take_profit_condition: str | None = None
    expected_catalysts: list[str] = Field(default_factory=list)
    known_risks: list[str] = Field(default_factory=list)
    version: int
    created_at: datetime


class PositionSnapshot(BaseModel):
    id: str
    account_id: str
    as_of: datetime
    positions: list[Position]
    reconciled: bool
    evidence_ids: list[str]
