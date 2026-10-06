"""Liveness and readiness probes. No authentication, no rate limit, not under /v1.

`/healthz` says the process is up and never touches a dependency: an orchestrator
that restarts on a failing liveness probe must not restart every replica because
the database blinked. `/readyz` checks the database and tells a load balancer
whether to send this replica traffic.
"""

from fastapi import APIRouter
from pydantic import BaseModel
from sqlalchemy import text

from app.core.deps import ContainerDep
from app.core.errors import ServiceUnavailableError
from app.core.problems import problem_responses

router = APIRouter(tags=["health"])


class Health(BaseModel):
    status: str = "ok"


class Readiness(BaseModel):
    status: str = "ok"
    database: str = "ok"


@router.get("/healthz")
async def healthz() -> Health:
    return Health()


@router.get("/readyz", responses=problem_responses(503))
async def readyz(container: ContainerDep) -> Readiness:
    try:
        async with container.engine.connect() as connection:
            await connection.execute(text("SELECT 1"))
    except Exception as exc:  # any failure to answer means "not ready"
        raise ServiceUnavailableError("The database is not reachable.") from exc
    return Readiness()


__all__ = ["router"]
