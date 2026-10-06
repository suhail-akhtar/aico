"""AUTH_MODE=oidc end to end: a provider's token in, an owned item out, nothing else changed.

The provider is a generated RSA key and a fake JWKS fetcher (see `tests/oidc_support.py`),
the database is the real one the rest of the suite uses (SQLite, or PostgreSQL through
TEST_DATABASE_URL), and requests go through the real ASGI app.
"""

import asyncio
from collections.abc import AsyncIterator
from pathlib import Path
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi import FastAPI
from pydantic import SecretStr
from sqlalchemy import select

from app.cli import main
from app.core.container import Container
from app.core.errors import IdentityConflictError
from app.core.oidc import OidcIdentity
from app.core.security import UNUSABLE_PASSWORD_HASH, PasswordService, TokenService
from app.features.auth.provisioning import provision_user
from app.features.users import User, UserRepository
from app.main import create_app
from app.seed import seed
from tests.oidc_support import FakeJwks, mint, oidc_settings, subject_of
from tests.support import (
    JWT_SECRET,
    PASSWORD,
    TEST_DATABASE_URL,
    ManualClock,
    problem,
    register,
    reset_database,
)

# Looks like an Argon2 hash and verifies nothing; these tests never log in with it.
PLACEHOLDER_HASH = "$argon2id$v=19$m=8,t=1,p=1$not$a-real-hash"  # standards-allow: secret


