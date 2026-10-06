"""The migrations and the models must describe the same schema.

Autogenerate would produce an empty migration if they agree. This catches the
two classic drifts: a model changed without a migration, and a migration edited
after it shipped.
"""

from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import inspect
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import create_async_engine

from app.db import migrate
from app.db.base import Base
from app.features.auth import models as _auth  # noqa: F401
from app.features.items import models as _items  # noqa: F401
from app.features.users import models as _users  # noqa: F401
from tests.support import TEST_DATABASE_URL, make_settings, reset_database

APP_TABLES = {"users", "refresh_tokens", "items"}


def _diff(connection: Connection) -> list[object]:
    context = MigrationContext.configure(connection, opts={"compare_type": True})
    return compare_metadata(context, Base.metadata)


def _tables(connection: Connection) -> set[str]:
    return set(inspect(connection).get_table_names())


async def test_models_and_migrations_agree_and_downgrade_is_clean() -> None:
    engine = create_async_engine(make_settings().effective_database_url)
    await reset_database(engine)
    try:
        await migrate.upgrade(engine)
        async with engine.connect() as connection:
            assert await connection.run_sync(_tables) >= APP_TABLES
            assert await connection.run_sync(_diff) == []
        await migrate.downgrade(engine)
        async with engine.connect() as connection:
            assert not APP_TABLES & await connection.run_sync(_tables)
    finally:
        await engine.dispose()


async def test_upgrade_is_idempotent() -> None:
    engine = create_async_engine(make_settings().effective_database_url)
    await reset_database(engine)
    try:
        await migrate.upgrade(engine)
        await migrate.upgrade(engine)  # already at head: a no-op, not an error
    finally:
        await engine.dispose()


def test_which_database_this_run_used() -> None:
    # Documents itself in the output: SQLite by default, PostgreSQL under `make test-pg`.
    assert make_settings().effective_database_url == (TEST_DATABASE_URL or "sqlite+aiosqlite://")
