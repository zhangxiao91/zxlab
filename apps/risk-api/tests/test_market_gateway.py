from datetime import datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest

from risk_api.market_gateway.models import AssetType, MarketQuote, QuoteQuality
from risk_api.market_gateway.quality import apply_quote_quality, providers_deviate
from risk_api.market_gateway.service import MarketGateway

TZ = ZoneInfo("Asia/Shanghai")
NOW = datetime(2026, 7, 18, 14, 32, 10, tzinfo=TZ)


def quote(price: str = "10", age: int = 1, source: str = "test") -> MarketQuote:
    return MarketQuote(instrument_id="SSE:600000", symbol="600000", exchange="SSE", asset_type=AssetType.STOCK, price=Decimal(price), previous_close=Decimal("10"), limit_up=Decimal("11"), limit_down=Decimal("9"), market_timestamp=NOW - timedelta(seconds=age), received_at=NOW, source=source)


def test_quote_normalizes_decimal_and_marks_stale() -> None:
    checked = apply_quote_quality(quote(age=121), NOW, 120)
    assert checked.price == Decimal("10")
    assert checked.stale is True
    assert checked.quality == QuoteQuality.STALE
    assert "quote_stale:121s" in checked.warnings


def test_empty_or_negative_price_is_never_zero_filled() -> None:
    with pytest.raises(ValueError, match="price must be positive"):
        quote(price="0")
    with pytest.raises(ValueError, match="price must be positive"):
        quote(price="-1")


def test_abnormal_price_is_invalid() -> None:
    checked = apply_quote_quality(quote(price="11.2"), NOW)
    assert checked.quality == QuoteQuality.INVALID
    assert "price_above_limit_up" in checked.warnings


def test_provider_deviation() -> None:
    assert providers_deviate(quote("10", source="a"), quote("10.5", source="b")) is True


@pytest.mark.asyncio
async def test_provider_fallback_preserves_failure_warning() -> None:
    class Empty:
        async def get_quote(self, _: str):
            return None

    class Working:
        async def get_quote(self, _: str):
            return quote()

    result = await MarketGateway([Empty(), Working()]).get_quote("SSE:600000")
    assert "Empty:empty" in result.warnings
