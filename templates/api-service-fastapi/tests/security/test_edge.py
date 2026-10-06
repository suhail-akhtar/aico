"""The HTTP edge: headers, CORS, size limits, rate limits, error hygiene, injection."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import func, select, text

from app.core.container import Container
from app.core.headers import SECURITY_HEADERS
from app.features.items import Item
from app.main import create_app
from tests.conftest import MakeUser
from tests.support import ManualClock, make_settings, problem


@asynccontextmanager
async def running(**settings: object) -> AsyncIterator[httpx.AsyncClient]:
    """A client for a separate app built with these settings (the shared `client` has defaults)."""
    app = create_app(make_settings(**settings))
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as http:
            yield http


# ----------------------------------------------------------------- headers


async def test_security_headers_are_on_success_and_on_errors(client: httpx.AsyncClient) -> None:
    for response in (await client.get("/healthz"), await client.get("/nope")):
        for name, value in SECURITY_HEADERS.items():
            assert response.headers[name] == value, name
    assert "server" not in {k.lower() for k in (await client.get("/healthz")).headers}


async def test_hsts_is_sent_only_over_https(client: httpx.AsyncClient) -> None:
    assert "strict-transport-security" not in (await client.get("/healthz")).headers
    secure = await client.get("https://test/healthz")
    assert secure.headers["strict-transport-security"].startswith("max-age=")


async def test_the_docs_page_is_exempt_from_the_json_only_csp(client: httpx.AsyncClient) -> None:
    docs = await client.get("/docs")
    assert docs.status_code == 200
    assert "content-security-policy" not in docs.headers
    assert docs.headers["x-content-type-options"] == "nosniff"


# ----------------------------------------------------------------- request id


async def test_every_response_has_a_request_id_and_a_safe_inbound_one_is_kept(
    client: httpx.AsyncClient,
) -> None:
    generated = await client.get("/healthz")
    assert len(generated.headers["x-request-id"]) == 32
    kept = await client.get("/healthz", headers={"X-Request-ID": "trace-abc-12345"})
    assert kept.headers["x-request-id"] == "trace-abc-12345"
    hostile = await client.get("/healthz", headers={"X-Request-ID": "x\r\nSet-Cookie: a=b"})
    assert hostile.headers["x-request-id"] != "x"
    assert "set-cookie" not in hostile.headers


async def test_error_bodies_carry_the_request_id(client: httpx.AsyncClient) -> None:
    response = await client.get("/nope", headers={"X-Request-ID": "report-me-0001"})
    assert problem(response)["request_id"] == "report-me-0001"


# ----------------------------------------------------------------- errors


async def test_unknown_routes_and_methods_are_problem_documents(client: httpx.AsyncClient) -> None:
    missing = await client.get("/nope")
    assert missing.status_code == 404
    assert problem(missing)["code"] == "not_found"
    wrong_method = await client.delete("/healthz")
    assert wrong_method.status_code == 405
    assert problem(wrong_method)["code"] == "method_not_allowed"


async def test_an_unhandled_exception_is_a_generic_500_with_no_internals(
    app,
    client: httpx.AsyncClient,
) -> None:
    @app.get("/boom")
    async def boom() -> None:
        raise RuntimeError("secret-internal-detail /srv/app/path")

    response = await client.get("/boom")
    assert response.status_code == 500
    body = problem(response)
    assert body["code"] == "internal_error"
    assert "secret-internal-detail" not in response.text
    assert "Traceback" not in response.text
    assert response.headers["x-request-id"] == body["request_id"]
    assert response.headers["x-content-type-options"] == "nosniff"


# ----------------------------------------------------------------- size limits


async def test_a_declared_oversized_body_is_a_413(
    client: httpx.AsyncClient, auth: dict[str, str]
) -> None:
    big = {"name": "x", "description": "d" * 1_100_000}
    response = await client.post("/v1/items", json=big, headers=auth)
    assert response.status_code == 413
    assert problem(response)["code"] == "payload_too_large"


async def test_a_streamed_body_over_the_limit_is_a_413_even_without_a_content_length(
    client: httpx.AsyncClient, auth: dict[str, str]
) -> None:
    async def chunks() -> AsyncIterator[bytes]:
        for _ in range(12):  # 1.2 MB, sent chunked: no Content-Length to check up front
            yield b"a" * 100_000

    response = await client.post(
        "/v1/items", content=chunks(), headers={**auth, "content-type": "application/json"}
    )
    assert response.status_code == 413


async def test_a_body_just_under_the_limit_is_still_validated_normally(
    client: httpx.AsyncClient, auth: dict[str, str]
) -> None:
    response = await client.post(
        "/v1/items", json={"name": "x", "description": "d" * 3000}, headers=auth
    )
    assert response.status_code == 422  # description is capped at 2000 by the schema


async def test_the_limit_is_configurable() -> None:
    async with running(max_body_bytes=1024) as http:
        response = await http.post(
            "/v1/auth/login", json={"email": "a@b.co", "password": "p" * 2000}
        )
        assert response.status_code == 413


# ----------------------------------------------------------------- content


async def test_malformed_json_is_a_4xx_not_a_500(
    client: httpx.AsyncClient, auth: dict[str, str]
) -> None:
    for content in (b"{not json", b"", b"null", b"[]", b'"string"', b"\xff\xfe"):
        response = await client.post(
            "/v1/items", content=content, headers={**auth, "content-type": "application/json"}
        )
        assert 400 <= response.status_code < 500, content
    wrong_type = await client.post(
        "/v1/items", content=b'{"name":"x"}', headers={**auth, "content-type": "text/plain"}
    )
    assert 400 <= wrong_type.status_code < 500


# ----------------------------------------------------------------- injection


INJECTIONS = [
    "'; DROP TABLE items; --",
    "' OR '1'='1",
    "Robert'); DELETE FROM users;--",
    "<script>alert(1)</script>",
    "${jndi:ldap://x}",
    "../../etc/passwd",
    "\x00null-byte",
]


@pytest.mark.parametrize("payload", INJECTIONS)
async def test_hostile_strings_are_stored_and_returned_verbatim_and_harm_nothing(
    client: httpx.AsyncClient,
    auth: dict[str, str],
    app: FastAPI,
    payload: str,
) -> None:
    created = await client.post("/v1/items", json={"name": payload}, headers=auth)
    if created.status_code == 201:
        assert created.json()["name"] == payload.strip()
    else:
        assert created.status_code == 422  # e.g. a NUL byte some databases cannot store
    found = await client.get("/v1/items", params={"q": payload}, headers=auth)
    assert found.status_code in {200, 422}  # 422 for a NUL byte, which PostgreSQL cannot compare
    container: Container = app.state.container
    async with container.session_factory() as session:
        assert await session.scalar(text("SELECT count(*) FROM users")) == 1  # nothing deleted
        assert await session.scalar(select(func.count()).select_from(Item)) in (0, 1)


# ----------------------------------------------------------------- rate limiting


async def test_login_is_rate_limited_per_address_with_retry_after() -> None:
    async with running(rate_limit_auth="3/minute") as http:
        statuses = [
            (
                await http.post(
                    "/v1/auth/login", json={"email": "x@example.com", "password": "wrong-password"}
                )
            ).status_code
            for _ in range(5)
        ]
        assert statuses == [401, 401, 401, 429, 429]
        limited = await http.post(
            "/v1/auth/login", json={"email": "x@example.com", "password": "wrong-password"}
        )
        assert int(limited.headers["retry-after"]) >= 1
        assert problem(limited)["code"] == "rate_limited"
        assert (await http.get("/healthz")).status_code == 200  # probes are never limited


async def test_the_general_limit_applies_to_the_whole_api() -> None:
    async with running(rate_limit_default="2/minute") as http:
        codes = [(await http.get("/v1/auth/me")).status_code for _ in range(3)]
        assert codes == [401, 401, 429]


async def test_rate_limiting_can_be_switched_off() -> None:
    async with running(rate_limit_auth="1/minute", rate_limit_enabled=False) as http:
        codes = {
            (
                await http.post("/v1/auth/login", json={"email": "x@example.com", "password": "pw"})
            ).status_code
            for _ in range(4)
        }
        assert codes == {401}


# ----------------------------------------------------------------- CORS


async def test_cors_is_an_allow_list() -> None:
    async with running(allowed_origins="https://app.example") as http:
        good = await http.get("/healthz", headers={"Origin": "https://app.example"})
        assert good.headers["access-control-allow-origin"] == "https://app.example"
        assert "access-control-allow-credentials" not in good.headers
        evil = await http.get("/healthz", headers={"Origin": "https://evil.example"})
        assert "access-control-allow-origin" not in evil.headers
        preflight = await http.options(
            "/v1/items",
            headers={
                "Origin": "https://app.example",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "authorization,content-type",
            },
        )
        assert preflight.status_code == 200
        assert "POST" in preflight.headers["access-control-allow-methods"]


async def test_without_configured_origins_no_cors_headers_are_sent(
    client: httpx.AsyncClient,
) -> None:
    response = await client.get("/healthz", headers={"Origin": "https://anywhere.example"})
    assert "access-control-allow-origin" not in response.headers


# ----------------------------------------------------------------- secrets


async def test_no_response_ever_contains_a_password_hash(
    client: httpx.AsyncClient, make_user: MakeUser
) -> None:
    headers = await make_user("alice@example.com")
    for response in (
        await client.get("/v1/auth/me", headers=headers),
        await client.get("/openapi.json"),
    ):
        assert "argon2" not in response.text
        assert "password_hash" not in response.text


def test_the_clock_fixture_is_manual() -> None:
    assert ManualClock().now().tzinfo is not None
