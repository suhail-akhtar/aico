"""Dependencies for authentication: the service, and `CurrentUser` for protected routes.

`get_current_user` is the one seam between "who is calling" and the rest of the service.
Which token it accepts follows AUTH_MODE: this service's own access tokens (`local`) or
an identity provider's (`oidc`, provisioning the user row on first sight). Routes, the
ownership checks and the tests of every other feature do not know the difference.
"""

from typing import Annotated

from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.container import Container
from app.core.deps import ContainerDep, SessionDep
from app.core.errors import UnauthorizedError
from app.features.auth.provisioning import provision_user
from app.features.auth.repository import RefreshTokenRepository
from app.features.auth.service import AuthService
from app.features.users import User, UserRepository

# auto_error=False so a missing header is answered by us, as problem+json,
# instead of FastAPI's own response shape.
bearer_scheme = HTTPBearer(auto_error=False, description="Access token from `/auth/login`.")


def build_auth_service(session: AsyncSession, container: Container) -> AuthService:
    return AuthService(
        session=session,
        users=UserRepository(session),
        refresh_tokens=RefreshTokenRepository(session),
        passwords=container.passwords,
        tokens=container.require_tokens(),  # 404 in AUTH_MODE=oidc: there is nothing to issue
        clock=container.clock,
        settings=container.settings,
    )


def get_auth_service(session: SessionDep, container: ContainerDep) -> AuthService:
    return build_auth_service(session, container)


async def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
    container: ContainerDep,
    session: SessionDep,
) -> User:
    if credentials is None:
        raise UnauthorizedError("Authentication required.")
    users = UserRepository(session)
    user: User | None
    if container.oidc is not None:
        identity = await container.oidc.verify(credentials.credentials)
        user = await provision_user(session, users, container.clock, identity)
    else:
        claims = container.require_tokens().verify_access_token(credentials.credentials)
        # Loaded on every request, not trusted from the token, so disabling an
        # account takes effect at once rather than when its access token expires.
        user = await users.get(claims.user_id)
    if user is None or not user.is_active:
        raise UnauthorizedError("Invalid or expired access token.")
    return user


AuthServiceDep = Annotated[AuthService, Depends(get_auth_service)]
CurrentUser = Annotated[User, Depends(get_current_user)]
