from collections.abc import Awaitable, Callable
from typing import Any

Tool = Callable[..., Awaitable[dict[str, Any]]]


class ReadOnlyToolRegistry:
    allowed = {
        "get_portfolio_snapshot", "get_positions", "get_recent_operations", "get_trade_plan",
        "get_risk_events", "get_intraday_bars", "get_daily_bars", "get_market_benchmark",
        "query_optional_market_data",
    }

    def __init__(self) -> None:
        self._tools: dict[str, Tool] = {}

    def register(self, name: str, tool: Tool) -> None:
        if name not in self.allowed:
            raise ValueError(f"Tool {name} is not in the read-only allowlist")
        self._tools[name] = tool

    async def call(self, name: str, **kwargs: Any) -> dict[str, Any]:
        if name not in self._tools:
            return {"status": "error", "tool": name, "data": None, "warnings": [], "errors": ["tool_unavailable"]}
        try:
            return await self._tools[name](**kwargs)
        except Exception as exc:
            return {"status": "error", "tool": name, "data": None, "warnings": [], "errors": [type(exc).__name__]}
