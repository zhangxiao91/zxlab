import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import JSON, DateTime, ForeignKey, Numeric, String, Text, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


def new_id() -> str:
    return str(uuid.uuid4())


class AccountRecord(Base):
    __tablename__ = "accounts"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(160))
    currency: Mapped[str] = mapped_column(String(3), default="CNY")


class InstrumentRecord(Base):
    __tablename__ = "instruments"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    symbol: Mapped[str] = mapped_column(String(20), index=True)
    exchange: Mapped[str] = mapped_column(String(12))
    asset_type: Mapped[str] = mapped_column(String(20))
    leverage_multiplier: Mapped[Decimal] = mapped_column(Numeric(12, 6), default=Decimal("1"))
    industry: Mapped[str | None] = mapped_column(String(120))
    themes: Mapped[list[str]] = mapped_column(JSON, default=list)
    risk_group: Mapped[str | None] = mapped_column(String(120))


class TransactionRecord(Base):
    __tablename__ = "transactions"
    __table_args__ = (UniqueConstraint("account_id", "import_key", name="uq_transaction_import"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    account_id: Mapped[str] = mapped_column(ForeignKey("accounts.id"), index=True)
    instrument_id: Mapped[str | None] = mapped_column(ForeignKey("instruments.id"), index=True)
    type: Mapped[str] = mapped_column(String(32))
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    quantity: Mapped[Decimal] = mapped_column(Numeric(24, 8), default=Decimal("0"))
    price: Mapped[Decimal] = mapped_column(Numeric(24, 8), default=Decimal("0"))
    fee: Mapped[Decimal] = mapped_column(Numeric(24, 8), default=Decimal("0"))
    tax: Mapped[Decimal] = mapped_column(Numeric(24, 8), default=Decimal("0"))
    source: Mapped[str] = mapped_column(String(40), default="manual")
    external_id: Mapped[str | None] = mapped_column(String(160))
    import_key: Mapped[str | None] = mapped_column(String(64))
    correction_of: Mapped[str | None] = mapped_column(ForeignKey("transactions.id"))
    metadata_json: Mapped[dict] = mapped_column(JSON, default=dict)


class PositionSnapshotRecord(Base):
    __tablename__ = "position_snapshots"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    account_id: Mapped[str] = mapped_column(ForeignKey("accounts.id"), index=True)
    as_of: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    data: Mapped[dict] = mapped_column(JSON)
    reconciled: Mapped[bool] = mapped_column(default=False)


class PortfolioSnapshotRecord(Base):
    __tablename__ = "portfolio_snapshots"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    account_id: Mapped[str] = mapped_column(ForeignKey("accounts.id"), index=True)
    as_of: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    data: Mapped[dict] = mapped_column(JSON)
    reliable: Mapped[bool] = mapped_column(default=False)


class MarketQuoteRecord(Base):
    __tablename__ = "market_quotes"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    instrument_id: Mapped[str] = mapped_column(ForeignKey("instruments.id"), index=True)
    market_timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    source: Mapped[str] = mapped_column(String(50))
    quality: Mapped[str] = mapped_column(String(20))
    data: Mapped[dict] = mapped_column(JSON)


class MarketBarRecord(Base):
    __tablename__ = "market_bars"
    __table_args__ = (UniqueConstraint("instrument_id", "interval", "timestamp", "source", name="uq_bar_source"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    instrument_id: Mapped[str] = mapped_column(ForeignKey("instruments.id"), index=True)
    interval: Mapped[str] = mapped_column(String(12))
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    source: Mapped[str] = mapped_column(String(50))
    adjustment: Mapped[str] = mapped_column(String(20), default="none")
    data: Mapped[dict] = mapped_column(JSON)


class TradePlanRecord(Base):
    __tablename__ = "trade_plans"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    account_id: Mapped[str] = mapped_column(ForeignKey("accounts.id"), index=True)
    instrument_id: Mapped[str] = mapped_column(ForeignKey("instruments.id"), index=True)
    current_version: Mapped[int] = mapped_column(default=1)


class TradePlanVersionRecord(Base):
    __tablename__ = "trade_plan_versions"
    __table_args__ = (UniqueConstraint("trade_plan_id", "version", name="uq_trade_plan_version"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    trade_plan_id: Mapped[str] = mapped_column(ForeignKey("trade_plans.id"), index=True)
    version: Mapped[int]
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    data: Mapped[dict] = mapped_column(JSON)


class DecisionNoteRecord(Base):
    __tablename__ = "decision_notes"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    account_id: Mapped[str] = mapped_column(ForeignKey("accounts.id"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    content: Mapped[str] = mapped_column(Text)


class RiskRuleRecord(Base):
    __tablename__ = "risk_rules"
    id: Mapped[str] = mapped_column(String(120), primary_key=True)
    version: Mapped[int] = mapped_column(default=1)
    enabled: Mapped[bool] = mapped_column(default=True)
    config: Mapped[dict] = mapped_column(JSON)


class RiskEventRecord(Base):
    __tablename__ = "risk_events"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    account_id: Mapped[str] = mapped_column(ForeignKey("accounts.id"), index=True)
    rule_id: Mapped[str] = mapped_column(ForeignKey("risk_rules.id"), index=True)
    triggered_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    severity: Mapped[str] = mapped_column(String(16))
    status: Mapped[str] = mapped_column(String(16), default="active")
    data: Mapped[dict] = mapped_column(JSON)


class ReviewRecord(Base):
    __tablename__ = "reviews"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    account_id: Mapped[str] = mapped_column(ForeignKey("accounts.id"), index=True)
    review_date: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    mode: Mapped[str] = mapped_column(String(16))
    result: Mapped[dict] = mapped_column(JSON)


class EvidenceReferenceRecord(Base):
    __tablename__ = "evidence_references"
    id: Mapped[str] = mapped_column(String(180), primary_key=True)
    review_id: Mapped[str | None] = mapped_column(ForeignKey("reviews.id"), index=True)
    risk_event_id: Mapped[str | None] = mapped_column(ForeignKey("risk_events.id"), index=True)
    evidence_type: Mapped[str] = mapped_column(String(60))
    source_id: Mapped[str] = mapped_column(String(120))
    data: Mapped[dict] = mapped_column(JSON)


class DataIngestionRunRecord(Base):
    __tablename__ = "data_ingestion_runs"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    source: Mapped[str] = mapped_column(String(60), index=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(20))
    warnings: Mapped[list] = mapped_column(JSON, default=list)
    errors: Mapped[list] = mapped_column(JSON, default=list)
