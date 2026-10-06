"""Shared test helpers: settings, a movable clock, request shortcuts.

Tests run against in-memory SQLite by default (no Docker needed, ~seconds). Set
TEST_DATABASE_URL to a postgresql+psycopg:// URL to run the identical suite
against a real PostgreSQL (`make test-pg`, and the CI matrix does both).
"""

import os
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
from pydantic import SecretStr
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from app.core.config import Settings

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL", "")
USING_POSTGRES = TEST_DATABASE_URL.startswith("postgresql")
PASSWORD = "correct-horse-battery"  # standards-allow: secret (test fixture, not a credential)
JWT_SECRET = "test-only-secret-not-for-use-anywhere-0123456789"  # standards-allow: secret


class ManualClock:
    """A clock that only moves when the test moves it."""

    def __init__(self, start: datetime | None = None) -> None:
        self._now = start or datetime(2026, 1, 1, 12, 0, tzinfo=UTC)

    def now(self) -> datetime:
        return self._now

    def advance(self, **delta: float) -> None:
        self._now += timedelta(**delta)


def make_settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "app_env": "test",
        "jwt_secret": SecretStr(JWT_SECRET),
        "database_url": TEST_DATABASE_URL or "sqlite+aiosqlite://",
        "auto_migrate": True,
        "log_level": "ERROR",
        # Cheap Argon2 so the suite is fast; the production defaults are pinned in test_security.
        "argon2_time_cost": 1,
        "argon2_memory_cost_kib": 8,
        "argon2_parallelism": 1,
        "rate_limit_default": "100000/minute",
        "rate_limit_auth": "100000/minute",
        "_env_file": None,
    }
    values.update(overrides)
    return Settings(**values)


async def register(
    client: httpx.AsyncClient, email: str, password: str = PASSWORD
) -> httpx.Response:
    return await client.post("/v1/auth/register", json={"email": email, "password": password})


async def login(client: httpx.AsyncClient, email: str, password: str = PASSWORD) -> dict[str, Any]:
    response = await client.post("/v1/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200, response.text
    tokens: dict[str, Any] = response.json()
    return tokens


def bearer(tokens: dict[str, Any]) -> dict[str, str]:
    return {"Authorization": f"Bearer {tokens['access_token']}"}


async def reset_database(engine: AsyncEngine) -> None:
    """PostgreSQL persists between tests: wipe the schema so every test starts empty.
    (In-memory SQLite is a new database per engine, so it needs nothing.)"""
    if USING_POSTGRES:
        async with engine.begin() as connection:
            await connection.execute(text("DROP SCHEMA public CASCADE"))
            await connection.execute(text("CREATE SCHEMA public"))


def problem(response: httpx.Response) -> dict[str, Any]:
    assert response.headers["content-type"].startswith("application/problem+json"), response.text
    body: dict[str, Any] = response.json()
    return body
