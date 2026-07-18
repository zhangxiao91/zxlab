from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="RISK_", env_file=".env.local", extra="ignore")

    database_url: str = "postgresql+psycopg://zxlab:local-risk-only@127.0.0.1:54329/zxlab_risk"
    provider_mode: str = "mock"
    review_mode: str = "mock"
    openai_model: str = "gpt-5-mini"
    quote_stale_seconds: int = 120


@lru_cache
def get_settings() -> Settings:
    return Settings()
