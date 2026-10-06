"""Run Alembic migrations from application code.

The migration scripts live inside the package, so they ship in the image and the
same code path serves `python -m app.cli migrate`, the opt-in AUTO_MIGRATE at
startup (development) and the tests. The live connection is handed to Alembic
through `config.attributes`, which is the documented way to run it inside an
already-running event loop.

Production runs this as a separate one-shot step (the `migrate` service in
compose.yaml), never from every replica at boot: concurrent migrators race.
"""

from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import AsyncEngine

MIGRATIONS_DIR = Path(__file__).parent / "migrations"


def alembic_config() -> Config:
    config = Config()
    config.set_main_option("script_location", str(MIGRATIONS_DIR))
    return config


def _upgrade(connection: Connection, revision: str) -> None:
    config = alembic_config()
    config.attributes["connection"] = connection
    command.upgrade(config, revision)


def _downgrade(connection: Connection, revision: str) -> None:
    config = alembic_config()
    config.attributes["connection"] = connection
    command.downgrade(config, revision)


async def upgrade(engine: AsyncEngine, revision: str = "head") -> None:
    async with engine.begin() as connection:
        await connection.run_sync(_upgrade, revision)


async def downgrade(engine: AsyncEngine, revision: str = "base") -> None:
    async with engine.begin() as connection:
        await connection.run_sync(_downgrade, revision)
