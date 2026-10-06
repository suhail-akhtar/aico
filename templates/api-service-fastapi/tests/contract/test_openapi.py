"""The OpenAPI document is the contract: committed, complete, and true.

- `openapi.json` is committed and must equal what the app generates, so an API
  change is always a visible diff in review (and the place `oasdiff` points at
  in CI to catch a breaking one). Regenerate with `make openapi`.
- The documented surface is exactly the intended one (adding a route is deliberate).
- Every error status is documented as problem+json, and every protected
  operation declares its security requirement.
"""

import json
from pathlib import Path
from typing import Any

import pytest

from app.cli import OPENAPI_FILE, render_openapi

ROOT = Path(__file__).resolve().parents[2]
HTTP_METHODS = {"get", "post", "put", "delete", "patch"}


@pytest.fixture(scope="module")
def document() -> dict[str, Any]:
    parsed: dict[str, Any] = json.loads(render_openapi())
    return parsed


def _operations(document: dict[str, Any]) -> list[tuple[str, str, dict[str, Any]]]:
    return [
        (method, path, operation)
        for path, item in document["paths"].items()
        for method, operation in item.items()
        if method in HTTP_METHODS
    ]


def test_the_committed_document_is_current() -> None:
    committed = (ROOT / OPENAPI_FILE).read_text(encoding="utf-8")
    assert committed == render_openapi(), "openapi.json is stale: run `make openapi` and commit it"


def test_it_is_openapi_3_1_with_the_service_title(document: dict[str, Any]) -> None:
    assert document["openapi"].startswith("3.1")
    assert document["info"]["title"] == "api-service"


def test_the_documented_surface_is_exactly_the_intended_one(document: dict[str, Any]) -> None:
    """A new route must be added here on purpose: the list is the API's public surface."""
    documented = {(method, path) for method, path, _ in _operations(document)}
    assert documented == {
        ("get", "/healthz"),
        ("get", "/readyz"),
        ("post", "/v1/auth/register"),
        ("post", "/v1/auth/login"),
        ("post", "/v1/auth/refresh"),
        ("post", "/v1/auth/logout"),
        ("get", "/v1/auth/me"),
        ("post", "/v1/items"),
        ("get", "/v1/items"),
        ("get", "/v1/items/{item_id}"),
        ("put", "/v1/items/{item_id}"),
        ("delete", "/v1/items/{item_id}"),
    }


def test_operation_ids_are_unique_and_every_operation_is_tagged(document: dict[str, Any]) -> None:
    ids = [op["operationId"] for _, _, op in _operations(document)]
    assert len(ids) == len(set(ids))
    assert all(op.get("tags") for _, _, op in _operations(document))


def test_every_error_response_is_documented_as_problem_json(document: dict[str, Any]) -> None:
    for method, path, operation in _operations(document):
        for status, response in operation["responses"].items():
            if status.startswith(("4", "5")) or status == "default":
                assert list(response["content"]) == ["application/problem+json"], (
                    method,
                    path,
                    status,
                )


def test_protected_operations_declare_security_and_public_ones_do_not(
    document: dict[str, Any],
) -> None:
    public = {
        "/healthz",
        "/readyz",
        "/v1/auth/register",
        "/v1/auth/login",
        "/v1/auth/refresh",
        "/v1/auth/logout",
    }
    for method, path, operation in _operations(document):
        if path in public:
            assert "security" not in operation, (method, path)
        else:
            assert operation.get("security"), (method, path)
            assert "401" in operation["responses"], (method, path)


def test_every_reference_resolves(document: dict[str, Any]) -> None:
    schemas = document["components"]["schemas"]

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            ref = node.get("$ref")
            if isinstance(ref, str) and ref.startswith("#/components/schemas/"):
                assert ref.rsplit("/", 1)[1] in schemas, ref
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(document)


def test_the_request_schemas_forbid_extra_fields(document: dict[str, Any]) -> None:
    for name in ("RegisterRequest", "LoginRequest", "RefreshRequest", "ItemInput"):
        assert document["components"]["schemas"][name].get("additionalProperties") is False, name


def test_no_schema_exposes_a_secret_field(document: dict[str, Any]) -> None:
    text = json.dumps(document["components"]["schemas"]).lower()
    for forbidden in ("password_hash", "token_hash", "owner_id"):
        assert forbidden not in text
