"""Registration, login, refresh rotation and logout, through HTTP against a real database."""

import httpx
from fastapi import FastAPI
from sqlalchemy import select

from app.core.container import Container
from app.core.security import PasswordService
from app.features.users import User
from app.main import create_app
from tests.support import PASSWORD, ManualClock, bearer, login, make_settings, problem, register


async def test_register_returns_the_user_and_never_the_password(client: httpx.AsyncClient) -> None:
    response = await register(client, "Alice@Example.com")
    assert response.status_code == 201
    body = response.json()
    assert body["email"] == "alice@example.com"  # normalised
    assert set(body) == {"id", "email", "created_at"}
    assert PASSWORD not in response.text
    assert "hash" not in response.text


async def test_duplicate_email_is_a_409_even_with_different_case(client: httpx.AsyncClient) -> None:
    await register(client, "alice@example.com")
    response = await register(client, "ALICE@example.com")
    assert response.status_code == 409
    assert problem(response)["code"] == "conflict"


async def test_a_short_password_is_a_422_that_does_not_echo_the_input(
    client: httpx.AsyncClient,
) -> None:
    response = await register(client, "alice@example.com", "short-pw")
    assert response.status_code == 422
    body = problem(response)
    assert body["code"] == "validation_error"
    assert body["errors"][0]["loc"] == ["body", "password"]
    assert "short-pw" not in response.text
    assert "input" not in body["errors"][0]


async def test_unknown_fields_are_rejected_not_ignored(client: httpx.AsyncClient) -> None:
    response = await client.post(
        "/v1/auth/register",
        json={"email": "a@example.com", "password": PASSWORD, "is_admin": True},
    )
    assert response.status_code == 422


async def test_login_gives_a_token_pair_and_me_works(client: httpx.AsyncClient) -> None:
    await register(client, "alice@example.com")
    tokens = await login(client, "alice@example.com")
    assert tokens["token_type"] == "bearer"
    assert tokens["expires_in"] == 900
    me = await client.get("/v1/auth/me", headers=bearer(tokens))
    assert me.status_code == 200
    assert me.json()["email"] == "alice@example.com"


async def test_wrong_password_and_unknown_email_answer_identically(
    client: httpx.AsyncClient,
) -> None:
    await register(client, "alice@example.com")
    wrong = await client.post(
        "/v1/auth/login", json={"email": "alice@example.com", "password": "not-the-password"}
    )
    unknown = await client.post(
        "/v1/auth/login", json={"email": "nobody@example.com", "password": "not-the-password"}
    )
    assert wrong.status_code == unknown.status_code == 401
    wrong_body, unknown_body = problem(wrong), problem(unknown)
    for body in (wrong_body, unknown_body):
        body.pop("request_id")
    assert wrong_body == unknown_body
    assert wrong.headers["www-authenticate"] == "Bearer"


async def test_refresh_rotates_and_the_old_token_stops_working(client: httpx.AsyncClient) -> None:
    await register(client, "alice@example.com")
    first = await login(client, "alice@example.com")
    second = (
        await client.post("/v1/auth/refresh", json={"refresh_token": first["refresh_token"]})
    ).json()
    assert second["refresh_token"] != first["refresh_token"]
    assert (await client.get("/v1/auth/me", headers=bearer(second))).status_code == 200
    replay = await client.post("/v1/auth/refresh", json={"refresh_token": first["refresh_token"]})
    assert replay.status_code == 401


async def test_reusing_a_rotated_refresh_token_revokes_the_whole_family(
    client: httpx.AsyncClient,
) -> None:
    await register(client, "alice@example.com")
    first = await login(client, "alice@example.com")
    second = (
        await client.post("/v1/auth/refresh", json={"refresh_token": first["refresh_token"]})
    ).json()
    # The attacker replays the stolen first token...
    assert (
        await client.post("/v1/auth/refresh", json={"refresh_token": first["refresh_token"]})
    ).status_code == 401
    # ...and now the legitimate holder's newer token is dead too.
    legit = await client.post("/v1/auth/refresh", json={"refresh_token": second["refresh_token"]})
    assert legit.status_code == 401


async def test_a_second_login_is_an_independent_session(client: httpx.AsyncClient) -> None:
    await register(client, "alice@example.com")
    phone = await login(client, "alice@example.com")
    laptop = await login(client, "alice@example.com")
    await client.post("/v1/auth/logout", json={"refresh_token": phone["refresh_token"]})
    assert (
        await client.post("/v1/auth/refresh", json={"refresh_token": phone["refresh_token"]})
    ).status_code == 401
    assert (
        await client.post("/v1/auth/refresh", json={"refresh_token": laptop["refresh_token"]})
    ).status_code == 200


async def test_logout_is_idempotent_and_does_not_reveal_unknown_tokens(
    client: httpx.AsyncClient,
) -> None:
    response = await client.post("/v1/auth/logout", json={"refresh_token": "never-issued"})
    assert response.status_code == 204


async def test_refresh_token_expires(client: httpx.AsyncClient, clock: ManualClock) -> None:
    await register(client, "alice@example.com")
    tokens = await login(client, "alice@example.com")
    clock.advance(days=15)
    response = await client.post(
        "/v1/auth/refresh", json={"refresh_token": tokens["refresh_token"]}
    )
    assert response.status_code == 401


async def test_access_token_expires(client: httpx.AsyncClient, clock: ManualClock) -> None:
    await register(client, "alice@example.com")
    tokens = await login(client, "alice@example.com")
    clock.advance(seconds=899)
    assert (await client.get("/v1/auth/me", headers=bearer(tokens))).status_code == 200
    clock.advance(seconds=2)
    expired = await client.get("/v1/auth/me", headers=bearer(tokens))
    assert expired.status_code == 401
    assert expired.headers["www-authenticate"] == "Bearer"


async def test_a_disabled_account_cannot_log_in_or_use_an_existing_token(
    client: httpx.AsyncClient, app: FastAPI
) -> None:
    await register(client, "alice@example.com")
    tokens = await login(client, "alice@example.com")
    container: Container = app.state.container
    async with container.session_factory() as session:
        user = await session.scalar(select(User).where(User.email == "alice@example.com"))
        assert user is not None
        user.is_active = False
        await session.commit()
    assert (await client.get("/v1/auth/me", headers=bearer(tokens))).status_code == 401
    attempt = await client.post(
        "/v1/auth/login", json={"email": "alice@example.com", "password": PASSWORD}
    )
    assert attempt.status_code == 401
    refresh = await client.post("/v1/auth/refresh", json={"refresh_token": tokens["refresh_token"]})
    assert refresh.status_code == 401


async def test_login_upgrades_a_hash_made_with_weaker_parameters(
    client: httpx.AsyncClient, app: FastAPI
) -> None:
    container: Container = app.state.container
    stronger = PasswordService(make_settings(argon2_memory_cost_kib=16, argon2_time_cost=2))
    await register(client, "alice@example.com")
    # Swap in a service that wants stronger parameters than the stored hash has.
    app.state.container = Container(**{**container.__dict__, "passwords": stronger})
    async with container.session_factory() as session:
        before = await session.scalar(select(User.password_hash))
    await login(client, "alice@example.com")
    async with container.session_factory() as session:
        after = await session.scalar(select(User.password_hash))
    assert before != after
    assert after is not None
    assert "m=16,t=2" in after


async def test_registration_can_be_disabled(clock: ManualClock) -> None:
    app = create_app(make_settings(registration_enabled=False), clock=clock)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as http:
            response = await register(http, "alice@example.com")
    assert response.status_code == 403
    assert problem(response)["code"] == "forbidden"
