"""FastAPI dependencies for the shared kernel: container, session, clock, rate limit."""

from collections.abc import AsyncIterator
from typing import Annotated, Literal

from fastapi import Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import Clock
from app.core.container import Container
from app.core.errors import RateLimitedError


def get_container(request: Request) -> Container:
    container: Container = request.app.state.container
    return container


ContainerDep = Annotated[Container, Depends(get_container)]


async def get_session(container: ContainerDep) -> AsyncIterator[AsyncSession]:
    """One session per request. It never commits on its own: a service calls
    `commit()` when a use case succeeds, and closing the session rolls back
    anything else. That keeps the transaction boundary visible in the code."""
    async with container.session_factory() as session:
        yield session


def get_clock(container: ContainerDep) -> Clock:
    return container.clock


SessionDep = Annotated[AsyncSession, Depends(get_session)]
ClockDep = Annotated[Clock, Depends(get_clock)]


class RateLimit:
    """`Depends(RateLimit("auth"))`: count this request against the caller's address.

    The address is `request.client`, which uvicorn rewrites from X-Forwarded-For
    only for proxies listed in FORWARDED_ALLOW_IPS, so a client cannot choose it.
    """

    def __init__(self, kind: Literal["default", "auth"]) -> None:
        self.kind = kind

    async def __call__(self, request: Request, container: ContainerDep) -> None:
        settings = container.settings
        if not settings.rate_limit_enabled:
            return
        rule = settings.rate_limit_auth if self.kind == "auth" else settings.rate_limit_default
        client = request.client.host if request.client else "unknown"
        decision = await container.rate_limiter.check(rule, f"{self.kind}:{client}")
        if not decision.allowed:
            raise RateLimitedError(
                "Too many requests. Slow down and retry later.",
                headers={"Retry-After": str(decision.retry_after_seconds)},
            )
