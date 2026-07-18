from datetime import datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

from ..models import AssetType, MarketBar, MarketQuote

TZ = ZoneInfo("Asia/Shanghai")


class MockMarketProvider:
    source = "mock"

    def __init__(self, now: datetime | None = None):
        self.now = now or datetime(2026, 7, 18, 14, 32, 10, tzinfo=TZ)
        self._prices = {
            "SSE:510300": (Decimal("3.916"), Decimal("3.973"), 6),
            "SSE:588000": (Decimal("0.847"), Decimal("0.889"), 7),
            "SSE:513100": (Decimal("1.522"), Decimal("1.571"), 269),
        }

    async def get_quote(self, instrument_id: str) -> MarketQuote | None:
        row = self._prices.get(instrument_id)
        if row is None:
            return None
        price, previous_close, age = row
        symbol = instrument_id.split(":", 1)[1]
        return MarketQuote(
            instrument_id=instrument_id, symbol=symbol, exchange="SSE", asset_type=AssetType.ETF,
            price=price, previous_close=previous_close, open=previous_close,
            high=max(price, previous_close), low=min(price, previous_close), volume=Decimal("1000000"),
            turnover=price * Decimal("1000000"), limit_up=previous_close * Decimal("1.10"),
            limit_down=previous_close * Decimal("0.90"), market_timestamp=self.now - timedelta(seconds=age),
            received_at=self.now, source=self.source,
        )

    async def get_quotes(self, instrument_ids: list[str]) -> list[MarketQuote]:
        quotes = [await self.get_quote(item) for item in instrument_ids]
        return [quote for quote in quotes if quote is not None]

    async def get_bars(self, instrument_id: str, interval: str, start: datetime, end: datetime) -> list[MarketBar]:
        step = timedelta(minutes=1) if interval == "1m" else timedelta(days=1)
        cursor, value, bars = start, Decimal("1.50"), []
        while cursor <= end and len(bars) < 240:
            value += Decimal("0.001") if len(bars) % 3 else Decimal("-0.0015")
            bars.append(MarketBar(instrument_id=instrument_id, interval=interval, timestamp=cursor, open=value, high=value + Decimal("0.004"), low=value - Decimal("0.003"), close=value + Decimal("0.001"), volume=Decimal("12000") + len(bars) * 23, source=self.source))
            cursor += step
        return bars

    async def get_market_status(self, exchange: str) -> str:
        return "open" if exchange in {"SSE", "SZSE"} else "unknown"

    async def health_check(self) -> dict[str, str]:
        return {"status": "healthy", "source": self.source}
