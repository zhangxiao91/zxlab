from datetime import datetime
from decimal import Decimal

from .models import MarketQuote, QuoteQuality


def apply_quote_quality(quote: MarketQuote, now: datetime, stale_seconds: int = 120) -> MarketQuote:
    warnings = list(quote.warnings)
    age = (now - quote.market_timestamp).total_seconds()
    stale = age > stale_seconds
    quality = QuoteQuality.STALE if stale else quote.quality

    if quote.limit_up is not None and quote.price > quote.limit_up * Decimal("1.001"):
        warnings.append("price_above_limit_up")
        quality = QuoteQuality.INVALID
    if quote.limit_down is not None and quote.price < quote.limit_down * Decimal("0.999"):
        warnings.append("price_below_limit_down")
        quality = QuoteQuality.INVALID
    if stale:
        warnings.append(f"quote_stale:{int(age)}s")
    return quote.model_copy(update={"stale": stale, "quality": quality, "warnings": warnings})


def providers_deviate(left: MarketQuote, right: MarketQuote, threshold: Decimal = Decimal("0.02")) -> bool:
    midpoint = (left.price + right.price) / Decimal("2")
    return abs(left.price - right.price) / midpoint > threshold
