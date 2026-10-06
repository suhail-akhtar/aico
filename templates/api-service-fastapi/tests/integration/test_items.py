"""The items resource end to end: create, list with cursors, get, replace, delete."""

from typing import Any

import httpx

from tests.support import problem


async def _create(client: httpx.AsyncClient, auth: dict[str, str], **fields: Any) -> dict[str, Any]:
    response = await client.post("/v1/items", json={"name": "pen", **fields}, headers=auth)
    assert response.status_code == 201, response.text
    created: dict[str, Any] = response.json()
    return created


async def test_create_returns_201_with_a_location_and_defaults(
    client: httpx.AsyncClient, auth: dict[str, str]
) -> None:
    response = await client.post("/v1/items", json={"name": "  pen  "}, headers=auth)
    assert response.status_code == 201
    item = response.json()
    assert item["name"] == "pen"  # trimmed
    assert item["quantity"] == 0
    assert item["description"] is None
    assert response.headers["location"] == f"/v1/items/{item['id']}"
    assert "owner_id" not in item


async def test_get_replace_and_delete(client: httpx.AsyncClient, auth: dict[str, str]) -> None:
    item = await _create(client, auth, quantity=2)
    url = f"/v1/items/{item['id']}"
    assert (await client.get(url, headers=auth)).json()["quantity"] == 2
    replaced = await client.put(
        url, json={"name": "marker", "description": "red", "quantity": 9}, headers=auth
    )
    assert replaced.status_code == 200
    assert replaced.json()["name"] == "marker"
    assert replaced.json()["description"] == "red"
    assert (await client.delete(url, headers=auth)).status_code == 204
    gone = await client.get(url, headers=auth)
    assert gone.status_code == 404
    assert problem(gone)["code"] == "not_found"


async def test_replace_moves_updated_at_but_not_created_at(
    client: httpx.AsyncClient, auth: dict[str, str], clock: Any
) -> None:
    item = await _create(client, auth)
    clock.advance(minutes=5)
    replaced = (
        await client.put(
            f"/v1/items/{item['id']}", json={"name": "pen", "quantity": 1}, headers=auth
        )
    ).json()
    assert replaced["created_at"] == item["created_at"]
    assert replaced["updated_at"] > item["created_at"]


async def test_validation_errors_name_the_field(
    client: httpx.AsyncClient, auth: dict[str, str]
) -> None:
    response = await client.post("/v1/items", json={"name": "   ", "quantity": -1}, headers=auth)
    assert response.status_code == 422
    fields = {tuple(e["loc"]) for e in problem(response)["errors"]}
    assert fields == {("body", "name"), ("body", "quantity")}


async def test_a_malformed_id_is_a_422_not_a_500(
    client: httpx.AsyncClient, auth: dict[str, str]
) -> None:
    assert (await client.get("/v1/items/not-a-uuid", headers=auth)).status_code == 422


async def test_listing_pages_through_everything_newest_first(
    client: httpx.AsyncClient, auth: dict[str, str]
) -> None:
    created = [(await _create(client, auth, name=f"item-{n}"))["id"] for n in range(5)]
    seen: list[str] = []
    cursor: str | None = None
    pages = 0
    while True:
        params: dict[str, Any] = {"limit": 2}
        if cursor:
            params["cursor"] = cursor
        page = (await client.get("/v1/items", params=params, headers=auth)).json()
        seen += [item["id"] for item in page["items"]]
        pages += 1
        cursor = page["next_cursor"]
        if cursor is None:
            break
    assert pages == 3
    assert seen == list(reversed(created))


async def test_listing_an_empty_collection(client: httpx.AsyncClient, auth: dict[str, str]) -> None:
    page = (await client.get("/v1/items", headers=auth)).json()
    assert page == {"items": [], "next_cursor": None}


async def test_limit_is_capped_and_a_bad_cursor_is_a_400(
    client: httpx.AsyncClient, auth: dict[str, str]
) -> None:
    assert (await client.get("/v1/items?limit=101", headers=auth)).status_code == 422
    assert (await client.get("/v1/items?limit=0", headers=auth)).status_code == 422
    bad = await client.get("/v1/items?cursor=not-a-cursor", headers=auth)
    assert bad.status_code == 400
    assert problem(bad)["code"] == "bad_request"


async def test_search_matches_by_substring_and_treats_wildcards_literally(
    client: httpx.AsyncClient, auth: dict[str, str]
) -> None:
    await _create(client, auth, name="Blue Pen")
    await _create(client, auth, name="Red Pencil")
    await _create(client, auth, name="Notebook 100% recycled")

    async def names(q: str) -> list[str]:
        page = (await client.get("/v1/items", params={"q": q}, headers=auth)).json()
        return sorted(item["name"] for item in page["items"])

    assert await names("pen") == ["Blue Pen", "Red Pencil"]
    assert await names("%") == ["Notebook 100% recycled"]  # a literal percent sign, not "match all"
    assert await names("_") == []


async def test_unknown_query_parameters_and_wrongly_typed_values_are_rejected(
    client: httpx.AsyncClient, auth: dict[str, str]
) -> None:
    typo = await client.get("/v1/items?limt=5", headers=auth)
    assert typo.status_code == 422
    assert problem(typo)["errors"][0]["loc"] == ["query", "limt"]
    for body in ({"name": "x", "quantity": "5"}, {"name": "x", "quantity": False}, {"name": 5}):
        assert (await client.post("/v1/items", json=body, headers=auth)).status_code == 422
