from datetime import datetime
from decimal import Decimal
from enum import StrEnum

from pydantic import BaseModel, Field, model_validator


class AssetType(StrEnum):
    STOCK = "stock"
    ETF = "etf"
    INDEX = "index"


class QuoteQuality(StrEnum):
    LIVE = "live"
    DELAYED = "delayed"
    CACHED = "cached"
    STALE = "stale"
    INVALID = "invalid"


class MarketQuote(BaseModel):
    instrument_id: str
    symbol: str
    exchange: str
    asset_type: AssetType
    currency: str = "CNY"
    price: Decimal
    previous_close: Decimal
    open: Decimal | None = None
    high: Decimal | None = None
    low: Decimal | None = None
    volume: Decimal | None = None
    turnover: Decimal | None = None
    limit_up: Decimal | None = None
    limit_down: Decimal | None = None
    market_timestamp: datetime
    received_at: datetime
    source: str
    quality: QuoteQuality = QuoteQuality.LIVE
    stale: bool = False
    warnings: list[str] = Field(default_factory=list)
    adjustment: str = "none"

    @model_validator(mode="after")
    def validate_price(self) -> "MarketQuote":
        if self.price <= 0:
            raise ValueError("price must be positive; missing data must not be normalized to zero")
        if self.previous_close <= 0:
            raise ValueError("previous_close must be positive")
        return self


class MarketBar(BaseModel):
    instrument_id: str
    interval: str
    timestamp: datetime
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: Decimal
    source: str
    adjustment: str = "none"
