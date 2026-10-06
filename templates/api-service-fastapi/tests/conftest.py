"""Fixtures: a fresh app + database per test, an HTTP client, and ready-made users."""

from collections.abc import AsyncIterator, Awaitable, Callable

import httpx
import pytest
from fastapi import FastAPI

from app.main import create_app
from tests.oidc_support import FakeJwks, mint, oidc_settings
from tests.support import ManualClock, bearer, login, make_settings, register, reset_database

MakeUser = Callable[[str], Awaitable[dict[str, str]]]


@pytest.fixture
def clock() -> ManualClock:
    return ManualClock()


@pytest.fixture
async def app(clock: ManualClock) -> AsyncIterator[FastAPI]:
    application = create_app(make_settings(), clock=clock)
    await reset_database(application.state.container.engine)
    async with application.router.lifespan_context(application):  # runs the migrations
        yield application


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as http:
        yield http


@pytest.fixture
def make_user(client: httpx.AsyncClient) -> MakeUser:
    """Register and log in a user; returns the Authorization header for them."""

    async def _make(email: str) -> dict[str, str]:
        response = await register(client, email)
        assert response.status_code == 201, response.text
        return bearer(await login(client, email))

    return _make


@pytest.fixture
async def auth(make_user: MakeUser) -> dict[str, str]:
    return await make_user("alice@example.com")


@pytest.fixture
def jwks() -> FakeJwks:
    """The identity provider's key endpoint, with one key (`key-1`). No network."""
    return FakeJwks()


@pytest.fixture
async def oidc_app(clock: ManualClock, jwks: FakeJwks) -> AsyncIterator[FastAPI]:
    application = create_app(oidc_settings(), clock=clock, jwks_fetcher=jwks)
    await reset_database(application.state.container.engine)
    async with application.router.lifespan_context(application):
        yield application


@pytest.fixture
async def oidc_client(oidc_app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    transport = httpx.ASGITransport(app=oidc_app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as http:
        yield http


@pytest.fixture
def oidc_auth(clock: ManualClock) -> dict[str, str]:
    """A bearer header for a brand-new subject the provider has just signed in."""
    return {"Authorization": f"Bearer {mint(clock)}"}
