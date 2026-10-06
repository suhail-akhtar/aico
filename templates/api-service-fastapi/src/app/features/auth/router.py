"""HTTP routes for authentication. Thin: parse, call the service, shape the response."""

from fastapi import APIRouter, Depends, Response, status

from app.core.deps import RateLimit
from app.core.problems import problem_responses
from app.features.auth.deps import AuthServiceDep, CurrentUser
from app.features.auth.schemas import LoginRequest, RefreshRequest, RegisterRequest, TokenPair
from app.features.users import UserRead

router = APIRouter(prefix="/auth", tags=["auth"])
# The strict per-address limit guards the endpoints an attacker can guess against.
_strict = [Depends(RateLimit("auth"))]


@router.post(
    "/register",
    status_code=status.HTTP_201_CREATED,
    dependencies=_strict,
    responses=problem_responses(403, 409, 422, 429),
)
async def register(body: RegisterRequest, service: AuthServiceDep) -> UserRead:
    return UserRead.model_validate(await service.register(body.email, body.password))


@router.post("/login", dependencies=_strict, responses=problem_responses(401, 422, 429))
async def login(body: LoginRequest, service: AuthServiceDep) -> TokenPair:
    return await service.login(body.email, body.password)


@router.post("/refresh", dependencies=_strict, responses=problem_responses(401, 422, 429))
async def refresh(body: RefreshRequest, service: AuthServiceDep) -> TokenPair:
    """Exchange a refresh token for a new pair. The old refresh token stops working."""
    return await service.refresh(body.refresh_token)


@router.post(
    "/logout",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=_strict,
    responses=problem_responses(422, 429),
)
async def logout(body: RefreshRequest, service: AuthServiceDep) -> Response:
    """Revoke the session this refresh token belongs to. Always 204."""
    await service.logout(body.refresh_token)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/me", responses=problem_responses(401))
async def me(user: CurrentUser) -> UserRead:
    return UserRead.model_validate(user)
