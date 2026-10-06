"""Time as a dependency.

Anything that stamps or compares time (token expiry, created_at, rate-limit
Retry-After) takes a Clock, so a test can move time instead of sleeping. Always
timezone-aware UTC: a naive datetime is a bug that only shows up across DST or on
a server in another zone.
"""

from datetime import UTC, datetime
from typing import Protocol


class Clock(Protocol):
    def now(self) -> datetime: ...


class SystemClock:
    def now(self) -> datetime:
        return datetime.now(UTC)
