import os
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from .demo import NOW, demo_evidence, demo_risk_input, demo_transactions
from .market_gateway.providers import MockMarketProvider
from .market_gateway.quality import apply_quote_quality
from .optional_market_tools import industry_performance, stock_announcements, stock_news
from .portfolio_ledger.models import Account, Transaction
from .portfolio_ledger.service import calculate_positions, import_transactions_csv
from .review_agent.schemas import EvidencePack
from .review_agent.service import deterministic_review, run_review
from .risk_engine.service import evaluate_risk
from .settings import get_settings

settings = get_settings()
app = FastAPI(title="zxlab Risk API", version="0.1.0", description="Private, read-only portfolio risk and evidence review API")
app.add_middleware(CORSMiddleware, allow_origins=["http://127.0.0.1:4321", "http://localhost:4321"], allow_credentials=False, allow_methods=["GET", "POST", "PUT"], allow_headers=["Content-Type"])

provider = MockMarketProvider()
transactions = demo_transactions()
evidence_store = demo_evidence()
trade_plans: list[dict[str, Any]] = [{"id": "tp-588000", "instrument_id": "SSE:588000", "version": 3, "target_position_weight": 0.16, "max_position_weight": 0.2, "stop_condition": "价格低于 0.81 复核失效", "prior_stop": 0.86, "updated_at": "2026-07-18T11:08:00+08:00"}]


def envelope(data: Any, warnings: list[str] | None = None, freshness: str = "mock") -> dict[str, Any]:
    return {"data": data, "warnings": warnings or [], "freshness": freshness, "received_at": datetime.now().astimezone().isoformat()}


@app.get("/health")
@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {"status": "healthy", "mode": settings.provider_mode, "review_mode": settings.review_mode, "database": "configured", "read_only_agent": True}


@app.get("/api/accounts")
async def accounts() -> dict[str, Any]:
    return envelope([Account(id="account-001", name="个人交易账户", cash=Decimal("188560"))])


@app.get("/api/transactions")
async def get_transactions() -> dict[str, Any]:
    return envelope(transactions)


@app.post("/api/transactions")
async def add_transaction(transaction: Transaction) -> dict[str, Any]:
    if any(item.id == transaction.id for item in transactions):
        raise HTTPException(409, "transaction id already exists; history is immutable")
    transactions.append(transaction)
    return envelope(transaction, ["manual transaction appended as immutable event"])


@app.post("/api/transactions/import")
async def import_transactions(file: UploadFile = File(...)) -> dict[str, Any]:
    content = (await file.read()).decode("utf-8-sig")
    existing = {item.external_id for item in transactions if item.external_id}
    imported, duplicates = import_transactions_csv(content, existing)
    return envelope({"accepted": imported, "duplicate_keys": duplicates}, ["validate accepted rows before committing to PostgreSQL"])


@app.get("/api/positions")
async def positions() -> dict[str, Any]:
    return envelope(calculate_positions(transactions))


@app.get("/api/portfolio/snapshot")
async def portfolio_snapshot() -> dict[str, Any]:
    risk_input = demo_risk_input()
    metrics, _ = evaluate_risk(risk_input)
    return envelope({"account_id": "account-001", "as_of": NOW, "net_value": risk_input.net_value, "cash": Decimal("188560"), "day_pnl": risk_input.day_pnl, "metrics": metrics}, metrics.warnings, "stale" if not metrics.reliable else "live")


@app.get("/api/market/quotes")
async def market_quotes(instruments: str = "SSE:510300,SSE:588000,SSE:513100") -> dict[str, Any]:
    quotes = []
    for instrument in instruments.split(","):
        quote = await provider.get_quote(instrument.strip())
        if quote:
            quotes.append(apply_quote_quality(quote, NOW, settings.quote_stale_seconds))
    warnings = [warning for quote in quotes for warning in quote.warnings]
    return envelope(quotes, warnings, "mixed" if warnings else "live")


@app.get("/api/market/bars/{instrument_id:path}")
async def market_bars(instrument_id: str, interval: str = "1m") -> dict[str, Any]:
    if interval not in {"1m", "1d"}:
        raise HTTPException(422, "interval must be 1m or 1d; periods are never inferred")
    end = NOW
    start = end - (timedelta(minutes=239) if interval == "1m" else timedelta(days=30))
    return envelope(await provider.get_bars(instrument_id, interval, start, end), freshness="mock")


@app.get("/api/market/sources")
async def market_sources() -> dict[str, Any]:
    return envelope([await provider.health_check(), {"source": "mootdx", "status": "configured_not_enabled"}, {"source": "tencent", "status": "configured_not_enabled"}])