def bearer_for(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def users_in(app: FastAPI) -> list[User]:
    container: Container = app.state.container
    async with container.session_factory() as session:
        return list((await session.scalars(select(User).order_by(User.email))).all())


async def add_user(
    app: FastAPI,
    *,
    email: str,
    user_id: UUID | None = None,
    active: bool = True,
    password_hash: str | None = None,
) -> UUID:
    container: Container = app.state.container
    user_id = user_id or uuid4()
    async with container.session_factory() as session:
        session.add(
            User(
                id=user_id,
                email=email,
                password_hash=password_hash or PLACEHOLDER_HASH,
                is_active=active,
                created_at=container.clock.now(),
            )
        )
        await session.commit()
    return user_id


# ------------------------------------------------------------------ the happy path and JIT


async def test_the_first_valid_token_provisions_the_user_and_me_answers(
    oidc_client: httpx.AsyncClient, oidc_app: FastAPI, clock: ManualClock
) -> None:
    token = mint(clock, email="Alice@Example.com")
    response = await oidc_client.get("/v1/auth/me", headers=bearer_for(token))
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["id"] == str(subject_of(token))  # the user id IS the token subject
    assert body["email"] == "alice@example.com"
    rows = await users_in(oidc_app)
    assert len(rows) == 1
    assert rows[0].id == subject_of(token)
    assert rows[0].is_active is True
    assert rows[0].password_hash == UNUSABLE_PASSWORD_HASH
    assert rows[0].created_at == clock.now()


async def test_a_second_request_reuses_the_row(
    oidc_client: httpx.AsyncClient, oidc_app: FastAPI, clock: ManualClock
) -> None:
    headers = bearer_for(mint(clock, sub=str(uuid4())))
    for _ in range(3):
        assert (await oidc_client.get("/v1/auth/me", headers=headers)).status_code == 200
    assert len(await users_in(oidc_app)) == 1


async def test_without_an_email_claim_the_placeholder_address_is_stored(
    oidc_client: httpx.AsyncClient, clock: ManualClock
) -> None:
    token = mint(clock, email=None)
    me = (await oidc_client.get("/v1/auth/me", headers=bearer_for(token))).json()
    assert me["email"] == f"{subject_of(token)}@oidc.invalid"


async def test_items_work_for_the_provisioned_user_and_stay_private(
    oidc_client: httpx.AsyncClient, clock: ManualClock
) -> None:
    alice = bearer_for(mint(clock, email="alice@example.com"))
    bob = bearer_for(mint(clock, email="bob@example.com"))
    created = await oidc_client.post(
        "/v1/items", json={"name": "pen", "quantity": 3}, headers=alice
    )
    assert created.status_code == 201, created.text
    url = f"/v1/items/{created.json()['id']}"
    assert (await oidc_client.get(url, headers=alice)).status_code == 200
    assert (await oidc_client.get(url, headers=bob)).status_code == 404  # not found, not forbidden
    assert (await oidc_client.get("/v1/items", headers=bob)).json()["items"] == []
    assert (await oidc_client.delete(url, headers=bob)).status_code == 404
    assert (await oidc_client.delete(url, headers=alice)).status_code == 204


@pytest.fixture
async def racing_app(tmp_path: Path, clock: ManualClock, jwks: FakeJwks) -> AsyncIterator[FastAPI]:
    """Real connections for the concurrency test: in-memory SQLite shares one connection
    between sessions, which would hide the race. A file database (or PostgreSQL) does not."""
    url = TEST_DATABASE_URL or f"sqlite+aiosqlite:///{tmp_path / 'race.db'}"
    application = create_app(oidc_settings(database_url=url), clock=clock, jwks_fetcher=jwks)
    await reset_database(application.state.container.engine)
    async with application.router.lifespan_context(application):
        yield application


async def test_simultaneous_first_requests_create_exactly_one_row(
    racing_app: FastAPI, clock: ManualClock
) -> None:
    token = mint(clock)
    transport = httpx.ASGITransport(app=racing_app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        responses = await asyncio.gather(
            *(client.get("/v1/auth/me", headers=bearer_for(token)) for _ in range(8))
        )
    assert [r.status_code for r in responses] == [200] * 8, [r.text for r in responses]
    assert {r.json()["id"] for r in responses} == {str(subject_of(token))}
    assert len(await users_in(racing_app)) == 1


# ------------------------------------------------------------------ collisions and refusals


async def test_an_email_owned_by_another_account_is_a_409_and_nothing_is_merged(
    oidc_client: httpx.AsyncClient, oidc_app: FastAPI, clock: ManualClock
) -> None:
    owner = await add_user(oidc_app, email="alice@example.com")
    token = mint(clock, email="ALICE@example.com")
    response = await oidc_client.get("/v1/auth/me", headers=bearer_for(token))
    assert response.status_code == 409
    body = problem(response)
    assert body["code"] == "identity_conflict"
    assert body["type"] == "urn:problem:identity-conflict"
    assert "alice@example.com" not in response.text  # no address echoed back
    rows = await users_in(oidc_app)
    assert [r.id for r in rows] == [owner]  # no second row, and the owner's row is untouched


async def test_a_collision_found_only_at_insert_time_is_also_a_409(
    oidc_app: FastAPI, clock: ManualClock
) -> None:
    """The window between "no row has this email" and the insert: the unique index decides."""
    await add_user(oidc_app, email="alice@example.com")

    class StaleUsers(UserRepository):
        async def get_by_email(self, email: str) -> User | None:
            return None  # a read that raced the other insert

    container: Container = oidc_app.state.container
    async with container.session_factory() as session:
        with pytest.raises(IdentityConflictError):
            await provision_user(
                session,
                StaleUsers(session),
                clock,
                OidcIdentity(subject=uuid4(), email="alice@example.com"),
            )
    assert len(await users_in(oidc_app)) == 1


async def test_a_known_subject_keeps_working_when_its_email_has_since_changed(
    oidc_client: httpx.AsyncClient, oidc_app: FastAPI, clock: ManualClock
) -> None:
    sub = uuid4()
    await add_user(oidc_app, email="old@example.com", user_id=sub)
    headers = bearer_for(mint(clock, sub=str(sub), email="new@example.com"))
    me = await oidc_client.get("/v1/auth/me", headers=headers)
    assert me.status_code == 200
    assert me.json()["email"] == "old@example.com"  # captured at first sight, not re-synced


async def test_a_disabled_account_is_refused(
    oidc_client: httpx.AsyncClient, oidc_app: FastAPI, clock: ManualClock
) -> None:
    sub = uuid4()
    await add_user(oidc_app, email="gone@example.com", user_id=sub, active=False)
    headers = bearer_for(mint(clock, sub=str(sub), email="gone@example.com"))
    for path in ("/v1/auth/me", "/v1/items"):
        response = await oidc_client.get(path, headers=headers)
        assert response.status_code == 401
        assert problem(response)["code"] == "unauthorized"
    assert len(await users_in(oidc_app)) == 1  # and it was not re-created


async def test_a_missing_or_bad_token_is_a_401_problem_with_a_challenge(
    oidc_client: httpx.AsyncClient, clock: ManualClock
) -> None:
    for headers in ({}, bearer_for("nonsense"), bearer_for(mint(clock, aud="someone-else"))):
        response = await oidc_client.get("/v1/items", headers=headers)
        assert response.status_code == 401
        assert response.headers["www-authenticate"] == "Bearer"
        assert problem(response)["code"] == "unauthorized"


async def test_an_unreachable_provider_with_no_cached_keys_is_a_503_problem(
    oidc_client: httpx.AsyncClient, jwks: FakeJwks, clock: ManualClock
) -> None:
    jwks.fail = True
    response = await oidc_client.get("/v1/auth/me", headers=bearer_for(mint(clock)))
    assert response.status_code == 503
    assert problem(response)["code"] == "unavailable"


async def test_probes_need_no_token_and_never_call_the_provider(
    oidc_client: httpx.AsyncClient, jwks: FakeJwks
) -> None:
    assert (await oidc_client.get("/healthz")).status_code == 200
    ready = await oidc_client.get("/readyz")
    assert ready.status_code == 200
    assert ready.json()["database"] == "ok"
    assert jwks.calls == 0


async def test_a_token_this_service_would_have_issued_locally_is_not_an_oidc_token(
    oidc_client: httpx.AsyncClient, clock: ManualClock
) -> None:
    local = TokenService(oidc_settings(jwt_secret=SecretStr(JWT_SECRET)), clock)
    token = local.issue_access_token(uuid4())
    response = await oidc_client.get("/v1/auth/me", headers=bearer_for(token))
    assert response.status_code == 401


# ------------------------------------------------------------------ the local endpoints are gone


@pytest.mark.parametrize(
    ("path", "body"),
    [
        ("/v1/auth/register", {"email": "a@example.com", "password": PASSWORD}),
        ("/v1/auth/login", {"email": "a@example.com", "password": PASSWORD}),
        ("/v1/auth/refresh", {"refresh_token": "x"}),
        ("/v1/auth/logout", {"refresh_token": "x"}),
        ("/v1/auth/login", {"not": "even a valid body"}),
    ],
)
async def test_the_local_credential_endpoints_answer_404_in_oidc_mode(
    oidc_client: httpx.AsyncClient, oidc_app: FastAPI, path: str, body: dict[str, str]
) -> None:
    response = await oidc_client.post(path, json=body)
    assert response.status_code == 404
    document = problem(response)
    assert document["detail"] == "Local authentication is disabled: AUTH_MODE=oidc"
    assert document["code"] == "local_auth_disabled"
    assert await users_in(oidc_app) == []  # nothing was created


async def test_oidc_mode_has_no_signing_key_and_no_local_token_service(oidc_app: FastAPI) -> None:
    container: Container = oidc_app.state.container
    assert container.tokens is None
    assert container.oidc is not None


# ------------------------------------------------------------------ the local side is unchanged


async def test_the_provisioned_account_cannot_log_in_locally(
    client: httpx.AsyncClient, app: FastAPI
) -> None:
    """The sentinel hash verifies nothing, and the answer is the ordinary 401, not a 500."""
    await add_user(app, email="sso@example.com", password_hash=UNUSABLE_PASSWORD_HASH)
    await register(client, "someone@example.com")
    sso = await client.post(
        "/v1/auth/login", json={"email": "sso@example.com", "password": PASSWORD}
    )
    wrong = await client.post(
        "/v1/auth/login", json={"email": "someone@example.com", "password": "wrong-password-x"}
    )
    assert sso.status_code == wrong.status_code == 401
    assert problem(sso) == {**problem(wrong), "request_id": problem(sso)["request_id"]}


async def test_an_oidc_token_means_nothing_to_a_local_mode_service(
    client: httpx.AsyncClient, clock: ManualClock
) -> None:
    response = await client.get("/v1/auth/me", headers=bearer_for(mint(clock)))
    assert response.status_code == 401
    assert problem(response)["code"] == "unauthorized"


async def test_local_mode_still_registers_logs_in_and_refreshes(client: httpx.AsyncClient) -> None:
    assert (await register(client, "alice@example.com")).status_code == 201
    login = await client.post(
        "/v1/auth/login", json={"email": "alice@example.com", "password": PASSWORD}
    )
    assert login.status_code == 200
    refreshed = await client.post(
        "/v1/auth/refresh", json={"refresh_token": login.json()["refresh_token"]}
    )
    assert refreshed.status_code == 200


# ------------------------------------------------------------------ operations in oidc mode


async def test_the_sentinel_never_verifies_and_costs_a_real_verification_of_time() -> None:
    passwords = PasswordService(oidc_settings())
    assert await passwords.verify(PASSWORD, UNUSABLE_PASSWORD_HASH) == (False, None)
    assert await passwords.verify("", UNUSABLE_PASSWORD_HASH) == (False, None)


async def test_seed_creates_no_demo_user_in_oidc_mode() -> None:
    settings = oidc_settings(seed_password=SecretStr("demo-password-for-tests"))
    assert "nothing to seed" in await seed(settings)


def test_purge_tokens_is_a_no_op_in_oidc_mode(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], tmp_path: Path
) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("AUTH_MODE", "oidc")
    monkeypatch.setenv("OIDC_ISSUER", "http://localhost:8080/idp/realms/app")
    monkeypatch.setenv("OIDC_JWKS_URI", "http://keycloak:8080/certs")
    monkeypatch.setenv("OIDC_AUDIENCE", "app-api")
    monkeypatch.setenv("LOG_LEVEL", "ERROR")
    monkeypatch.delenv("JWT_SECRET", raising=False)
    assert main(["purge-tokens"]) == 0
    assert "removed 0 expired refresh tokens" in capsys.readouterr().out
