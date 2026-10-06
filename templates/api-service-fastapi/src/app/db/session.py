"""Engine and session factory.

One `AsyncEngine` per process, created in the composition root and disposed at
shutdown. PostgreSQL gets a bounded pool, `pool_pre_ping` (a connection the
server dropped is replaced instead of failing a request) and a server-side
`statement_timeout`, so a runaway query cannot hold a connection forever.
SQLite (development and tests) gets foreign keys switched on, which it ignores by
default and which every relationship here relies on.
"""

from pathlib import Path
from typing import Any

from sqlalchemy import event
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.config import Settings

STATEMENT_TIMEOUT_MS = 30_000


def create_engine(settings: Settings) -> AsyncEngine:
    url = make_url(settings.effective_database_url)
    kwargs: dict[str, Any] = {}
    if url.get_backend_name() == "sqlite":
        if url.database and url.database != ":memory:":
            Path(url.database).parent.mkdir(parents=True, exist_ok=True)
    else:
        kwargs = {
            "pool_size": settings.db_pool_size,
            "max_overflow": settings.db_max_overflow,
            "pool_pre_ping": True,
            "connect_args": {"options": f"-c statement_timeout={STATEMENT_TIMEOUT_MS}"},
        }
    engine = create_async_engine(url, **kwargs)
    if url.get_backend_name() == "sqlite":
        event.listen(engine.sync_engine, "connect", _enable_sqlite_foreign_keys)
    return engine


def _enable_sqlite_foreign_keys(dbapi_connection: Any, _record: object) -> None:
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


def create_session_factory(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    # expire_on_commit=False: attributes stay readable after commit, which an
    # async session cannot lazily reload.
    return async_sessionmaker(engine, expire_on_commit=False)
