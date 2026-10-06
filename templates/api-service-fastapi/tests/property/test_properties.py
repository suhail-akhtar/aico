"""Property-based tests (Hypothesis): the invariants that must hold for any input.

Example-based tests check the cases someone thought of. These generate thousands
more and shrink a failure to the smallest input that breaks it. Settings are
`derandomize=True`, so a CI run is the same run as a local one: a failure here is
reproducible, never a lucky draw.
"""

import asyncio
import json
from collections.abc import Iterator
from typing import Any
from uuid import UUID

import httpx
import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st
from pydantic import ValidationError

from app.core.errors import BadRequestError, UnauthorizedError
from app.core.pagination import decode_cursor, encode_cursor
from app.core.security import PasswordService, TokenService
from app.features.items.schemas import ItemInput
from app.main import create_app
from tests.support import PASSWORD, ManualClock, make_settings

FAST = settings(max_examples=200, deadline=None, derandomize=True)
SLOW = settings(max_examples=15, deadline=None, derandomize=True)


@FAST
@given(st.uuids())
def test_any_cursor_round_trips(value: UUID) -> None:
    assert decode_cursor(encode_cursor(value)) == value


@FAST
@given(st.text(max_size=64))
def test_decoding_arbitrary_text_gives_a_canonical_id_or_a_bad_request(text: str) -> None:
    try:
        value = decode_cursor(text)
    except BadRequestError:
        return
    assert encode_cursor(value) == text  # whatever it accepted is exactly what we would emit


# Python's str.strip() treats the ASCII separators U+001C..U+001F as whitespace and
# pydantic's Rust implementation does not (Hypothesis found this). The oracle below uses
# str.strip(), so those four characters are kept out of the alphabet rather than
# letting the test assert something about Python instead of about the service.
NAME_TEXT = st.text(alphabet=st.characters(exclude_characters=""), max_size=300)


@FAST
@given(NAME_TEXT)
def test_a_name_is_valid_exactly_when_its_trimmed_length_is_1_to_120(name: str) -> None:
    trimmed = name.strip()
    valid = 1 <= len(trimmed) <= 120 and "\x00" not in trimmed
    if valid:
        assert ItemInput(name=name).name == trimmed
    else:
        with pytest.raises(ValidationError):
            ItemInput(name=name)


@FAST
@given(st.integers(min_value=-(10**12), max_value=10**12))
def test_quantity_is_valid_exactly_when_within_bounds(quantity: int) -> None:
    if 0 <= quantity <= 1_000_000:
        assert ItemInput(name="x", quantity=quantity).quantity == quantity
    else:
        with pytest.raises(ValidationError):
            ItemInput(name="x", quantity=quantity)


@FAST
@given(st.text(max_size=5000))
def test_verifying_arbitrary_text_as_an_access_token_only_ever_raises_unauthorized(
    text: str,
) -> None:
    tokens = TokenService(make_settings(), ManualClock())
    try:
        tokens.verify_access_token(text)
    except UnauthorizedError:
        return
    pytest.fail("a random string was accepted as an access token")  # pragma: no cover


@SLOW
@given(st.text(min_size=1, max_size=128), st.text(min_size=1, max_size=128))
def test_a_password_verifies_against_its_own_hash_and_no_other(a: str, b: str) -> None:
    async def scenario() -> None:
        service = PasswordService(make_settings())
        hashed = await service.hash(a)
        assert (await service.verify(a, hashed))[0] is True
        assert (await service.verify(b, hashed))[0] is (a == b)

    asyncio.run(scenario())


# ------------------------------------------------------------------- the API

json_values = st.recursive(
    st.none()
    | st.booleans()
    | st.integers()
    | st.floats(allow_nan=False, allow_infinity=False)
    | st.text(max_size=40),
    lambda inner: (
        st.lists(inner, max_size=3) | st.dictionaries(st.text(max_size=8), inner, max_size=3)
    ),
    max_leaves=8,
)
item_bodies = st.fixed_dictionaries(
    {},
    optional={
        "name": json_values,
        "quantity": json_values,
        "description": json_values,
        "x": json_values,
    },
)


class Api:
    """A synchronous handle on one long-lived app, so Hypothesis can call it per example.

    Hypothesis drives plain (sync) test functions; the app is async. One event loop
    lives for the module and each call runs on it, so the app, its database and the
    logged-in user persist across thousands of examples instead of being rebuilt.
    """

    def __init__(self) -> None:
        self.runner = asyncio.Runner()
        self.app = create_app(make_settings())
        self.lifespan = self.app.router.lifespan_context(self.app)
        self.runner.run(self.lifespan.__aenter__())
        transport = httpx.ASGITransport(app=self.app, raise_app_exceptions=False)
        self.client = httpx.AsyncClient(transport=transport, base_url="http://test")
        creds = {"email": "fuzz@example.com", "password": PASSWORD}
        assert self.call("POST", "/v1/auth/register", json=creds).status_code == 201
        token = self.call("POST", "/v1/auth/login", json=creds).json()["access_token"]
        self.headers = {"Authorization": f"Bearer {token}"}

    def call(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        return self.runner.run(self.client.request(method, url, **kwargs))

    def close(self) -> None:
        self.runner.run(self.client.aclose())
        self.runner.run(self.lifespan.__aexit__(None, None, None))
        self.runner.close()


@pytest.fixture(scope="module")
def api() -> Iterator[Api]:
    handle = Api()
    yield handle
    handle.close()


@settings(
    max_examples=150,
    deadline=None,
    derandomize=True,
    suppress_health_check=[HealthCheck.function_scoped_fixture],
)
@given(body=item_bodies)
def test_no_json_body_can_make_item_creation_fail_with_a_server_error(
    api: Api, body: dict[str, Any]
) -> None:
    response = api.call(
        "POST",
        "/v1/items",
        content=json.dumps(body),
        headers={**api.headers, "content-type": "application/json"},
    )
    assert response.status_code in {201, 422}, (response.status_code, body)
    if response.status_code == 422:
        assert response.headers["content-type"].startswith("application/problem+json")


@settings(max_examples=100, deadline=None, derandomize=True)
@given(st.text(max_size=100))
def test_no_search_text_can_make_listing_fail(api: Api, q: str) -> None:
    response = api.call("GET", "/v1/items", params={"q": q}, headers=api.headers)
    assert response.status_code in {200, 422}
