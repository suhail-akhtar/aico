"""The wire contract one generated client depends on, proven in BOTH authentication modes.

A single-page app behind a gateway is generated against this shape and must work
unchanged whether the API runs standalone (`AUTH_MODE=local`) or behind an identity
provider (`AUTH_MODE=oidc`): `/auth/me`, items CRUD with `limit` and `cursor` paging,
snake_case property names everywhere, optional `quantity` and `description`, and
problem+json errors. `openapi.json` states the same thing; this file checks what the
running service actually does.
"""

import re
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

import httpx
import pytest

from app.main import create_app
from tests.oidc_support import FakeJwks, mint, oidc_settings
from tests.support import ManualClock, bearer, login, make_settings, register, reset_database

SNAKE_CASE = re.compile(r"^[a-z][a-z0-9]*(_[a-z0-9]+)*$")
ITEM_FIELDS = {"id", "name", "description", "quantity", "created_at", "updated_at"}


@dataclass
class Api:
    client: httpx.AsyncClient
    headers: dict[str, str]


@pytest.fixture(params=["local", "oidc"])
async def api(request: pytest.FixtureRequest, clock: ManualClock) -> AsyncIterator[Api]:
    if request.param == "local":
        app = create_app(make_settings(), clock=clock)
    else:
        app = create_app(oidc_settings(), clock=clock, jwks_fetcher=FakeJwks())
    await reset_database(app.state.container.engine)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            if request.param == "local":
                assert (await register(client, "alice@example.com")).status_code == 201
                headers = bearer(await login(client, "alice@example.com"))
            else:
                headers = {"Authorization": f"Bearer {mint(clock, email='alice@example.com')}"}
            yield Api(client, headers)


def assert_snake_case(value: Any, where: str = "$") -> None:
    if isinstance(value, dict):
        for key, inner in value.items():
            assert SNAKE_CASE.match(key), f"{where}.{key} is not snake_case"
            assert_snake_case(inner, f"{where}.{key}")
    elif isinstance(value, list):
        for index, inner in enumerate(value):
            assert_snake_case(inner, f"{where}[{index}]")


def assert_item(item: dict[str, Any]) -> None:
    assert set(item) >= ITEM_FIELDS, item
    UUID(item["id"])
    assert isinstance(item["name"], str)
    assert item["description"] is None or isinstance(item["description"], str)
    assert isinstance(item["quantity"], int)
    for field in ("created_at", "updated_at"):
        assert datetime.fromisoformat(item[field]).tzinfo is not None
    assert_snake_case(item)


def assert_problem(response: httpx.Response, status: int | tuple[int, ...]) -> dict[str, Any]:
    statuses = (status,) if isinstance(status, int) else status
    assert response.status_code in statuses, response.text
    assert response.headers["content-type"].startswith("application/problem+json")
    body: dict[str, Any] = response.json()
    assert {"type", "title", "status"} <= set(body)
    assert body["status"] == response.status_code
    return body


async def test_auth_me_is_an_id_and_an_email(api: Api) -> None:
    response = await api.client.get("/v1/auth/me", headers=api.headers)
    assert response.status_code == 200
    body = response.json()
    assert {"id", "email"} <= set(body)
    UUID(body["id"])
    assert body["email"] == "alice@example.com"
    assert_snake_case(body)


async def test_auth_me_without_a_token_is_a_401_problem(api: Api) -> None:
    assert_problem(await api.client.get("/v1/auth/me"), 401)


async def test_create_answers_201_with_the_item_and_a_location(api: Api) -> None:
    response = await api.client.post(
        "/v1/items", json={"name": "pen", "description": "blue", "quantity": 3}, headers=api.headers
    )
    assert response.status_code == 201
    item = response.json()
    assert_item(item)
    assert (item["name"], item["description"], item["quantity"]) == ("pen", "blue", 3)
    assert response.headers["location"].endswith(f"/items/{item['id']}")


