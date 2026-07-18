from datetime import date
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator


class EvidencePack(BaseModel):
    review_date: date
    portfolio_snapshot: dict[str, Any]
    positions: list[dict[str, Any]]
    recent_operations: list[dict[str, Any]]
    trade_plans: list[dict[str, Any]]
    risk_metrics: dict[str, Any]
    risk_events: list[dict[str, Any]]
    market_context: dict[str, Any]
    data_quality: dict[str, Any]
    available_optional_tools: list[str] = Field(default_factory=list)


class CitedRisk(BaseModel):
    title: str
    explanation: str
    severity: Literal["low", "medium", "high", "critical"]
    evidence_ids: list[str] = Field(min_length=1)


class CitedItem(BaseModel):
    title: str
    detail: str
    evidence_ids: list[str] = Field(min_length=1)


class OperationReviewItem(BaseModel):
    category: Literal["方向错误", "仓位错误", "时机错误", "纪律错误", "无法判断"]
    observation: str
    evidence_ids: list[str] = Field(min_length=1)


class ReviewOutput(BaseModel):
    summary: str
    main_risks: list[CitedRisk]
    plan_violations: list[CitedItem]
    operation_review: list[OperationReviewItem]
    counterfactuals: list[str]
    unknowns: list[str]
    questions_for_user: list[str]
    limitations: list[str]

    @model_validator(mode="after")
    def block_trading_commands(self) -> "ReviewOutput":
        combined = " ".join([self.summary, *[item.explanation for item in self.main_risks]])
        forbidden = ("立即买入", "立即卖出", "必须买入", "必须卖出", "下单", "撤单")
        if any(phrase in combined for phrase in forbidden):
            raise ValueError("Review output contains a forbidden trading instruction")
        return self
