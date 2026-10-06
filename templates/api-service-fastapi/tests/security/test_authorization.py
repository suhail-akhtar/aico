"""Authentication and object-level authorisation (OWASP API1 and API2).

The bug these exist for is the most common serious one in APIs: user A reading or
changing user B's data by guessing an id. The answer must be "not found" (never
403, which would confirm the id exists), for every verb, and for list and search.
"""

from typing import Any

import httpx
import jwt
import pytest

from app.core.security import ACCESS_TOKEN_TYPE
from tests.conftest import MakeUser
from tests.support import JWT_SECRET, problem


async def _item(client: httpx.AsyncClient, headers: dict[str, str], name: str) -> dict[str, Any]:
    created: dict[str, Any] = (
        await client.post("/v1/items", json={"name": name}, headers=headers)
    ).json()
    return created


async def test_another_users_item_is_404_for_every_verb(
    client: httpx.AsyncClient, make_user: MakeUser
) -> None:
    alice = await make_user("alice@example.com")
    mallory = await make_user("mallory@example.com")
    item = await _item(client, alice, "alice's secret")
    url = f"/v1/items/{item['id']}"

    assert (await client.get(url, headers=mallory)).status_code == 404
    assert (await client.put(url, json={"name": "pwned"}, headers=mallory)).status_code == 404
    assert (await client.delete(url, headers=mallory)).status_code == 404
    # ...and nothing changed:
    still = (await client.get(url, headers=alice)).json()
    assert still["name"] == "alice's secret"


async def test_the_404_for_someone_elses_item_is_indistinguishable_from_a_missing_one(
    client: httpx.AsyncClient, make_user: MakeUser
) -> None:
    alice = await make_user("alice@example.com")
    mallory = await make_user("mallory@example.com")
    item = await _item(client, alice, "x")
    theirs = problem(await client.get(f"/v1/items/{item['id']}", headers=mallory))
    missing = problem(
        await client.get("/v1/items/00000000-0000-7000-8000-000000000000", headers=mallory)
    )
    for body in (theirs, missing):
        body.pop("request_id")
        body.pop("instance")
    assert theirs == missing


async def test_lists_and_searches_never_include_other_users_items(
    client: httpx.AsyncClient, make_user: MakeUser
) -> None:
    alice = await make_user("alice@example.com")
    mallory = await make_user("mallory@example.com")
    await _item(client, alice, "shared-word alice")
    await _item(client, mallory, "shared-word mallory")
    for params in ({}, {"q": "shared-word"}, {"limit": 100}):
        page = (await client.get("/v1/items", params=params, headers=mallory)).json()
        assert [i["name"] for i in page["items"]] == ["shared-word mallory"]


async def test_a_cursor_from_another_user_cannot_reveal_their_rows(
    client: httpx.AsyncClient, make_user: MakeUser
) -> None:
    alice = await make_user("alice@example.com")
    mallory = await make_user("mallory@example.com")
    for n in range(3):
        await _item(client, alice, f"a{n}")
    page = (await client.get("/v1/items?limit=1", headers=alice)).json()
    stolen_cursor = page["next_cursor"]
    leaked = (
        await client.get("/v1/items", params={"cursor": stolen_cursor}, headers=mallory)
    ).json()
    assert leaked["items"] == []


async def test_the_owner_cannot_be_chosen_by_the_client(
    client: httpx.AsyncClient, make_user: MakeUser
) -> None:
    alice = await make_user("alice@example.com")
    mallory = await make_user("mallory@example.com")
    me = (await client.get("/v1/auth/me", headers=alice)).json()
    response = await client.post(
        "/v1/items", json={"name": "x", "owner_id": me["id"]}, headers=mallory
    )
    assert response.status_code == 422  # unknown field, not silently applied


PROTECTED = [
    ("GET", "/v1/items"),
    ("POST", "/v1/items"),
    ("GET", "/v1/items/00000000-0000-7000-8000-000000000000"),
    ("PUT", "/v1/items/00000000-0000-7000-8000-000000000000"),
    ("DELETE", "/v1/items/00000000-0000-7000-8000-000000000000"),
    ("GET", "/v1/auth/me"),
]


@pytest.mark.parametrize(("method", "path"), PROTECTED)
async def test_every_protected_route_needs_a_token(
    client: httpx.AsyncClient, method: str, path: str
) -> None:
    response = await client.request(method, path, json={"name": "x"})
    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"
    assert problem(response)["code"] == "unauthorized"


@pytest.mark.parametrize(
    "header",
    [
        "Bearer",
        "Bearer ",
        "Bearer not.a.jwt",
        "Basic dXNlcjpwYXNz",
        "bearer",
        "Token abc",
        "Bearer " + "a" * 9000,
    ],
)
async def test_malformed_credentials_are_a_401(client: httpx.AsyncClient, header: str) -> None:
    response = await client.get("/v1/auth/me", headers={"Authorization": header})
    assert response.status_code == 401


async def test_a_token_signed_with_the_wrong_key_is_a_401(client: httpx.AsyncClient) -> None:
    forged = jwt.encode(
        {"sub": "00000000-0000-7000-8000-000000000000", "exp": 4_000_000_000},
        "an-attacker-chosen-key-0123456789abcdef",
        algorithm="HS256",
        headers={"typ": ACCESS_TOKEN_TYPE},
    )
    response = await client.get("/v1/auth/me", headers={"Authorization": f"Bearer {forged}"})
    assert response.status_code == 401


async def test_alg_none_is_a_401(client: httpx.AsyncClient) -> None:
    unsigned = jwt.encode(
        {"sub": "00000000-0000-7000-8000-000000000000", "exp": 4_000_000_000},
        None,
        algorithm="none",
        headers={"typ": ACCESS_TOKEN_TYPE},
    )
    response = await client.get("/v1/auth/me", headers={"Authorization": f"Bearer {unsigned}"})
    assert response.status_code == 401


async def test_a_validly_signed_token_for_a_user_that_does_not_exist_is_a_401(
    client: httpx.AsyncClient, clock: Any
) -> None:
    now = int(clock.now().timestamp())
    token = jwt.encode(
        {
            "iss": "api-service",
            "aud": "api-service-clients",
            "sub": "00000000-0000-7000-8000-000000000000",
            "iat": now,
            "exp": now + 600,
            "jti": "x",
        },
        JWT_SECRET,
        algorithm="HS256",
        headers={"typ": ACCESS_TOKEN_TYPE},
    )
    response = await client.get("/v1/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 401


async def test_a_refresh_token_is_not_accepted_as_an_access_token(
    client: httpx.AsyncClient, make_user: MakeUser
) -> None:
    await make_user("alice@example.com")
    login = (
        await client.post(
            "/v1/auth/login",
            json={"email": "alice@example.com", "password": "correct-horse-battery"},
        )
    ).json()
    response = await client.get(
        "/v1/auth/me", headers={"Authorization": f"Bearer {login['refresh_token']}"}
    )
    assert response.status_code == 401
