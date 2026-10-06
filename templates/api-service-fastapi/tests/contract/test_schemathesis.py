"""Schemathesis: generate requests from the OpenAPI document and check the responses.

Where the tests in `test_openapi.py` check the document, this checks the service
against it. Schemathesis builds valid and invalid requests for every operation
from the schemas (property-based, on top of Hypothesis), sends them to a running
server, and fails if the service returns a 5xx, an undocumented status, a body
that does not match the declared schema, a wrong content type, or accepts data it
should reject. The server runs in-process on a loopback port against a temporary
database; nothing leaves the machine. `derandomize` makes a run reproducible.
"""

import json
import threading
import time
from collections.abc import Iterator

import httpx
import pytest
import schemathesis
import uvicorn
from hypothesis import HealthCheck, settings
from schemathesis import Case
from schemathesis.checks import negative_data_rejection, positive_data_acceptance

from app.cli import render_openapi
from app.main import create_app
from tests.support import PASSWORD, TEST_DATABASE_URL, make_settings

schema = schemathesis.openapi.from_dict(json.loads(render_openapi()))


@pytest.fixture(scope="module")
def server(tmp_path_factory: pytest.TempPathFactory) -> Iterator[str]:
    database = (
        TEST_DATABASE_URL or f"sqlite+aiosqlite:///{tmp_path_factory.mktemp('db') / 'api.db'}"
    )
    app = create_app(make_settings(database_url=database))
    config = uvicorn.Config(app, host="127.0.0.1", port=0, log_level="error")
    instance = uvicorn.Server(config)
    thread = threading.Thread(target=instance.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 20
    while not instance.started:
        assert time.monotonic() < deadline, "the test server did not start"
        time.sleep(0.05)
    port = instance.servers[0].sockets[0].getsockname()[1]
    yield f"http://127.0.0.1:{port}"
    instance.should_exit = True
    thread.join(timeout=10)


@pytest.fixture(scope="module")
def headers(server: str) -> dict[str, str]:
    credentials = {"email": "schemathesis@example.com", "password": PASSWORD}
    with httpx.Client(base_url=server) as http:
        http.post("/v1/auth/register", json=credentials)
        token = http.post("/v1/auth/login", json=credentials).json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


@schema.parametrize()
@settings(
    max_examples=40,
    deadline=None,
    derandomize=True,
    suppress_health_check=[HealthCheck.function_scoped_fixture, HealthCheck.filter_too_much],
)
def test_the_service_conforms_to_its_openapi_document(
    case: Case, server: str, headers: dict[str, str]
) -> None:
    # Two checks are narrowed on purpose, every other one runs on every operation:
    # - `positive_data_acceptance`: OpenAPI's `format: email` is a hint, and the service
    #   validates addresses with email-validator, which (correctly) refuses reserved names
    #   such as `*.test` that the schema alone allows.
    # - `negative_data_rejection` on GET: Schemathesis builds an "invalid" query by turning
    #   a string into a one-element array, but a query string cannot tell the array from
    #   the scalar (both are `?q=x`), so the request is in fact valid and the check is noise
    #   that depends on the generated text. Strict query validation is asserted directly
    #   in tests/integration/test_items.py.
    excluded = [positive_data_acceptance]
    if case.method == "GET":
        excluded.append(negative_data_rejection)
    case.call_and_validate(base_url=server, headers=headers, excluded_checks=excluded)


def test_the_helper_server_is_the_app_under_test(server: str) -> None:
    assert httpx.get(f"{server}/healthz").json() == {"status": "ok"}
