"""The operational commands: migrate, seed, purge-tokens, openapi."""

from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI
from pydantic import SecretStr

from app.cli import main
from app.core.config import Settings
from app.core.container import Container
from app.features.auth import build_auth_service
from app.seed import DEMO_EMAIL, seed
from tests.support import JWT_SECRET, ManualClock, login, register


@pytest.fixture
def cli_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """An isolated environment for the CLI: its own SQLite file, no .env files read."""
    database = tmp_path / "cli.db"
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("JWT_SECRET", JWT_SECRET)
    monkeypatch.setenv("DATABASE_URL", f"sqlite+aiosqlite:///{database}")
    monkeypatch.setenv("SEED_PASSWORD", "demo-password-for-tests")
    monkeypatch.setenv("LOG_LEVEL", "ERROR")
    return database


def test_migrate_creates_the_schema_and_is_repeatable(
    cli_env: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    assert main(["migrate"]) == 0
    assert main(["migrate"]) == 0
    assert cli_env.exists()
    assert "database is at head" in capsys.readouterr().out


def test_seed_creates_the_demo_user_once(cli_env: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["migrate"]) == 0
    assert main(["seed"]) == 0
    assert main(["seed"]) == 0
    out = capsys.readouterr().out
    assert f"Created {DEMO_EMAIL} with 3 items" in out
    assert "already exists" in out
    assert "demo-password-for-tests" not in out


async def test_seed_refuses_production_and_a_missing_password() -> None:
    production = Settings(
        app_env="production",
        jwt_secret=SecretStr(JWT_SECRET),
        database_url="postgresql+psycopg://u:p@db/app",  # standards-allow: secret (fake URL)
        seed_password=SecretStr("whatever-password"),  # standards-allow: secret
        _env_file=None,
    )
    with pytest.raises(SystemExit, match="production"):
        await seed(production)
    no_password = Settings(app_env="test", jwt_secret=SecretStr(JWT_SECRET), _env_file=None)
    with pytest.raises(SystemExit, match="SEED_PASSWORD"):
        await seed(no_password)


def test_purge_tokens_runs(cli_env: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["migrate"]) == 0
    assert main(["purge-tokens"]) == 0
    assert "removed 0 expired refresh tokens" in capsys.readouterr().out


async def test_purge_deletes_only_expired_tokens(
    client: httpx.AsyncClient, app: FastAPI, clock: ManualClock
) -> None:
    await register(client, "alice@example.com")
    await login(client, "alice@example.com")
    container: Container = app.state.container
    async with container.session_factory() as session:
        assert await build_auth_service(session, container).purge_expired_tokens() == 0
    clock.advance(days=15)
    async with container.session_factory() as session:
        assert await build_auth_service(session, container).purge_expired_tokens() == 1


def test_openapi_check_fails_on_a_stale_file_and_passes_after_writing(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    target = tmp_path / "openapi.json"
    assert main(["openapi", "--check", "--out", str(target)]) == 1  # missing
    target.write_text("{}\n", encoding="utf-8")
    assert main(["openapi", "--check", "--out", str(target)]) == 1  # stale
    assert main(["openapi", "--out", str(target)]) == 0
    assert main(["openapi", "--check", "--out", str(target)]) == 0
    assert "up to date" in capsys.readouterr().out