@app.get("/api/risk/snapshot")
@app.post("/api/risk/evaluate")
async def risk_snapshot() -> dict[str, Any]:
    metrics, events = evaluate_risk(demo_risk_input())
    return envelope({"metrics": metrics, "events": events}, metrics.warnings, "stale" if not metrics.reliable else "live")


@app.get("/api/risk/events")
async def risk_events() -> dict[str, Any]:
    metrics, events = evaluate_risk(demo_risk_input())
    return envelope(events, metrics.warnings)


@app.get("/api/risk/dashboard")
async def risk_dashboard() -> dict[str, Any]:
    risk_input = demo_risk_input()
    metrics, events = evaluate_risk(risk_input)
    review = deterministic_review(build_evidence_pack(date(2026, 7, 18)))
    position_rows = [
        {"instrumentId": "SSE:510300", "symbol": "510300", "name": "沪深300ETF", "assetType": "etf", "quantity": 120000, "averageCost": 3.82, "price": 3.916, "marketValue": 469920, "unrealizedPnl": 11520, "dayPnl": -6840, "nominalWeight": 0.3653, "leverageMultiplier": 1, "effectiveExposure": 0.3653, "industry": "宽基", "themes": ["大盘", "核心资产"], "planStatus": "aligned", "quoteQuality": "live", "quoteTime": "14:32:04", "riskEventIds": []},
        {"instrumentId": "SSE:588000", "symbol": "588000", "name": "科创50ETF", "assetType": "etf", "quantity": 310000, "averageCost": 0.912, "price": 0.847, "marketValue": 262570, "unrealizedPnl": -20150, "dayPnl": -13210, "nominalWeight": 0.2041, "leverageMultiplier": 1, "effectiveExposure": 0.2041, "industry": "科技", "themes": ["半导体", "硬科技"], "planStatus": "overweight", "quoteQuality": "live", "quoteTime": "14:32:03", "riskEventIds": ["risk:position-overweight"]},
        {"instrumentId": "SSE:513100", "symbol": "513100", "name": "纳指ETF（三倍敞口）", "assetType": "etf", "quantity": 240000, "averageCost": 1.49, "price": 1.522, "marketValue": 365280, "unrealizedPnl": 7680, "dayPnl": -11792, "nominalWeight": 0.2839, "leverageMultiplier": 3, "effectiveExposure": 0.8517, "industry": "海外科技", "themes": ["AI", "纳斯达克"], "planStatus": "missing", "quoteQuality": "stale", "quoteTime": "14:27:41", "riskEventIds": ["risk:data-unreliable", "risk:unplanned:SSE:513100"]},
    ]
    event_rows = [{"id": item.id, "ruleId": item.rule_id, "severity": item.severity.value, "status": item.status, "title": item.title, "message": item.message, "actualValue": float(item.actual_value) if item.actual_value is not None else None, "threshold": float(item.threshold) if item.threshold is not None else None, "triggeredAt": item.triggered_at.isoformat(), "evidenceIds": item.evidence_ids, "dataWarnings": item.data_warnings} for item in events]
    review_data = review.model_dump(mode="json")
    return {
        "asOf": NOW.isoformat(), "receivedAt": (NOW + timedelta(seconds=1)).isoformat(), "accountName": "个人交易账户", "currency": "CNY",
        "portfolio": {"netValue": 1286420, "marketValue": 1097770, "cash": 188560, "nominalExposure": 0.8533, "effectiveExposure": 1.4212, "dayPnl": -31842, "dayReturn": -0.02475, "currentDrawdown": -0.071, "maxDrawdown": -0.126, "riskBudgetUsed": float(metrics.day_loss_budget_used), "reliable": metrics.reliable},
        "sourceHealth": [{"name": "Mock Market", "status": "healthy", "latency": "local", "freshness": "mixed"}, {"name": "交易账本", "status": "healthy", "latency": "local", "freshness": "已对账"}, {"name": "Review Agent", "status": "healthy", "latency": "按需", "freshness": "只读"}],
        "positions": position_rows, "riskEvents": event_rows,
        "activity": [{"id": "a1", "time": "14:32", "type": "rule", "title": "数据质量阻止可靠计算", "detail": "513100 报价超过 120 秒；敞口只显示带警告的估算值。", "evidenceId": "quote_snapshot:q-513100", "tone": "danger"}, {"id": "a2", "time": "14:02", "type": "trade", "title": "买入 科创50ETF", "detail": "风险预算接近耗尽后新增 50,000 份。", "evidenceId": "transaction:tx-005", "tone": "danger"}, {"id": "a3", "time": "11:08", "type": "plan", "title": "止损条件放宽", "detail": "计划版本 v2 到 v3 保留完整记录。", "evidenceId": "trade_plan_version:tp-588000-v3", "tone": "warning"}],
        "equityCurve": [{"date": f"07-{day:02d}", "value": value, "drawdown": 0} for day, value in [(1, 1328000), (3, 1342000), (5, 1331000), (8, 1364000), (10, 1349000), (12, 1322000), (15, 1311000), (17, 1318262), (18, 1286420)]],
        "evidence": list(evidence_store.values()),
        "review": {
            "mode": "mock", "summary": review_data["summary"],
            "mainRisks": [{"title": item["title"], "explanation": item["explanation"], "severity": item["severity"], "evidenceIds": item["evidence_ids"]} for item in review_data["main_risks"]],
            "planViolations": [{"title": item["title"], "detail": item["detail"], "evidenceIds": item["evidence_ids"]} for item in review_data["plan_violations"]],
            "operationReview": [{"category": item["category"], "observation": item["observation"], "evidenceIds": item["evidence_ids"]} for item in review_data["operation_review"]],
            "counterfactuals": review_data["counterfactuals"], "unknowns": review_data["unknowns"], "questionsForUser": review_data["questions_for_user"], "limitations": review_data["limitations"],
        },
    }


