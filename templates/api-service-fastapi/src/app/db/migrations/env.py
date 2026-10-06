"""Alembic environment.

Two ways in, one migration path:
- From code (`app.db.migrate`): a live connection arrives in
  `config.attributes["connection"]` and is used as is.
- From the `alembic` command line (`alembic.ini`, for `revision --autogenerate`):
  an async engine is built from the same Settings the service uses.

Every feature's models are imported here so `Base.metadata` is complete; a model
that is not imported is invisible to autogenerate and silently never migrated
(the `test_migrations` suite fails if models and migrations drift apart).
"""

import asyncio

from alembic import context
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import create_async_engine

from app.core.config import load_settings
from app.db.base import Base
from app.features.auth import models as _auth_models  # noqa: F401
from app.features.items import models as _items_models  # noqa: F401
from app.features.users import models as _users_models  # noqa: F401

config = context.config
target_metadata = Base.metadata


def _run(connection: Connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        compare_type=True,
        compare_server_default=True,
        render_as_batch=connection.dialect.name == "sqlite",
    )
    with context.begin_transaction():
        context.run_migrations()


async def _run_async() -> None:
    engine = create_async_engine(load_settings().effective_database_url)
    async with engine.connect() as connection:
        await connection.run_sync(_run)
        await connection.commit()
    await engine.dispose()


connection = config.attributes.get("connection")
if connection is not None:
    _run(connection)
else:
    asyncio.run(_run_async())
