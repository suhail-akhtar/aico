"""The composition root: the one place that knows every part and wires them together.

`create_app` builds the container (engine, clock, hashing, tokens or the OIDC verifier, limiter),
installs the middleware and error handling, and mounts each feature's router.
Everything else asks for what it needs through FastAPI's `Depends`; nothing else
constructs infrastructure. Tests call `create_app` with their own settings, clock
or rate limiter; uvicorn calls it as a factory:

    uvicorn app.main:create_app --factory

Growing the service means adding a `include_router` line here, not editing code
elsewhere.
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from importlib.metadata import PackageNotFoundError, version

import structlog
from fastapi import Depends, FastAPI
from starlette.middleware.cors import CORSMiddleware
from starlette.types import Scope

from app.core.clock import Clock
from app.core.config import Settings, load_settings
from app.core.container import build_container
from app.core.deps import RateLimit
from app.core.logging import configure_logging
from app.core.middleware import (
    BodySizeLimitMiddleware,
    RequestContextMiddleware,
    SecurityHeadersMiddleware,
)
from app.core.oidc import JwksFetcher
from app.core.problems import PROBLEM_MEDIA_TYPE, install_problem_handling
from app.core.ratelimit import RateLimiter
from app.db import migrate
from app.features import auth, health, items

API_PREFIX = "/v1"
DOCS_PATHS = ("/docs", "/redoc", "/docs/oauth2-redirect")
PROBE_PATHS = frozenset({"/healthz", "/readyz"})

log = structlog.get_logger(__name__)


def _service_version() -> str:
    try:
        return version("api-service")
    except PackageNotFoundError:  # pragma: no cover - running from a bare checkout
        return "0.0.0"


def _exclude_probes_from_telemetry(scope: Scope) -> bool:
    return scope.get("path") in PROBE_PATHS


def create_app(
    settings: Settings | None = None,
    *,
    clock: Clock | None = None,
    rate_limiter: RateLimiter | None = None,
    jwks_fetcher: JwksFetcher | None = None,
) -> FastAPI:
    settings = settings or load_settings()
    configure_logging(settings.log_level, settings.log_format)
    container = build_container(
        settings, clock=clock, rate_limiter=rate_limiter, jwks_fetcher=jwks_fetcher
    )

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        if settings.auto_migrate:
            await migrate.upgrade(container.engine)
        log.info(
            "app.started",
            env=settings.app_env,
            auth_mode=settings.auth_mode,
            version=_service_version(),
        )
        try:
            yield
        finally:
            # Uvicorn stops accepting on SIGTERM, drains in-flight requests, then
            # runs this: connections are returned before the process exits.
            await container.engine.dispose()
            log.info("app.stopped")

    app = FastAPI(
        title=settings.service_name,
        version=_service_version(),
        lifespan=lifespan,
        docs_url="/docs" if settings.docs_enabled else None,
        redoc_url="/redoc" if settings.docs_enabled else None,
        # Any status not listed on a route is still a problem document.
        responses={
            "default": {
                "description": "Problem details (RFC 9457)",
                "content": {
                    PROBLEM_MEDIA_TYPE: {"schema": {"$ref": "#/components/schemas/ProblemDetails"}}
                },
            }
        },
        # FastAPI's native OpenTelemetry: spans and metrics go out only when
        # OTEL_EXPORTER_OTLP_ENDPOINT is set. Probes would drown the traces.
        telemetry={"exclude": _exclude_probes_from_telemetry},
    )
    app.state.container = container
    install_problem_handling(app)

    # add_middleware wraps: the last one added is the outermost.
    app.add_middleware(BodySizeLimitMiddleware, max_bytes=settings.max_body_bytes)
    if settings.allowed_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.allowed_origins,
            allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
            allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
            expose_headers=["X-Request-ID", "Retry-After", "Location"],
            allow_credentials=False,  # bearer tokens travel in a header, not a cookie
            max_age=600,
        )
    app.add_middleware(SecurityHeadersMiddleware, relaxed_paths=DOCS_PATHS)
    app.add_middleware(RequestContextMiddleware)

    app.include_router(health.router)
    default_limit = [Depends(RateLimit("default"))]
    app.include_router(auth.router, prefix=API_PREFIX, dependencies=default_limit)
    app.include_router(items.router, prefix=API_PREFIX, dependencies=default_limit)
    return app
