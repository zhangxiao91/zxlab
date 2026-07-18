from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class EvidenceReference(BaseModel):
    id: str
    type: str
    title: str
    timestamp: datetime
    source: str
    payload: dict[str, Any] = Field(default_factory=dict)


def evidence_id(kind: str, value: str) -> str:
    if not kind or not value or ":" in kind:
        raise ValueError("Evidence kind and value must form a stable kind:value identifier")
    return f"{kind}:{value}"
