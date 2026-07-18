from .models import MarketQuote
from .protocols import MarketDataProvider


class MarketGateway:
    def __init__(self, providers: list[MarketDataProvider]):
        if not providers:
            raise ValueError("At least one market provider is required")
        self.providers = providers

    async def get_quote(self, instrument_id: str) -> MarketQuote:
        failures: list[str] = []
        for provider in self.providers:
            try:
                quote = await provider.get_quote(instrument_id)
                if quote is not None:
                    if failures:
                        quote.warnings.extend(failures)
                    return quote
                failures.append(f"{provider.__class__.__name__}:empty")
            except Exception as exc:  # provider boundary must preserve failures as warnings
                failures.append(f"{provider.__class__.__name__}:{type(exc).__name__}")
        raise LookupError(f"No provider returned {instrument_id}; failures={failures}")