@app.get("/api/trade-plans")
async def get_trade_plans() -> dict[str, Any]:
    return envelope(trade_plans)


class TradePlanInput(BaseModel):
    instrument_id: str
    target_position_weight: Decimal
    max_position_weight: Decimal
    stop_condition: str
    thesis: str


@app.post("/api/trade-plans")
async def create_trade_plan(plan: TradePlanInput) -> dict[str, Any]:
    result = {"id": f"tp-{len(trade_plans) + 1}", **plan.model_dump(), "version": 1, "created_at": datetime.now().astimezone().isoformat()}
    trade_plans.append(result)
    return envelope(result)


@app.put("/api/trade-plans/{plan_id}")
async def update_trade_plan(plan_id: str, plan: TradePlanInput) -> dict[str, Any]:
    current = next((item for item in trade_plans if item["id"] == plan_id), None)
    if not current:
        raise HTTPException(404, "trade plan not found")
    versioned = {"id": plan_id, **plan.model_dump(), "version": int(current["version"]) + 1, "updated_at": datetime.now().astimezone().isoformat(), "previous_version": current}
    trade_plans.append(versioned)
    return envelope(versioned, ["previous plan version preserved"])


def build_evidence_pack(review_date: date) -> EvidencePack:
    metrics, events = evaluate_risk(demo_risk_input())
    return EvidencePack(review_date=review_date, portfolio_snapshot={"net_value": "1286420", "day_pnl": "-31842"}, positions=[item.model_dump(mode="json") for item in demo_risk_input().positions], recent_operations=[item.model_dump(mode="json") for item in transactions[-2:]], trade_plans=trade_plans, risk_metrics=metrics.model_dump(mode="json"), risk_events=[item.model_dump(mode="json") for item in events], market_context={"benchmark": "CSI300", "status": "mock"}, data_quality={"reliable": metrics.reliable, "warnings": metrics.warnings}, available_optional_tools=["stock_announcements", "stock_news", "industry_performance"])


@app.post("/api/reviews")
async def create_review(review_date: date = date(2026, 7, 18)) -> dict[str, Any]:
    pack = build_evidence_pack(review_date)
    output, mode = await run_review(pack, settings.openai_model, force_mock=settings.review_mode == "mock")
    return envelope({"id": f"review:{review_date.isoformat()}", "mode": mode, "evidence_pack": pack, "result": output})


@app.get("/api/reviews/{review_id}")
async def get_review(review_id: str) -> dict[str, Any]:
    review_date = date.fromisoformat(review_id.removeprefix("review:"))
    pack = build_evidence_pack(review_date)
    output, mode = await run_review(pack, settings.openai_model, force_mock=True)
    return envelope({"id": review_id, "mode": mode, "evidence_pack": pack, "result": output})


@app.get("/api/evidence/{evidence_type}/{evidence_id}")
async def evidence(evidence_type: str, evidence_id: str) -> dict[str, Any]:
    item = evidence_store.get(f"{evidence_type}:{evidence_id}")
    if not item:
        raise HTTPException(404, "evidence not found")
    return envelope(item)


@app.get("/api/optional/{tool}")
async def optional_tool(tool: str, key: str) -> dict[str, Any]:
    handlers = {"stock_announcements": stock_announcements, "stock_news": stock_news, "industry_performance": industry_performance}
    if tool not in handlers:
        raise HTTPException(404, "optional tool not registered")
    return await handlers[tool](key)


@app.exception_handler(LookupError)
async def provider_error(_: Any, exc: LookupError) -> JSONResponse:
    return JSONResponse(status_code=503, content={"data": None, "warnings": [], "freshness": "unknown", "errors": [str(exc)]})


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("risk_api.main:app", host="127.0.0.1", port=int(os.getenv("PORT", "8421")), reload=False)
