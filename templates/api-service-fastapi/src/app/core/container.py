"""The infrastructure a request needs, built once in the composition root.

Deliberately plain: a frozen dataclass of already-constructed collaborators, not a
DI framework. FastAPI's `Depends` hands each handler what it asks for from here;
tests build a Container with a manual clock or a different rate limiter and pass
it to `create_app`, with no monkeypatching. Feature services are *not* in here:
they are cheap, per-request, and wired in each feature's `deps.py`.

Exactly one of `tokens` (this service signs and verifies its own tokens: AUTH_MODE=local)
and `oidc` (an identity provider's tokens are verified: AUTH_MODE=oidc) is set.
"""

from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.core.clock import Clock, SystemClock
from app.core.config import Settings
from app.core.errors import LocalAuthDisabledError
from app.core.oidc import JwksFetcher, OidcVerifier
from app.core.ratelimit import MemoryRateLimiter, RateLimiter
from app.core.security import PasswordService, TokenService
from app.db.session import create_engine, create_session_factory


@dataclass(frozen=True)
class Container:
    settings: Settings
    engine: AsyncEngine
    session_factory: async_sessionmaker[AsyncSession]
    clock: Clock
    passwords: PasswordService
    tokens: TokenService | None
    oidc: OidcVerifier | None
    rate_limiter: RateLimiter

    def require_tokens(self) -> TokenService:
        """The local token service, or the 404 every local-credential endpoint answers in
        AUTH_MODE=oidc (where there is no signing key and nothing to issue)."""
        if self.tokens is None:
            raise LocalAuthDisabledError
        return self.tokens


def build_container(
    settings: Settings,
    *,
    clock: Clock | None = None,
    rate_limiter: RateLimiter | None = None,
    jwks_fetcher: JwksFetcher | None = None,
) -> Container:
    clock = clock or SystemClock()
    engine = create_engine(settings)
    return Container(
        settings=settings,
        engine=engine,
        session_factory=create_session_factory(engine),
        clock=clock,
        passwords=PasswordService(settings),
        tokens=TokenService(settings, clock) if settings.auth_mode == "local" else None,
        oidc=OidcVerifier(settings, clock, jwks_fetcher) if settings.auth_mode == "oidc" else None,
        rate_limiter=rate_limiter or MemoryRateLimiter(),
    )
