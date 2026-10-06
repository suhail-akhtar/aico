"""Rate limiting behind a port, with an in-process moving-window implementation.

The port (`RateLimiter`) is what the rest of the service depends on, so moving to
Redis for a multi-replica deployment is one new class and one line in the
composition root. The in-memory adapter counts per process: with N replicas the
real limit is N times the configured one, and a restart forgets everything. That
is acceptable as a brake on credential stuffing at small scale; for a hard limit
put it at the gateway (see docs/ARCHITECTURE.md).

Moving window rather than fixed window: a fixed window lets a client send twice
the limit across a boundary.
"""

import math
import time
from dataclasses import dataclass
from typing import Protocol

from limits import RateLimitItem, parse
from limits.aio.storage import MemoryStorage
from limits.aio.strategies import MovingWindowRateLimiter


@dataclass(frozen=True)
class RateLimitDecision:
    allowed: bool
    retry_after_seconds: int = 0


class RateLimiter(Protocol):
    async def check(self, rule: str, key: str) -> RateLimitDecision:
        """Count one hit of `key` against `rule` (e.g. "10/minute")."""
        ...


class MemoryRateLimiter:
    def __init__(self) -> None:
        self._strategy = MovingWindowRateLimiter(MemoryStorage())
        self._items: dict[str, RateLimitItem] = {}

    async def check(self, rule: str, key: str) -> RateLimitDecision:
        item = self._items.get(rule)
        if item is None:
            item = self._items[rule] = parse(rule)
        if await self._strategy.hit(item, rule, key):
            return RateLimitDecision(allowed=True)
        stats = await self._strategy.get_window_stats(item, rule, key)
        return RateLimitDecision(
            allowed=False, retry_after_seconds=max(1, math.ceil(stats.reset_time - time.time()))
        )
