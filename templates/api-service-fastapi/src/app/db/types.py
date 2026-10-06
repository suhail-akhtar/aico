"""Column types.

`UTCDateTime` makes timezone-awareness a property of the column rather than of
every caller. PostgreSQL stores `timestamptz` and returns aware values; SQLite
has no timezone support and returns naive ones, which would make the same code
behave differently in tests and production. This type refuses naive values on the
way in and always returns aware UTC on the way out.
"""

from datetime import UTC, datetime

from sqlalchemy import DateTime, Dialect
from sqlalchemy.types import TypeDecorator


class UTCDateTime(TypeDecorator[datetime]):
    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect: Dialect) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            msg = "naive datetime refused: use an aware UTC datetime (see app.core.clock)"
            raise ValueError(msg)
        return value.astimezone(UTC)

    def process_result_value(self, value: datetime | None, dialect: Dialect) -> datetime | None:
        if value is None:
            return None
        return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)