async def test_quantity_and_description_are_optional_on_create_and_on_replace(api: Api) -> None:
    created = await api.client.post("/v1/items", json={"name": "pen"}, headers=api.headers)
    assert created.status_code == 201
    assert (created.json()["quantity"], created.json()["description"]) == (0, None)
    url = f"/v1/items/{created.json()['id']}"
    full = {"name": "pen", "description": "d", "quantity": 5}
    assert (await api.client.put(url, json=full, headers=api.headers)).json()["quantity"] == 5
    replaced = await api.client.put(url, json={"name": "marker"}, headers=api.headers)
    assert replaced.status_code == 200
    assert_item(replaced.json())
    # PUT is a full replace: what the body leaves out goes back to its default.
    assert (replaced.json()["name"], replaced.json()["description"]) == ("marker", None)
    assert replaced.json()["quantity"] == 0
    nulled = await api.client.put(
        url, json={"name": "marker", "description": None}, headers=api.headers
    )
    assert nulled.json()["description"] is None


@pytest.mark.parametrize(
    ("body", "ok"),
    [
        ({"name": "n" * 120}, True),
        ({"name": "n" * 121}, False),
        ({"name": ""}, False),
        ({"name": "x", "description": "d" * 1000}, True),
        ({"name": "x", "quantity": 0}, True),
        ({"name": "x", "quantity": 1_000_000}, True),
        ({"name": "x", "quantity": 1_000_001}, False),
        ({"name": "x", "quantity": -1}, False),
    ],
)
async def test_the_documented_limits_hold(api: Api, body: dict[str, Any], ok: bool) -> None:
    response = await api.client.post("/v1/items", json=body, headers=api.headers)
    if ok:
        assert response.status_code == 201
    else:
        assert_problem(response, (400, 422))


async def test_get_replace_delete_and_the_404s(api: Api) -> None:
    created = (await api.client.post("/v1/items", json={"name": "pen"}, headers=api.headers)).json()
    url = f"/v1/items/{created['id']}"
    assert_item((await api.client.get(url, headers=api.headers)).json())
    deleted = await api.client.delete(url, headers=api.headers)
    assert deleted.status_code == 204
    assert deleted.content == b""
    missing = "/v1/items/00000000-0000-4000-8000-000000000000"
    assert_problem(await api.client.get(url, headers=api.headers), 404)
    assert_problem(await api.client.get(missing, headers=api.headers), 404)
    assert_problem(await api.client.put(missing, json={"name": "x"}, headers=api.headers), 404)
    assert_problem(await api.client.delete(missing, headers=api.headers), 404)


async def test_a_validation_failure_is_problem_json_with_snake_case_keys(api: Api) -> None:
    body = assert_problem(
        await api.client.post("/v1/items", json={"name": " "}, headers=api.headers), (400, 422)
    )
    assert_snake_case(body)


async def test_cursor_paging_walks_every_item_newest_first(api: Api) -> None:
    ids = []
    for n in range(5):
        response = await api.client.post(
            "/v1/items", json={"name": f"item {n}"}, headers=api.headers
        )
        ids.append(response.json()["id"])
    seen: list[str] = []
    sizes: list[int] = []
    cursor: str | None = None
    for _ in range(10):  # a guard against a cursor that never ends
        params: dict[str, Any] = {"limit": 2}
        if cursor:
            params["cursor"] = cursor
        page = (await api.client.get("/v1/items", params=params, headers=api.headers)).json()
        assert {"items", "next_cursor"} <= set(page)
        assert_snake_case(page)
        for item in page["items"]:
            assert_item(item)
        sizes.append(len(page["items"]))
        seen += [item["id"] for item in page["items"]]
        cursor = page.get("next_cursor")
        if cursor is None:
            break
    assert sizes == [2, 2, 1]
    assert seen == list(reversed(ids))  # newest first, none twice, none missing


async def test_the_page_size_is_bounded_and_an_empty_list_is_a_page(api: Api) -> None:
    empty = await api.client.get("/v1/items", headers=api.headers)
    assert empty.json()["items"] == []
    assert empty.json().get("next_cursor") is None
    assert (await api.client.get("/v1/items?limit=100", headers=api.headers)).status_code == 200
    for bad in ("0", "101", "-1", "many"):
        assert_problem(
            await api.client.get(f"/v1/items?limit={bad}", headers=api.headers), (400, 422)
        )
    assert_problem(await api.client.get("/v1/items?cursor=!!", headers=api.headers), (400, 422))


async def test_the_probes_answer_without_a_token(api: Api) -> None:
    assert (await api.client.get("/healthz")).status_code == 200
    assert (await api.client.get("/readyz")).status_code == 200
